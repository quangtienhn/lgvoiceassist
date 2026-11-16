# LG TV Assist

Home Assistant voice satellite for rooted LG webOS TVs: push-to-talk with the **Magic Remote mic**.
Home Assistant connects to the TV over the **ESPHome native API**, so there is no token or login on the TV.
The TV shows up in HA as an `assist_satellite` with a pipeline selector, area, announcements and timers.

Tested on: LG OLED55CX (webOS 5.6.2, root via Homebrew Channel), Magic Remote MR20 (BLE), HA 2026.11.

## How it works
1. **Mic button:** `com.webos.starfish.keyfilters` sends the mic key to `com.webos.service.voiceconductor`
   (`//setInputEvent {"event":"down"|"up","inputType":"hold"}`). The daemon holds that luna name; LG's
   voiceconductor is stopped and bind-mounted with an `exit 0` stub. `/dev/input` is grabbed, so evdev can't be used.
2. **Audio:** the daemon calls LG `voiceinput/startStreaming {keyType:"thinQtv",subscribe:true,deviceType:"remote"}`
   *through its own voiceconductor handle* (voiceinput only lets the starter stop: `stopStreaming`, otherwise "permission fail").
   voiceinput sends the remote the HID feature report `F9 03` (stop `F9 04`, keep-alive `F9 05` via `restartTimer`),
   decodes the remote's mSBC and serves raw **PCM s16le 16 kHz mono** on `/tmp/voiceinput_remote1.soc`.
3. **Home Assistant:** ESPHome API server on port 6053 (plaintext) plus an mDNS responder for `_esphomelib._tcp`, so HA
   auto-discovers it. Push-to-talk: `VoiceAssistantRequest(start)` → `VoiceAssistantAudio` chunks → `VoiceAssistantAudio(end)` on release.
   Replies, announcements and media_player URLs play through `mpg123` (MP3 is declared as the supported format) or `gst-play-1.0`.

## Layout
```
app/                                  packaged into the .ipk
  index.html, app.js                  webOS app (UI)
  daemon/satellite.js                 ESPHome satellite daemon (Node 8, no npm deps)
  daemon/lib/{pb,messages,mdns}.js    protobuf codec, API message subset, mDNS responder
  daemon/{autostart,loop,stop,init-hook}.sh
  services/io.github.xrogers.lgtvassist.service/
    service.js                        luna service: status/start/stop/restart/setSettings (runs as root)
tools/build_ipk.py                    builds dist/*.ipk + the Homebrew Channel manifest (no ares-cli needed)
tools/make_icons.py                   draws the icons
legacy/                               first prototype (TV → HA WebSocket with a token)
.github/workflows/release.yml         CI build; a tag vX.Y.Z publishes a GitHub release
```

## Build and install (local)
```sh
python3 tools/build_ipk.py                      # → dist/io.github.xrogers.lgtvassist_<ver>_all.ipk (+ manifest)
scp dist/*.ipk root@TV:/tmp/lgtvassist.ipk
ssh root@TV 'luna-send -i luna://com.webos.appInstallService/dev/install \
  "{\"id\":\"com.ares.defaultName\",\"ipkUrl\":\"/tmp/lgtvassist.ipk\",\"subscribe\":true}"'
```
Open the app on the TV. On the first run (and after each reinstall) choose **Nadaj uprawnienia (Homebrew)**:
the app calls `org.webosbrew.hbchannel.service/elevateService` and starts the service, which installs the boot hook
`/var/lib/webosbrew/init.d/60-lgtv-assist`. Then in HA go to **Settings → Devices & services**, where the TV appears as a
discovered ESPHome device ("LG TV"). To add it manually, use ESPHome with host = TV IP, port 6053 and no key.

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
- Don't enable the "voice" block in *Life's Good Without Spying*: it also stubs `voiceinput`, which the app needs.
- Children are started through `spawnClean` (closes inherited fds); otherwise a lingering child keeps the luna hub
  socket and the voiceconductor name stays "already exists" after a restart.
- Turning the app off (or uninstalling it and rebooting) gives the mic button back to LG's assistant.
- Data/settings: `/media/developer/lgtv-assist/` (`settings.json`, `disabled` flag). Logs: `/tmp/lgtv-assist.log`.
- Remote protocol (MR20, BLE, `hidraw` only while awake): voice report `0xFE`, 124 B = `FE seq 80 8B` + 2 × (`01 H2` + 57 B mSBC + pad).

## TODO
- ESPHome Noise encryption (needs pure-JS X25519 + ChaCha20-Poly1305: the TV's Node 8 / OpenSSL 1.0.2 lacks both).
- Start TTS playback early from the streaming URL in `RUN_START`.
- Homebrew Channel repository manifest (root required) for one-click install and auto re-elevation.
