#!/usr/bin/env python3
"""Checks the wake word detector (native/mww.cc) on the test recordings of pymicro-wakeword, the reference
implementation (it is what Home Assistant's Linux satellites use):

  * the model input (audio features, quantised) is bit-identical to pymicro-features / pymicro-wakeword;
  * every model output is bit-identical to TensorFlow Lite's reference kernels (ai-edge-litert, BUILTIN_REF:
    TensorFlow Lite Micro's kernels are ports of those). pymicro-wakeword runs TensorFlow Lite's *optimised*
    kernels, which round differently and give slightly different values now and then; the number of such
    differences and the largest one are printed for information;
  * every recording is (not) detected exactly as pymicro-wakeword decides.

    native/build.sh host
    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install pymicro-wakeword==2.5.0 ai-edge-litert
    /tmp/venv/bin/python tools/test_wakeword.py
    /tmp/venv/bin/python tools/test_wakeword.py --mww native/build/webos/mww --runner "qemu-arm -L <sysroot>"

Models and recordings come from native/.deps/pymicro-wakeword (fetched by native/build.sh).
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEPS = os.environ.get("MWW_DEPS") or os.path.join(ROOT, "native", ".deps")
REPO = os.path.join(DEPS, "pymicro-wakeword")
MODELS_DIR = os.path.join(REPO, "pymicro_wakeword", "models")
TESTS_DIR = os.path.join(REPO, "tests")
MODELS = ["okay_nabu", "hey_jarvis", "hey_mycroft", "alexa"]

results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (("  -- " + str(detail)) if detail and not ok else ""))


def load_wav(path):
    with wave.open(path, "rb") as w:
        assert (w.getframerate(), w.getsampwidth(), w.getnchannels()) == (16000, 2, 1), path
        return w.readframes(w.getnframes())


def manifest(config_path):
    with open(config_path, encoding="utf-8") as f:
        c = json.load(f)
    return os.path.join(os.path.dirname(config_path), c["model"]), c["micro"]["probability_cutoff"], c["micro"]["sliding_window_size"], c["wake_word"]


def run_mww(args, audio, models, probs=True, chunk=None, extra=()):
    """Runs the detector on `audio`; returns ({model index: [raw outputs]}, [(model index, probability)],
    {model index: [quantised input frames]} when extra has --dump-input)."""
    cmd = list(args.runner) + [args.mww] + (["--probs"] if probs else []) + list(extra)
    for config in models:
        tflite, cutoff, window, _ = manifest(config)
        cmd += [tflite, repr(cutoff), str(window)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if chunk:      # awkward write sizes: samples split across reads
        for i in range(0, len(audio), chunk):
            proc.stdin.write(audio[i:i + chunk])
            proc.stdin.flush()
        proc.stdin.close()
        out = proc.stdout.read()
        err = proc.stderr.read()
        proc.wait(timeout=600)
    else:
        out, err = proc.communicate(audio, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError("mww exited with %s: %s" % (proc.returncode, err.decode(errors="replace")[-500:]))
    raws, wakes, frames = {}, [], {}
    for line in out.decode().splitlines():
        p = line.split()
        if p[0] == "p":
            raws.setdefault(int(p[1]), []).append(int(p[2]))
        elif p[0] == "wake":
            wakes.append((int(p[1]), float(p[2])))
        elif p[0] == "f":
            frames.setdefault(int(p[1]), []).append([int(x) for x in p[2:]])
    return raws, wakes, frames


def run_reference(config, audio):
    """pymicro-wakeword on the same audio: (quantised input frames, raw outputs, detected)."""
    import numpy as np
    from pymicro_wakeword import MicroWakeWord, MicroWakeWordFeatures
    mww = MicroWakeWord.from_config(config)
    features = MicroWakeWordFeatures()
    frames, raws, detected = [], [], False
    for frame in features.process_streaming(audio):
        frames.append(np.round(frame / mww.input_scale + mww.input_zero_point).astype(mww.input_dtype).reshape(-1).tolist())
        prob = mww.process_streaming_prob(frame)
        if not mww._features:                       # an inference ran on this frame
            raws.append(int(round(mww._probabilities[-1] / mww.output_scale + mww.output_zero_point)))
        if prob is not None and prob > mww.probability_cutoff:
            detected = True
    mww.close()
    return frames, raws, detected


def run_reference_kernels(tflite, frames):
    """TensorFlow Lite's reference kernels on the given input frames: raw outputs (None without ai-edge-litert)."""
    try:
        from ai_edge_litert.interpreter import Interpreter, OpResolverType
    except ImportError:
        return None
    import numpy as np
    it = Interpreter(model_path=tflite, experimental_op_resolver_type=OpResolverType.BUILTIN_REF)
    it.allocate_tensors()
    inp, out = it.get_input_details()[0], it.get_output_details()[0]
    stride, raws = inp["shape"][1], []
    for k in range(0, len(frames) - stride + 1, stride):
        it.set_tensor(inp["index"], np.array(frames[k:k + stride], dtype=inp["dtype"]).reshape(inp["shape"]))
        it.invoke()
        raws.append(int(it.get_tensor(out["index"]).reshape(-1)[0]))
    return raws


stats = {"inferences": 0, "differ_from_optimised": 0, "largest": 0, "no_litert": False}


def utterances(raws, cutoff, window):
    """Separate stretches where the reference's sliding mean is above the cutoff (one per spoken wake word)."""
    count, above = 0, False
    for i in range(window - 1, len(raws)):
        hot = sum(raws[i - window + 1:i + 1]) / window / 256 > cutoff
        if hot and not above:
            count += 1
        above = hot
    return count


def compare(name, config, audio, args):
    """One recording, one model: inputs, outputs and the decision against the references."""
    tflite = manifest(config)[0]
    ref_frames, ref_raws, ref_detected = run_reference(config, audio)
    raws, wakes, frames = run_mww(args, audio, [config], extra=["--dump-input"])
    raws, frames = raws.get(0, []), frames.get(0, [])
    check(name + ": model input identical to pymicro-wakeword (%d frames)" % len(ref_frames), frames == ref_frames and len(frames) > 50,
          "%d vs %d frames" % (len(frames), len(ref_frames)))
    kernels = run_reference_kernels(tflite, frames)
    if kernels is None:
        stats["no_litert"] = True
    else:
        check(name + ": outputs identical to TensorFlow Lite reference kernels (%d)" % len(kernels), raws == kernels and len(raws) > 15,
              "first difference at %s" % next((i for i, (a, b) in enumerate(zip(raws, kernels)) if a != b), None))
    diffs = [abs(a - b) for a, b in zip(raws, ref_raws) if a != b]
    stats["inferences"] += len(raws)
    stats["differ_from_optimised"] += len(diffs)
    stats["largest"] = max([stats["largest"]] + diffs)
    _, cutoff, window, _ = manifest(config)
    n = utterances(ref_raws, cutoff, window)
    check(name + ": detected %d time(s), as pymicro-wakeword decides" % n, bool(wakes) == ref_detected and len(wakes) == n, wakes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mww", default=os.path.join(ROOT, "native", "build", "host", "mww"))
    ap.add_argument("--runner", default="", help='prefix to run the binary with, e.g. "qemu-arm -L <sysroot>"')
    ap.add_argument("--quick", action="store_true", help="one recording per model (slow emulators)")
    args = ap.parse_args()
    args.runner = shlex.split(args.runner)
    numbers = [1] if args.quick else [1, 2, 3]

    silence = bytes(16000 * 2)
    for model in MODELS:
        config = os.path.join(MODELS_DIR, model + ".json")
        for number in numbers:
            for other in MODELS:
                if args.quick and other not in (model, MODELS[(MODELS.index(model) + 1) % len(MODELS)]):
                    continue
                audio = load_wav(os.path.join(TESTS_DIR, other, "%d.wav" % number)) + silence
                compare("%s on '%s' %d" % (model, other, number), config, audio, args)
    # the wake words must be detected (the reference agrees, see compare)
    for model in MODELS:
        config = os.path.join(MODELS_DIR, model + ".json")
        hits = sum(1 for n in numbers if run_mww(args, load_wav(os.path.join(TESTS_DIR, model, "%d.wav" % n)) + silence, [config], probs=False)[1])
        check("%s: detected in all %d of its recordings" % (model, len(numbers)), hits == len(numbers), hits)

    # a model exported with another stride (2 instead of 3)
    config = os.path.join(TESTS_DIR, "computer", "computer.json")
    for wav in ("computer.wav", "hey_peppa_pig.wav"):
        compare("stride-2 model on %s" % wav, config, load_wav(os.path.join(TESTS_DIR, "computer", wav)) + silence, args)

    # all models at once on one long stream: each reports its own word, once, in order
    configs = [os.path.join(MODELS_DIR, m + ".json") for m in MODELS]
    stream = silence
    for m in MODELS:
        stream += load_wav(os.path.join(TESTS_DIR, m, "1.wav")) + silence * 2
    raws, wakes, _ = run_mww(args, stream, configs)
    check("four models on one stream: one detection each, in order", [w[0] for w in wakes] == [0, 1, 2, 3], wakes)
    alone, _, _ = run_mww(args, stream, [configs[0]])
    check("a model gives the same output alone and next to others", raws.get(0) == alone.get(0) and len(alone.get(0, [])) > 100)
    # the way audio is cut into writes must not matter (odd sizes split samples)
    raws_odd, wakes_odd, _ = run_mww(args, stream, configs, chunk=3331)
    check("same result when the audio arrives in odd-sized pieces", raws_odd == raws and wakes_odd == wakes)
    # repeated wake word: reported again after the quiet time, not twice within it
    twice = silence + load_wav(os.path.join(TESTS_DIR, "okay_nabu", "1.wav")) + silence * 2 + load_wav(os.path.join(TESTS_DIR, "okay_nabu", "2.wav")) + silence
    _, wakes, _ = run_mww(args, twice, [configs[0]], probs=False)
    check("two utterances -> two detections", len(wakes) == 2, wakes)
    _, wakes, _ = run_mww(args, silence * 20, configs, probs=False)
    check("40 s of silence -> nothing", wakes == [], wakes)

    # bad input is refused with a message, not a crash
    for bad, why in (([args.mww], "no model"), ([args.mww, "/nonexistent.tflite", "0.9", "5"], "missing file"),
                     ([args.mww, os.path.join(MODELS_DIR, "okay_nabu.json"), "0.9", "5"], "not a model"),
                     ([args.mww, os.path.join(MODELS_DIR, "okay_nabu.tflite"), "2", "5"], "bad cutoff")):
        p = subprocess.run(list(args.runner) + bad, input=b"", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        check("refuses: " + why, p.returncode in (2, 3) and p.stderr, (p.returncode, p.stderr[-200:]))

    print("\nfor information: %d of %d outputs differ from pymicro-wakeword's optimised kernels, by at most %d/255"
          % (stats["differ_from_optimised"], stats["inferences"], stats["largest"]))
    if stats["no_litert"]:
        print("NOTE: ai-edge-litert is not installed, so the outputs were not checked against the reference kernels")
    print("%d passed, %d failed" % (sum(results), len(results) - sum(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
