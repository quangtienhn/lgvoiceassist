# ha-voice: Home Assistant Assist z pilota LG Magic Remote

Telewizor: LG OLED55CX (webOS 5.6.2, root przez Homebrew Channel), TV_IP.

## Jak to działa
1. Trzymasz przycisk mikrofonu na pilocie. `keyfilters` wysyła `setInputEvent {event: down/up}` do usługi
   `com.webos.service.voiceconductor`. Tę nazwę zajmuje `ha-voice.js` zamiast LG (LG voiceconductor
   jest zatrzymany i podmieniony na atrapę `voiceconductor-stub` przez bind-mount).
2. `ha-voice.js` woła (jako voiceconductor) `voiceinput/startStreaming {keyType:"thinQtv",subscribe:true,deviceType:"remote"}`.
   voiceinput (LG) wysyła do pilota raport HID feature `F9 03`, dekoduje mSBC i udostępnia
   PCM s16le 16 kHz mono na `/tmp/voiceinput_remote1.soc`. Podtrzymanie: `restartTimer` co 2,5 s.
   Stop: `stopStreaming` (`F9 04`). Stop **musi** iść od tego samego klienta, który zaczął, inaczej „permission fail”.
3. Dźwięk leci do HA przez WebSocket `assist_pipeline/run` (stt→tts, wybrany asystent i device_id satelity).
   Na ekranie dymek (createToast) z tekstem i odpowiedzią, TTS gra `mpg123`.

## Pliki na TV
- `/media/developer/ha-voice/ha-voice.js`, `config.json`, `token` (token HA, chmod 600), `voiceconductor-stub`
- `/var/lib/webosbrew/init.d/60-ha-voice` — autostart (stub + stop LG voiceconductor + pętla restartów)
- log: `/tmp/ha-voice.log`

## Uwagi
- Nie włączać blokady „voice” w nospy (Life's Good Without Spying) — zastąpiłaby też voiceinput.
- Procesy potomne startują przez `spawnClean` (zamyka odziedziczone fd): inaczej np. wiszący mpg123 trzyma
  gniazdo huba i po restarcie nazwa voiceconductor jest „already exists”.
- Nie używać `pkill -f ha-voice.js` przez ssh (zabija własną sesję) — zabijać po PID.
- Protokół pilota (BLE, „LGE MR20”, xx:xx:xx:xx:xx:xx): hidraw istnieje tylko gdy pilot nie śpi; raport audio 0xFE,
  124 B = FE seq 80 8B + 2×(01 H2 + 57 B mSBC + pad).
- Przywrócenie asystenta LG: `rm /var/lib/webosbrew/init.d/60-ha-voice` i restart TV.
