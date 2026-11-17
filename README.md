# LG TV Assist

Home Assistant voice satellite for rooted LG webOS TVs: push-to-talk with the **Magic Remote mic**.
Home Assistant connects to the TV over the **ESPHome native API**, so there is no token or login on the TV;
the connection is **encrypted** with a key that Home Assistant sets by itself, as for an ESPHome device.
The TV shows up in HA as an `assist_satellite` with a pipeline selector, area, announcements and timers.

The app, its toasts on the TV and the entity names follow the TV menu language: **English, Polish, German, Spanish**
(English for anything else); the language can also be picked in the app.

Tested on: LG OLED55CX (webOS 5.6.2, root via Homebrew Channel), Magic Remote MR20 (BLE), HA 2026.11.

## How it works
1. **Mic button:** `com.webos.starfish.keyfilters` sends the mic key to `com.webos.service.voiceconductor`
   (`//setInputEvent {"event":"down"|"up","inputType":"hold"}`). The daemon holds that luna name; LG's
   voiceconductor is stopped and bind-mounted with an `exit 0` stub. `/dev/input` is grabbed, so evdev can't be used.
2. **Audio:** the daemon calls LG `voiceinput/startStreaming {keyType:"thinQtv",subscribe:true,deviceType:"remote"}`
   *through its own voiceconductor handle* (voiceinput only lets the starter stop: `stopStreaming`, otherwise "permission fail").
   voiceinput sends the remote the HID feature report `F9 03` (stop `F9 04`, keep-alive `F9 05` via `restartTimer`),
   decodes the remote's mSBC and serves raw **PCM s16le 16 kHz mono** on `/tmp/voiceinput_remote1.soc`.
3. **Home Assistant:** ESPHome API server on port 6053 (plaintext or Noise-encrypted, see below) plus an mDNS responder for `_esphomelib._tcp`, so HA
   auto-discovers it. Push-to-talk: `VoiceAssistantRequest(start)` → `VoiceAssistantAudio` chunks → `VoiceAssistantAudio(end)` on release.
   Replies, announcements and media_player URLs play through `mpg123` (MP3 is declared as the supported format) or `gst-play-1.0`.

## Layout
```
app/                                  packaged into the .ipk
  index.html, app.js                  webOS app (UI)
  i18n.js                             translations, shared by the UI and the daemon
  daemon/satellite.js                 ESPHome satellite daemon (Node 8, no npm deps)
  daemon/lib/{pb,messages,mdns}.js    protobuf codec, API message subset, mDNS responder
  daemon/lib/noise.js                 API encryption: X25519, ChaCha20-Poly1305, Noise handshake, framing
  daemon/bin/mww, daemon/models/      wake word detector and models (built by native/build.sh, not in git)
  daemon/{autostart,loop,stop,init-hook}.sh
  services/io.github.xrogers.lgtvassist.service/
    service.js                        luna service: status/start/stop/restart/setSettings (runs as root)
native/mww.cc, native/build.sh        the wake word detector and its build
tools/build_ipk.py                    builds dist/*.ipk + the Homebrew Channel manifest (no ares-cli needed)
tools/check_i18n.js                   checks that all translations are complete and used
tools/test_*.{js,py}, daemon_harness* tests (see below)
tools/make_icons.py                   draws the icons
legacy/                               first prototype (TV → HA WebSocket with a token)
.github/workflows/release.yml         CI build; a tag vX.Y.Z publishes a GitHub release
```

## Build and install (local)
```sh
native/build.sh webos                           # wake word detector + models (optional; without it HA detects the wake word)
python3 tools/build_ipk.py                      # → dist/io.github.xrogers.lgtvassist_<ver>_all.ipk (+ manifest)
scp dist/*.ipk root@TV:/tmp/lgtvassist.ipk
ssh root@TV 'luna-send -i luna://com.webos.appInstallService/dev/install \
  "{\"id\":\"com.ares.defaultName\",\"ipkUrl\":\"/tmp/lgtvassist.ipk\",\"subscribe\":true}"'
```
Open the app on the TV. On the first run (and after each reinstall) choose **Nadaj uprawnienia (Homebrew)**:
the app calls `org.webosbrew.hbchannel.service/elevateService` and starts the service, which installs the boot hook
`/var/lib/webosbrew/init.d/60-lgtv-assist`. Then in HA go to **Settings → Devices & services**, where the TV appears as a
discovered ESPHome device ("LG TV"). To add it manually, use ESPHome with host = TV IP and port 6053.

## Wake word on the TV
With a USB microphone the TV listens for the wake word **itself** (microWakeWord, the engine of ESPHome voice
devices such as Home Assistant Voice PE): nothing leaves the TV until it hears the word, then the audio goes to Home
Assistant, starting at speech-to-text. The app's **Wake word** button picks *Okay Nabu* (default), *Hey Jarvis*,
*Hey Mycroft* or *Alexa*, or *by Home Assistant*: the microphone is then streamed to Home Assistant all the time
and its wake word engine (e.g. openWakeWord) listens, as before 0.7.

- `app/daemon/bin/mww` is a small native program (`native/mww.cc`): TensorFlow Lite Micro plus TensorFlow's audio
  "microfrontend", reading 16 kHz audio on stdin and printing `wake <model> <probability>`. On the TV it uses
  about 2 % of one core per model and 1 MB of memory.
- `native/build.sh webos` builds it with the webOS toolchain (openlgtv/buildroot-nc4) as a 32-bit ARM binary and
  copies the models (from pymicro-wakeword) to `app/daemon/models/`; `native/build.sh host` builds it for tests.
  All third-party code is fetched at pinned versions; licences: `app/daemon/bin/THIRD_PARTY_LICENSES.txt`.
- It gives the same results as pymicro-wakeword, the reference implementation (`tools/test_wakeword.py`): the model
  input is bit-identical, and every model output is bit-identical to TensorFlow Lite's reference kernels.
  pymicro-wakeword runs TensorFlow Lite's optimised kernels, which round a little differently (194 of 5965 outputs
  differ on its test recordings, by at most 21/255); every recording is detected or rejected the same way.
- The frontend's lookup tables are computed with the C library's float functions, and the TV's older libm rounds
  a few entries differently. The TV build therefore carries the tables computed on the build machine
  (`mww --dump-tables`), so the TV's output is bit-identical to the build machine's.
- If the detector cannot run (or keeps stopping), the TV falls back to Home Assistant's wake word by itself.

## Encryption
The connection is encrypted with `Noise_NNpsk0_25519_ChaChaPoly_SHA256`, the ESPHome API encryption, and nobody has
to type a key: as with an ESPHome device that has no key yet, **Home Assistant makes the key and hands it to the TV**
the first time it connects (over a short Noise session with the all-zero key, so the key never crosses the network in
the clear; Home Assistant older than that sends it over the plaintext session). From then on the TV accepts only
connections that prove this key. Until Home Assistant has done so, the app shows *Encryption: waiting for Home
Assistant* and the TV still answers in plaintext.

- The key lives in `/media/developer/lgtv-assist/settings.json` (`api_key`, base64 of 32 bytes); the app never shows it.
- **Encryption: off** in the app makes the TV plaintext-only and drops the key; Home Assistant then asks to confirm
  that encryption was removed. Turning it on again lets Home Assistant set a new key.
- To move the TV to another Home Assistant, turn encryption off and on once.
- Without encryption anyone on the home network can connect to port 6053, play media on the TV and, in hands-free
  mode, receive the microphone audio.

The TV's Node 8 / OpenSSL 1.0.2 has neither X25519 nor ChaCha20-Poly1305, so both are implemented in plain JavaScript
in `app/daemon/lib/noise.js` (X25519 after TweetNaCl, public domain).

## Tests
```sh
node tools/check_i18n.js                 # translations complete and used
node tools/test_noise.js                 # crypto test vectors (RFC 7748, RFC 8439), Noise handshake, framing; runs on Node 8
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install aioesphomeapi cryptography
/tmp/venv/bin/python tools/test_interop.py      # the real daemon against the real Home Assistant client library (encryption, key hand-over)
/tmp/venv/bin/python tools/test_voice.py        # voice audio, events, announcements, languages; encrypted and plaintext
/tmp/venv/bin/python tools/test_crypto_diff.py  # X25519 / ChaCha20-Poly1305 against OpenSSL on random inputs
native/build.sh host && /tmp/venv/bin/pip install pymicro-wakeword==2.5.0 ai-edge-litert
/tmp/venv/bin/python tools/test_wakeword.py     # wake word detector against the reference implementation
```
`tools/daemon_harness.py` runs the unmodified daemon off-TV (stub `palmbus`, fake `luna-send`/`pactl`/`parec`, temp
directories). `LGTV_NODE=/path/to/node` picks the Node binary, e.g. Node 8.12 as on the TV.

## Translations
All texts live in `app/i18n.js`. To add a language, copy the `en` block under a new two-letter code, translate the
values (keep the `{placeholders}` and `<b>` tags), add the code to `LANGS` and its name to `NAMES`, then run
`node tools/check_i18n.js`. The language is the one chosen in the app, otherwise the TV menu language
(`localeInfo.locales.UI` from LG's settings service, or the locale the app reported when it was last opened).

## Releases
The version is kept in three places, and the build fails if they differ: `app/appinfo.json`,
`app/services/*/package.json` and `VERSION` in `app/daemon/satellite.js`.
```sh
git tag v0.5.4 && git push origin v0.5.4       # the tag must match that version
```
The workflow then publishes `io.github.xrogers.lgtvassist_<ver>_all.ipk`, `io.github.xrogers.lgtvassist.manifest.json`
and `SHA256SUMS` as a GitHub release. The manifest is what a Homebrew Channel repository entry points at
(`https://github.com/xrogers/lgvoiceassist/releases/latest/download/io.github.xrogers.lgtvassist.manifest.json`).
Builds are reproducible: the commit time is used as the timestamp of every archive entry.

## Notes
- Children are started through `spawnClean` (closes inherited fds); otherwise a lingering child keeps the luna hub
  socket and the voiceconductor name stays "already exists" after a restart.
- Turning the app off (or uninstalling it and rebooting) gives the mic button back to LG's assistant.
- Data/settings: `/media/developer/lgtv-assist/` (`settings.json`, `disabled` flag). Logs: `/tmp/lgtv-assist.log`.
- Remote protocol (MR20, BLE, `hidraw` only while awake): voice report `0xFE`, 124 B = `FE seq 80 8B` + 2 × (`01 H2` + 57 B mSBC + pad).

## TODO
- Start TTS playback early from the streaming URL in `RUN_START`.
- Listing in the Homebrew Channel repository (webosbrew/apps-repo) for one-click install and auto re-elevation.
