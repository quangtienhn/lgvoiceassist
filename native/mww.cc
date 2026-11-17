// LG TV Assist wake word detector: microWakeWord models on TensorFlow Lite Micro.
//
//   mww [--probs] [--refractory SECONDS] MODEL.tflite CUTOFF WINDOW [MODEL.tflite CUTOFF WINDOW ...]
//
// Reads 16 kHz, 16-bit little-endian mono PCM on stdin for as long as it lasts and writes one line per
// detection to stdout:   wake <model index> <mean probability>
// CUTOFF and WINDOW are probability_cutoff and sliding_window_size from the model's JSON manifest.
// With --probs every inference is also written:   p <model index> <raw output 0..255>   (for tests).
//
// The processing follows the reference implementation, pymicro-wakeword (Apache-2.0,
// https://github.com/OHF-Voice/pymicro-wakeword): features from TensorFlow's "microfrontend" (30 ms window,
// 10 ms step, 40 mel channels, noise reduction, PCAN, log scale), quantised with the model's input scale,
// fed to the streaming model `stride` frames at a time; a wake word is reported when the mean of the last
// WINDOW probabilities is above CUTOFF.
#include <unistd.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

extern "C" {
#include "tensorflow/lite/experimental/microfrontend/lib/frontend.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend_util.h"
}

#include "tensorflow/lite/micro/micro_allocator.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_resource_variable.h"
#include "tensorflow/lite/micro/system_setup.h"
#include "tensorflow/lite/micro/schema/schema_generated.h"

namespace {

const int kSampleRate = 16000;
const int kSamplesPerChunk = 160;        // 10 ms
const int kFeatures = 40;
const float kFeatureScale = 0.0390625f;  // frontend output -> float, as in pymicro-features
const int kMaxModels = 8;
const int kMaxStride = 16;
const int kMaxWindow = 64;
const size_t kArenaSize = 512 * 1024;    // the models ask for well under 100 kB
const int kResourceVariables = 32;       // the streaming state of a model (6 in today's models)

typedef tflite::MicroMutableOpResolver<13> Resolver;

struct Detector {
  const char* path;
  double cutoff;
  int window;
  uint8_t* model_data;
  tflite::MicroInterpreter* interpreter;
  int stride;
  double in_scale, out_scale;
  int in_zero, out_zero;
  bool in_signed;
  int8_t stage[kMaxStride * kFeatures];  // quantised feature frames waiting for the next inference
  int staged;
  double probs[kMaxWindow];              // ring of the last `window` probabilities
  int prob_count, prob_pos;
  long quiet_until;                      // feature frame number until which detections are suppressed
};

Detector detectors[kMaxModels];
int num_detectors = 0;

bool register_ops(Resolver* r) {
  return r->AddCallOnce() == kTfLiteOk && r->AddVarHandle() == kTfLiteOk && r->AddReadVariable() == kTfLiteOk &&
         r->AddAssignVariable() == kTfLiteOk && r->AddReshape() == kTfLiteOk && r->AddConcatenation() == kTfLiteOk &&
         r->AddStridedSlice() == kTfLiteOk && r->AddSplitV() == kTfLiteOk && r->AddConv2D() == kTfLiteOk &&
         r->AddDepthwiseConv2D() == kTfLiteOk && r->AddFullyConnected() == kTfLiteOk && r->AddLogistic() == kTfLiteOk &&
         r->AddQuantize() == kTfLiteOk;
}

uint8_t* read_file(const char* path, size_t* size) {
  FILE* f = fopen(path, "rb");
  if (!f) return nullptr;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  // flatbuffers are read in place: keep the buffer 16-byte aligned
  void* buf = nullptr;
  if (n <= 0 || posix_memalign(&buf, 16, static_cast<size_t>(n)) != 0) { fclose(f); return nullptr; }
  if (fread(buf, 1, static_cast<size_t>(n), f) != static_cast<size_t>(n)) { fclose(f); free(buf); return nullptr; }
  fclose(f);
  *size = static_cast<size_t>(n);
  return static_cast<uint8_t*>(buf);
}

bool load(Detector* d, const Resolver& resolver) {
  size_t size = 0;
  d->model_data = read_file(d->path, &size);
  if (!d->model_data) { fprintf(stderr, "mww: cannot read %s\n", d->path); return false; }
  if (size < 16 || memcmp(d->model_data + 4, "TFL3", 4) != 0) { fprintf(stderr, "mww: %s is not a TensorFlow Lite model\n", d->path); return false; }
  const tflite::Model* model = tflite::GetModel(d->model_data);
  if (model->version() != TFLITE_SCHEMA_VERSION) {
    fprintf(stderr, "mww: %s: schema version %d, expected %d\n", d->path, static_cast<int>(model->version()), TFLITE_SCHEMA_VERSION);
    return false;
  }
  void* arena = nullptr;
  if (posix_memalign(&arena, 16, kArenaSize) != 0) return false;
  tflite::MicroAllocator* allocator = tflite::MicroAllocator::Create(static_cast<uint8_t*>(arena), kArenaSize);
  if (!allocator) { fprintf(stderr, "mww: %s: no allocator\n", d->path); return false; }
  tflite::MicroResourceVariables* variables = tflite::MicroResourceVariables::Create(allocator, kResourceVariables);
  if (!variables) { fprintf(stderr, "mww: %s: no resource variables\n", d->path); return false; }
  // never destroyed: the detector lives as long as the process
  void* mem = nullptr;
  if (posix_memalign(&mem, alignof(tflite::MicroInterpreter), sizeof(tflite::MicroInterpreter)) != 0) return false;
  d->interpreter = new (mem) tflite::MicroInterpreter(model, resolver, allocator, variables);
  if (d->interpreter->AllocateTensors() != kTfLiteOk) { fprintf(stderr, "mww: %s: AllocateTensors failed\n", d->path); return false; }

  TfLiteTensor* in = d->interpreter->input(0);
  TfLiteTensor* out = d->interpreter->output(0);
  if (!in || !out || in->dims->size != 3 || in->dims->data[2] != kFeatures || in->dims->data[1] < 1 ||
      in->dims->data[1] > kMaxStride || (in->type != kTfLiteInt8 && in->type != kTfLiteUInt8) ||
      (out->type != kTfLiteUInt8 && out->type != kTfLiteInt8) || in->params.scale <= 0) {
    fprintf(stderr, "mww: %s: not a microWakeWord streaming model\n", d->path);
    return false;
  }
  d->stride = in->dims->data[1];
  d->in_signed = in->type == kTfLiteInt8;
  d->in_scale = static_cast<double>(in->params.scale);
  d->in_zero = in->params.zero_point;
  d->out_scale = static_cast<double>(out->params.scale);
  d->out_zero = out->params.zero_point;
  d->staged = 0; d->prob_count = 0; d->prob_pos = 0; d->quiet_until = 0;
  fprintf(stderr, "mww: %s: stride %d, cutoff %.3f, window %d, arena %u bytes\n", d->path, d->stride, d->cutoff, d->window,
          static_cast<unsigned>(d->interpreter->arena_used_bytes()));
  return true;
}

// One feature frame (40 values from the frontend) for every model.
bool dump_input = false;   // --dump-input (tests): the quantised model input of every frame

void on_features(const uint16_t* values, long frame, bool print_probs, long refractory_frames) {
  for (int m = 0; m < num_detectors; m++) {
    Detector* d = &detectors[m];
    int8_t* row = d->stage + d->staged * kFeatures;
    for (int i = 0; i < kFeatures; i++) {
      // as numpy does it in the reference: float32 feature, then float64 round-half-even of f / scale + zero
      double f = static_cast<double>(static_cast<float>(values[i]) * kFeatureScale);
      double q = std::nearbyint(f / d->in_scale + d->in_zero);
      if (d->in_signed) { if (q < -128) q = -128; if (q > 127) q = 127; row[i] = static_cast<int8_t>(q); }
      else { if (q < 0) q = 0; if (q > 255) q = 255; row[i] = static_cast<int8_t>(static_cast<uint8_t>(q)); }
    }
    if (dump_input) { printf("f %d", m); for (int i = 0; i < kFeatures; i++) printf(" %d", row[i]); printf("\n"); }
    if (++d->staged < d->stride) continue;
    d->staged = 0;

    TfLiteTensor* in = d->interpreter->input(0);
    memcpy(in->data.raw, d->stage, static_cast<size_t>(d->stride) * kFeatures);
    if (d->interpreter->Invoke() != kTfLiteOk) { fprintf(stderr, "mww: %s: Invoke failed\n", d->path); exit(3); }
    TfLiteTensor* out = d->interpreter->output(0);
    int raw = out->type == kTfLiteUInt8 ? out->data.uint8[0] : out->data.int8[0];
    if (print_probs) printf("p %d %d\n", m, raw);
    double prob = static_cast<double>((static_cast<float>(raw) - static_cast<float>(d->out_zero)) * static_cast<float>(d->out_scale));

    d->probs[d->prob_pos] = prob;
    d->prob_pos = (d->prob_pos + 1) % d->window;
    if (d->prob_count < d->window) d->prob_count++;
    if (d->prob_count < d->window) continue;
    double mean = 0;
    for (int i = 0; i < d->window; i++) mean += d->probs[i];
    mean /= d->window;
    if (mean > d->cutoff && frame >= d->quiet_until) {
      printf("wake %d %.3f\n", m, mean);
      fflush(stdout);
      d->quiet_until = frame + refractory_frames;   // one report per utterance
      d->prob_count = 0; d->prob_pos = 0;
    }
  }
}

// ---- frontend tables
// FrontendPopulateState computes its lookup tables (window, mel filterbank, PCAN gain, FFT twiddles) with the C
// library's floating-point functions (cosf, log1pf, powf, cos, sin) and rounds them to integers. The TV's older
// libm rounds a few of them differently from a current x86 one, and a single changed table entry changes the
// features. So the TV build carries the tables as computed on the build machine (mww_tables.h, made by
// `mww --dump-tables`) and installs them over the computed ones: the features are then bit-identical everywhere.
struct KissCpx { int16_t r, i; };
struct KissState { int nfft; int inverse; int factors[64]; KissCpx twiddles[1]; };   // kissfft's struct kiss_fft_state
struct KissRState { KissState* sub; KissCpx* tmpbuf; KissCpx* super_twiddles; };      // and struct kiss_fftr_state
const int kPcanLutSize = 4 * 32 - 3;                                                   // kWideDynamicFunctionLUTSize

int filterbank_weights(const FrontendState& st) {
  int n = 0;
  for (int i = 0; i <= st.filterbank.num_channels; i++)
    if (st.filterbank.channel_weight_starts[i] + st.filterbank.channel_widths[i] > n)
      n = st.filterbank.channel_weight_starts[i] + st.filterbank.channel_widths[i];
  return n;
}

void dump_array(const char* name, const int16_t* a, int n) {
  printf("static const int16_t %s[%d] = {", name, n);
  for (int i = 0; i < n; i++) printf("%s%s%d", i ? "," : "", i % 16 ? " " : "\n  ", a[i]);
  printf("\n};\n");
}

void dump_tables(const FrontendState& st) {
  const KissRState* fft = static_cast<const KissRState*>(st.fft.scratch);
  int sub = fft->sub->nfft, nw = filterbank_weights(st), nc = st.filterbank.num_channels + 1;
  printf("// Audio frontend tables for mww (see native/mww.cc); generated by `mww --dump-tables`.\n");
  printf("#define MWW_T_WINDOW %d\n#define MWW_T_CHANNELS %d\n#define MWW_T_WEIGHTS %d\n#define MWW_T_FFT %d\n",
         static_cast<int>(st.window.size), nc, nw, sub);
  printf("static const int mww_t_start_index = %d, mww_t_end_index = %d;\n", st.filterbank.start_index, st.filterbank.end_index);
  dump_array("mww_t_window", st.window.coefficients, static_cast<int>(st.window.size));
  dump_array("mww_t_freq_starts", st.filterbank.channel_frequency_starts, nc);
  dump_array("mww_t_weight_starts", st.filterbank.channel_weight_starts, nc);
  dump_array("mww_t_widths", st.filterbank.channel_widths, nc);
  dump_array("mww_t_weights", st.filterbank.weights, nw);
  dump_array("mww_t_unweights", st.filterbank.unweights, nw);
  dump_array("mww_t_pcan", st.pcan_gain_control.gain_lut, kPcanLutSize);
  dump_array("mww_t_twiddles", &fft->sub->twiddles[0].r, 2 * sub);
  dump_array("mww_t_super_twiddles", &fft->super_twiddles[0].r, 2 * (sub / 2));
}

#ifdef MWW_TABLES
#include "mww_tables.h"
bool install_tables(FrontendState* st) {
  KissRState* fft = static_cast<KissRState*>(st->fft.scratch);
  if (static_cast<int>(st->window.size) != MWW_T_WINDOW || st->filterbank.num_channels + 1 != MWW_T_CHANNELS ||
      fft->sub->nfft != MWW_T_FFT) return false;
  if (filterbank_weights(*st) != MWW_T_WEIGHTS) {      // a different mel layout: the weight arrays need another size
    free(st->filterbank.weights); free(st->filterbank.unweights);
    st->filterbank.weights = static_cast<int16_t*>(calloc(MWW_T_WEIGHTS, sizeof(int16_t)));
    st->filterbank.unweights = static_cast<int16_t*>(calloc(MWW_T_WEIGHTS, sizeof(int16_t)));
    if (!st->filterbank.weights || !st->filterbank.unweights) return false;
  }
  st->filterbank.start_index = mww_t_start_index;
  st->filterbank.end_index = mww_t_end_index;
  memcpy(st->window.coefficients, mww_t_window, sizeof(mww_t_window));
  memcpy(st->filterbank.channel_frequency_starts, mww_t_freq_starts, sizeof(mww_t_freq_starts));
  memcpy(st->filterbank.channel_weight_starts, mww_t_weight_starts, sizeof(mww_t_weight_starts));
  memcpy(st->filterbank.channel_widths, mww_t_widths, sizeof(mww_t_widths));
  memcpy(st->filterbank.weights, mww_t_weights, sizeof(mww_t_weights));
  memcpy(st->filterbank.unweights, mww_t_unweights, sizeof(mww_t_unweights));
  memcpy(st->pcan_gain_control.gain_lut, mww_t_pcan, sizeof(mww_t_pcan));
  memcpy(&fft->sub->twiddles[0].r, mww_t_twiddles, sizeof(mww_t_twiddles));
  memcpy(&fft->super_twiddles[0].r, mww_t_super_twiddles, sizeof(mww_t_super_twiddles));
  return true;
}
#endif

}  // namespace

int main(int argc, char** argv) {
  bool print_probs = false, dump_tables_only = false;
  double refractory = 2.0;
  int a = 1;
  for (; a < argc && argv[a][0] == '-' && argv[a][1] == '-'; a++) {
    if (!strcmp(argv[a], "--probs")) print_probs = true;
    else if (!strcmp(argv[a], "--dump-input")) dump_input = true;
    else if (!strcmp(argv[a], "--dump-tables")) dump_tables_only = true;
    else if (!strcmp(argv[a], "--refractory") && a + 1 < argc) refractory = atof(argv[++a]);
    else { fprintf(stderr, "mww: unknown option %s\n", argv[a]); return 2; }
  }
  if (!dump_tables_only && (a >= argc || (argc - a) % 3 != 0 || (argc - a) / 3 > kMaxModels)) {
    fprintf(stderr, "usage: mww [--probs] [--refractory SECONDS] MODEL.tflite CUTOFF WINDOW [...]   (16 kHz s16le mono on stdin)\n");
    return 2;
  }

  tflite::InitializeTarget();
  static Resolver resolver;
  if (!register_ops(&resolver)) { fprintf(stderr, "mww: cannot register operators\n"); return 3; }
  for (; a < argc; a += 3) {
    Detector* d = &detectors[num_detectors];
    d->path = argv[a];
    d->cutoff = atof(argv[a + 1]);
    d->window = atoi(argv[a + 2]);
    if (d->cutoff <= 0 || d->cutoff >= 1 || d->window < 1 || d->window > kMaxWindow) {
      fprintf(stderr, "mww: %s: cutoff must be in (0,1) and window in 1..%d\n", d->path, kMaxWindow);
      return 2;
    }
    if (!load(d, resolver)) return 3;
    num_detectors++;
  }

  FrontendConfig config;
  memset(&config, 0, sizeof(config));
  config.window.size_ms = 30;
  config.window.step_size_ms = 10;
  config.filterbank.num_channels = kFeatures;
  config.filterbank.lower_band_limit = 125.0f;
  config.filterbank.upper_band_limit = 7500.0f;
  config.noise_reduction.smoothing_bits = 10;
  config.noise_reduction.even_smoothing = 0.025f;
  config.noise_reduction.odd_smoothing = 0.06f;
  config.noise_reduction.min_signal_remaining = 0.05f;
  config.pcan_gain_control.enable_pcan = 1;
  config.pcan_gain_control.strength = 0.95f;
  config.pcan_gain_control.offset = 80.0f;
  config.pcan_gain_control.gain_bits = 21;
  config.log_scale.enable_log = 1;
  config.log_scale.scale_shift = 6;
  FrontendState frontend;
  if (!FrontendPopulateState(&config, &frontend, kSampleRate)) { fprintf(stderr, "mww: cannot set up the audio frontend\n"); return 3; }
#ifdef MWW_TABLES
  if (!install_tables(&frontend)) { fprintf(stderr, "mww: built-in frontend tables do not fit\n"); return 3; }
#endif
  if (dump_tables_only) { dump_tables(frontend); return 0; }

  const long refractory_frames = static_cast<long>(refractory * 100.0);   // feature frames are 10 ms apart
  static uint8_t bytes[16384];
  static int16_t samples[sizeof(bytes) / 2 + kSamplesPerChunk];
  size_t have = 0;      // samples waiting in `samples`
  size_t odd = 0;       // 1 if a single byte of a sample is waiting in bytes[0]
  long frame = 0;
  if (print_probs) setvbuf(stdout, nullptr, _IOFBF, 1 << 16);

  for (;;) {
    ssize_t n = read(STDIN_FILENO, bytes + odd, sizeof(bytes) - odd);
    if (n <= 0) break;
    size_t total = odd + static_cast<size_t>(n);
    for (size_t i = 0; i + 1 < total; i += 2) {
      samples[have++] = static_cast<int16_t>(static_cast<uint16_t>(bytes[i]) | (static_cast<uint16_t>(bytes[i + 1]) << 8));
    }
    odd = total & 1;
    if (odd) bytes[0] = bytes[total - 1];

    // as the reference: hand the frontend 10 ms at a time, move on by what it consumed
    size_t pos = 0;
    while (have - pos >= static_cast<size_t>(kSamplesPerChunk)) {
      size_t used = 0;
      FrontendOutput out = FrontendProcessSamples(&frontend, samples + pos, kSamplesPerChunk, &used);
      pos += used;
      if (out.size == static_cast<size_t>(kFeatures)) on_features(out.values, frame++, print_probs, refractory_frames);
      else if (used == 0) break;
    }
    memmove(samples, samples + pos, (have - pos) * sizeof(int16_t));
    have -= pos;
  }
  fflush(stdout);
  return 0;
}
