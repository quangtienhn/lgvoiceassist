#!/bin/sh
# Builds the on-TV wake word detector (native/mww.cc) and collects the wake word models.
#
#   native/build.sh host     -> native/build/host/mww      (for tests on this machine)
#   native/build.sh webos    -> native/build/webos/mww     (32-bit ARM, for the TV), copied to app/daemon/bin/
# Both copy the models to app/daemon/models/; build_ipk.py packs app/daemon/bin and app/daemon/models.
#
# Everything third-party is fetched at a pinned version into native/.deps (nothing of it is in this repository):
#   * TensorFlow Lite Micro (inference)                 github.com/tensorflow/tflite-micro   Apache-2.0
#   * microfrontend + kissfft (audio features)          PyPI pymicro-features (sdist)        Apache-2.0 / BSD-3-Clause
#   * microWakeWord models, test recordings             github.com/OHF-Voice/pymicro-wakeword Apache-2.0
#   * webOS toolchain (webos target only)               github.com/openlgtv/buildroot-nc4
# Needs: git, make, python3, curl, a host C++ compiler. The licences go to app/daemon/bin/THIRD_PARTY_LICENSES.txt.
set -eu

TFLM_COMMIT=2c13ceb07010b642785ffb20f02e82dabb2bb435
FEATURES_VERSION=2.0.2
FEATURES_SHA256=0d0bed7843ec78b6ced82d1a2dcddeb4fe5df61b3af80a281d0868c8e279c727
MODELS_COMMIT=333da550c54b95192af472cfe37d98dab2f2086e
NDK_TAG=2026.08-webos
NDK_FILE=arm-webos-linux-gnueabi_sdk-buildroot-x86_64.tar.gz
NDK_SHA256=2230a6351e5cce6fcb9d4fdcb4697335f223995401ef969c81744aaeb14c5344
MODELS="okay_nabu hey_jarvis hey_mycroft alexa"

TARGET="${1:-host}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
DEPS="${MWW_DEPS:-$HERE/.deps}"
BUILD="$HERE/build/$TARGET"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
mkdir -p "$DEPS" "$BUILD/obj"

fetch_commit() {   # dir, repository url, commit
  if [ ! -d "$1/.git" ]; then
    rm -rf "$1"; mkdir -p "$1"
    git -C "$1" init -q
    git -C "$1" remote add origin "$2"
    git -C "$1" fetch -q --depth 1 origin "$3"
    git -C "$1" checkout -q FETCH_HEAD
  fi
  [ "$(git -C "$1" rev-parse HEAD)" = "$3" ] || { echo "$1 is not at $3" >&2; exit 1; }
}

# ---- TensorFlow Lite Micro: a standalone source tree made by its own generator
TFLM="$DEPS/tflm-tree"
if [ ! -f "$TFLM/.done" ]; then
  fetch_commit "$DEPS/tflite-micro" https://github.com/tensorflow/tflite-micro.git "$TFLM_COMMIT"
  rm -rf "$TFLM"
  (cd "$DEPS/tflite-micro" && python3 tensorflow/lite/micro/tools/project_generation/create_tflm_tree.py "$TFLM")
  touch "$TFLM/.done"
fi

# ---- audio features: TensorFlow's microfrontend and kissfft, as packaged for the reference implementation
FE="$DEPS/pymicro_features-$FEATURES_VERSION"
if [ ! -d "$FE" ]; then
  url="$(curl -fsSL "https://pypi.org/pypi/pymicro-features/$FEATURES_VERSION/json" | python3 -c 'import json,sys; print([u["url"] for u in json.load(sys.stdin)["urls"] if u["packagetype"] == "sdist"][0])')"
  curl -fsSL -o "$DEPS/features.tar.gz" "$url"
  echo "$FEATURES_SHA256  $DEPS/features.tar.gz" | sha256sum -c - >/dev/null
  tar xzf "$DEPS/features.tar.gz" -C "$DEPS"
fi
FE_LIB="$FE/tensorflow/lite/experimental/microfrontend/lib"

# ---- models (and test recordings)
fetch_commit "$DEPS/pymicro-wakeword" https://github.com/OHF-Voice/pymicro-wakeword.git "$MODELS_COMMIT"

# ---- compiler
case "$TARGET" in
  host)
    CXX="${CXX:-g++}"; LDEXTRA="" ;;
  webos)
    NDK="${WEBOS_NDK:-$DEPS/arm-webos-linux-gnueabi_sdk-buildroot}"
    if [ ! -x "$NDK/bin/arm-webos-linux-gnueabi-g++" ]; then
      curl -fsSL -o "$DEPS/$NDK_FILE" "https://github.com/openlgtv/buildroot-nc4/releases/download/$NDK_TAG/$NDK_FILE"
      echo "$NDK_SHA256  $DEPS/$NDK_FILE" | sha256sum -c - >/dev/null
      tar xzf "$DEPS/$NDK_FILE" -C "$DEPS"
      rm -f "$DEPS/$NDK_FILE"
      "$NDK/relocate-sdk.sh"
    fi
    CXX="$NDK/bin/arm-webos-linux-gnueabi-g++"
    # the TV's libstdc++ is older than the toolchain's: link it in
    LDEXTRA="-static-libstdc++ -static-libgcc" ;;
  *) echo "usage: $0 host|webos" >&2; exit 2 ;;
esac
echo "compiler: $("$CXX" --version | head -1)"

# The flags TensorFlow Lite Micro's own Makefile uses (without its warning set).
TFLM_FLAGS="-std=c++17 -O2 -fno-rtti -fno-exceptions -fno-threadsafe-statics -fno-unwind-tables -fno-asynchronous-unwind-tables \
 -ffunction-sections -fdata-sections -DTFLM_REMOVE_VIRTUAL_DELETE -DTF_LITE_DISABLE_X86_NEON -DFLATBUFFERS_LOCALE_INDEPENDENT=0 \
 -DFLATBUFFERS_PREFER_PRINTF=1 -DTF_LITE_USE_CTIME -DNDEBUG \
 -I$TFLM -I$TFLM/third_party/flatbuffers/include -I$TFLM/third_party/gemmlowp -I$TFLM/third_party/ruy"
FE_FLAGS="-O2 -ffunction-sections -fdata-sections -DFIXED_POINT=16 -I$FE -I$FE/kissfft"

# one object per source file, named after its path; compiled in parallel
compile_list() {   # flags, list file
  FLAGS="$1" CXX="$CXX" OBJ="$BUILD/obj" xargs -P "$JOBS" -I{} sh -c '
    o="$OBJ/$(printf %s "{}" | tr "/." "__").o"
    [ -f "$o" ] && [ "$o" -nt "{}" ] || "$CXX" $FLAGS -c "{}" -o "$o" || exit 255' < "$2"
}

# the library itself: everything under tensorflow/ except test helpers (the signal library is not needed)
find "$TFLM/tensorflow" -name '*.cc' ! -name '*_test.cc' ! -name 'test_*' ! -name 'mock_*' ! -name 'fake_*' \
  ! -path '*/testing/*' ! -path '*/examples/*' ! -path '*/benchmarks/*' ! -name 'recording_*' | sort > "$BUILD/tflm.list"
echo "TensorFlow Lite Micro: $(wc -l < "$BUILD/tflm.list") files"
compile_list "$TFLM_FLAGS" "$BUILD/tflm.list"

: > "$BUILD/fe.list"
for f in kiss_fft_int16 fft fft_util filterbank filterbank_util frontend frontend_util log_lut log_scale log_scale_util \
         noise_reduction noise_reduction_util pcan_gain_control pcan_gain_control_util window window_util; do
  echo "$FE_LIB/$f.cc" >> "$BUILD/fe.list"
done
echo "$FE/kissfft/kiss_fft.cc" >> "$BUILD/fe.list"
echo "$FE/kissfft/tools/kiss_fftr.cc" >> "$BUILD/fe.list"
compile_list "$FE_FLAGS" "$BUILD/fe.list"

rm -f "$BUILD/libmww.a"
ar rcs "$BUILD/libmww.a" "$BUILD"/obj/*.o
TABLES=""
if [ "$TARGET" = webos ]; then
  # the frontend tables as computed on this machine (see "frontend tables" in mww.cc)
  [ -x "$HERE/build/host/mww" ] || MWW_DEPS="$DEPS" "$0" host
  "$HERE/build/host/mww" --dump-tables > "$BUILD/mww_tables.h"
  TABLES="-DMWW_TABLES -I$BUILD"
fi
# shellcheck disable=SC2086
"$CXX" $TFLM_FLAGS -I"$FE" $TABLES -Wall -c "$HERE/mww.cc" -o "$BUILD/mww.o"
# shellcheck disable=SC2086
"$CXX" -o "$BUILD/mww" "$BUILD/mww.o" "$BUILD/libmww.a" -lm -Wl,--gc-sections $LDEXTRA
ls -l "$BUILD/mww"

mkdir -p "$ROOT/app/daemon/models"
for m in $MODELS; do
  cp "$DEPS/pymicro-wakeword/pymicro_wakeword/models/$m.tflite" "$DEPS/pymicro-wakeword/pymicro_wakeword/models/$m.json" "$ROOT/app/daemon/models/"
done
if [ "$TARGET" = webos ]; then
  "$(dirname "$CXX")/arm-webos-linux-gnueabi-strip" "$BUILD/mww"
  mkdir -p "$ROOT/app/daemon/bin"
  cp "$BUILD/mww" "$ROOT/app/daemon/bin/mww"
  L="$ROOT/app/daemon/bin/THIRD_PARTY_LICENSES.txt"
  {
    echo "bin/mww and models/ contain third-party software:"
    echo "  TensorFlow Lite Micro $TFLM_COMMIT (github.com/tensorflow/tflite-micro), Apache-2.0"
    echo "  TensorFlow Lite microfrontend, as packaged in pymicro-features $FEATURES_VERSION, Apache-2.0"
    echo "  FlatBuffers (via TensorFlow Lite Micro), Apache-2.0"
    echo "  kissfft, BSD-3-Clause, Copyright (c) 2003-2010 Mark Borgerding"
    echo "  microWakeWord models from pymicro-wakeword $MODELS_COMMIT (github.com/OHF-Voice/pymicro-wakeword), Apache-2.0"
    echo; echo "==== Apache License 2.0 (TensorFlow Lite Micro)"; cat "$TFLM/LICENSE"
    echo; echo "==== Apache License 2.0 (FlatBuffers)"; cat "$TFLM/third_party/flatbuffers/LICENSE"
    echo; echo "==== Apache License 2.0 (pymicro-wakeword)"; cat "$DEPS/pymicro-wakeword/LICENSE"
    echo; echo "==== kissfft"; sed -n '3,/^\*\//p' "$FE/kissfft/_kiss_fft_guts.h"
  } > "$L"
  ls -l "$ROOT/app/daemon/bin" "$ROOT/app/daemon/models"
fi
