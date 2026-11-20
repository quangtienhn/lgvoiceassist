#!/usr/bin/env python3
"""End-to-end test of what the daemon is for, off-TV: voice audio, events, announcements and translated texts,
between the REAL daemon and the REAL aioesphomeapi client, over the encrypted and the plaintext transport.

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install aioesphomeapi
    /tmp/venv/bin/python tools/test_voice.py              # exit code 0 = all passed

The TV side is faked through tools/daemon_harness.py: a USB microphone (pactl lists one, parec produces a
16-bit counter so every sample can be checked), LG's settings service (luna-send answers with the TV menu
language, exactly as a webOS 5 TV does) and toasts (luna-send calls are recorded).
"""
import asyncio
import base64
import json
import os
import re
import shlex
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from daemon_harness import DaemonHarness, ROOT  # noqa: E402

from aioesphomeapi import APIClient, VoiceAssistantEventType as Ev, VoiceAssistantTimerEventType as Tm  # noqa: E402

NAME = "lgtv-test"
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (("  -- " + str(detail)) if detail and not ok else ""))


# What `luna-send -n 1 luna://com.webos.settingsservice/getSystemSettings '{"keys":["localeInfo"]}'` prints on an
# LG OLED55CX (webOS 5.6.2) with the menu in Polish.
LOCALE_JSON = ('{"subscribed":%s,"method":"getSystemSettings","settings":{"localeInfo":{"locales":{"UI":"%s","TV":"en-GB",'
               '"FMT":"en-GB","NLP":"en-GB","STT":"pl-PL","AUD":"pl-PL","AUD2":"en-GB"},"clock":"locale",'
               '"keyboards":["en","pl"],"timezone":""}},"returnValue":true}')


def luna_send(ui_locale):
    """Records every call; answers the locale subscription (ui_locale=None: the service never answers)."""
    answer = "" if ui_locale is None else "echo '%s'; " % (LOCALE_JSON % ("true", ui_locale))
    return ("#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$LGTV_HARNESS_DIR/tmp/luna.log\"\n"
            "case \"$*\" in *getSystemSettings*) " + answer + "exec sleep 600 ;; *getPowerState*) exec sleep 600 ;; esac\n"
            "exit 0\n")


PACTL = ("#!/bin/sh\n"
         "case \"$*\" in *'list sources short'*) printf '3\\talsa_input.usb-Fake_Mic-00.analog-mono\\tmodule-alsa-card.c\\ts16le 1ch 48000Hz\\tRUNNING\\n' ;; esac\n"
         "exit 0\n")
# Audio players: record how they were started (one line per call), then finish at once
def player(name):
    return "#!/bin/sh\nprintf '%s %s\\n' " + name + " \"$*\" >> \"$LGTV_HARNESS_DIR/tmp/player.log\"\nexit 0\n"


def player_log(d):
    try:
        with open(os.path.join(d.dir, "tmp", "player.log"), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


# 16 kHz s16le mono in real time: sample n has the value n mod 65536, so loss, reordering or corruption shows
PAREC = ("#!/bin/sh\n"
         "exec python3 -u -c '\n"
         "import struct, sys, time\n"
         "n = 0; t = time.time()\n"
         "while True:\n"
         "    sys.stdout.buffer.write(struct.pack(\"<320H\", *[(n + i) & 0xffff for i in range(320)])); sys.stdout.buffer.flush()\n"
         "    n += 320; t += 0.02; time.sleep(max(0, t - time.time()))\n"
         "'\n")


def luna_log(d):
    try:
        with open(os.path.join(d.dir, "tmp", "luna.log"), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


async def wait_for(pred, timeout=8.0):
    end = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < end:
        if pred():
            return True
        await asyncio.sleep(0.05)
    return bool(pred())


class Voice:
    """The Home Assistant side of a voice session: accepts every run, keeps the audio."""

    def __init__(self, client):
        self.client = client
        self.starts = []
        self.audio = bytearray()
        self.stops = 0
        client.subscribe_voice_assistant(handle_start=self.on_start, handle_stop=self.on_stop, handle_audio=self.on_audio)

    async def on_start(self, conversation_id, flags, audio_settings, wake_word_phrase):
        self.starts.append(flags)
        self.audio = bytearray()
        return 0                      # port 0 = audio over the API connection

    async def on_stop(self, abort):
        self.stops += 1

    async def on_audio(self, data, data2=b""):      # data2: second half when the client splits a ring buffer
        self.audio += data
        self.audio += data2


def continuous(pcm):
    """True if the 16-bit samples count up by one without a gap (see PAREC)."""
    n = len(pcm) // 2
    if n < 2 or len(pcm) % 2:
        return False
    import struct
    v = struct.unpack("<%dH" % n, bytes(pcm[:2 * n]))
    return all(((v[i] + 1) & 0xffff) == v[i + 1] for i in range(n - 1))


async def session_suite(encryption):
    label = "encrypted" if encryption else "plaintext"
    print("\n== voice session, %s; TV menu language Polish ==" % label)
    settings = {"name": NAME, "friendly_name": "LG Test", "wake_word": "ha"}   # Home Assistant detects the wake word
    if encryption:
        settings["api_key"] = base64.b64encode(os.urandom(32)).decode()      # as provisioned by Home Assistant
    else:
        settings["encryption"] = False
    fakes = {"luna-send": luna_send("pl-PL"), "pactl": PACTL, "parec": PAREC, "mpg123": player("mpg123"), "gst-play-1.0": player("gst-play-1.0")}
    with DaemonHarness(settings=settings, fakes=fakes) as d:
        client = APIClient("127.0.0.1", d.port, None, noise_psk=d.key if encryption else None, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        check(label + ": status file says encryption %s" % encryption, d.status().get("encryption") is encryption)
        ents, _ = await asyncio.wait_for(client.list_entities_services(), 10)
        names = sorted(e.name for e in ents)
        check(label + ": screen switch is named in the TV menu language (Ekran)", "Ekran" in names, names)
        check(label + ": language taken from the settings service", "language: TV menu pl-PL -> pl" in d.log(), d.log()[-400:])

        # hands-free: the daemon streams the USB microphone as soon as Home Assistant subscribes
        voice = Voice(client)
        check(label + ": daemon starts a wake word run", await wait_for(lambda: voice.starts, 25), d.log()[-600:])
        check(label + ": run asks for wake word + VAD (flags 3)", voice.starts[:1] == [3], voice.starts)
        await wait_for(lambda: len(voice.audio) >= 64000, 10)
        got = bytes(voice.audio)
        check(label + ": 2 s of microphone audio arrived (%d bytes)" % len(got), len(got) >= 64000)
        check(label + ": every sample arrived once, in order", continuous(got), got[:16].hex())

        # the pipeline's events drive the toasts on the TV
        client.send_voice_assistant_event(Ev.VOICE_ASSISTANT_WAKE_WORD_END, None)
        check(label + ": wake word -> Polish 'listening' toast", await wait_for(lambda: "Słucham…" in luna_log(d)), luna_log(d)[-300:])
        client.send_voice_assistant_event(Ev.VOICE_ASSISTANT_STT_END, {"text": "zażółć gęślą jaźń"})
        check(label + ": recognised text is shown", await wait_for(lambda: "zażółć gęślą jaźń" in luna_log(d)))
        client.send_voice_assistant_event(Ev.VOICE_ASSISTANT_ERROR, {"code": "stt-no-text-recognized", "message": "x"})
        check(label + ": error -> Polish toast", await wait_for(lambda: "Nie usłyszałem polecenia" in luna_log(d)), luna_log(d)[-300:])
        runs = len(voice.starts)
        client.send_voice_assistant_event(Ev.VOICE_ASSISTANT_RUN_END, None)
        check(label + ": after the run the daemon listens again", await wait_for(lambda: len(voice.starts) > runs, 10), d.log()[-400:])
        await wait_for(lambda: len(voice.audio) >= 16000, 10)
        check(label + ": audio of the next run is intact too", len(voice.audio) >= 16000 and continuous(bytes(voice.audio)))

        # announcement: Home Assistant -> TV, answered when playback (a fake player here) is over
        fin = await client.send_voice_assistant_announcement_await_response("http://127.0.0.1:9/tts.mp3", 10, "Kolacja gotowa")
        check(label + ": announcement finished with success", fin.success is True, fin)
        check(label + ": announcement text is shown", "Kolacja gotowa" in luna_log(d))
        # the player is started directly (no `timeout`: its options differ between BusyBox versions)
        check(label + ": MP3 played by mpg123 itself, at full volume",
              "mpg123 -q -f 32768 http://127.0.0.1:9/tts.mp3\n" in player_log(d), player_log(d))
        fin = await client.send_voice_assistant_announcement_await_response("http://127.0.0.1:9/tts.wav", 10, "Kolacja gotowa")
        check(label + ": WAV announcement played by gst-play-1.0 itself", fin.success is True and
              "gst-play-1.0 -q --volume=1 http://127.0.0.1:9/tts.wav\n" in player_log(d), (fin, player_log(d)))

        # language picked in the app (settings.json) applies without a restart
        s = d.read_settings(); s["lang"] = "de"
        with open(d.settings_path, "w") as f:
            json.dump(s, f)
        await wait_for(lambda: "settings: lang = de" in d.log(), 6)
        client.send_voice_assistant_timer_event(Tm.VOICE_ASSISTANT_TIMER_STARTED, "t1", "Pizza", 300, 300, True)
        check(label + ": language change applies live (German timer toast)",
              await wait_for(lambda: "Timer „Pizza“: 5 Min." in luna_log(d)), luna_log(d)[-300:])
        client.send_voice_assistant_timer_event(Tm.VOICE_ASSISTANT_TIMER_FINISHED, "t1", None, 300, 0, False)
        check(label + ": unnamed timer toast (German)", await wait_for(lambda: "Timer abgelaufen" in luna_log(d)), luna_log(d)[-300:])
        s.pop("lang")
        with open(d.settings_path, "w") as f:
            json.dump(s, f)
        check(label + ": back to automatic", await wait_for(lambda: "settings: lang = auto -> pl" in d.log(), 6), d.log()[-300:])

        await client.disconnect()
        check(label + ": daemon still running, nothing uncaught", d.proc.poll() is None and "uncaught" not in d.log() and "api: handler" not in d.log(),
              [l for l in d.log().splitlines() if "uncaught" in l or "handler" in l][:3])


def parec_playing(wav_paths, gap_s=2.0):
    """A fake parec that plays the given recordings (16 kHz mono) with silence around them, in real time,
    then stays silent."""
    files = " ".join(shlex.quote(p) for p in wav_paths)
    return ("#!/bin/sh\n"
            "exec python3 -u -c '\n"
            "import sys, time, wave\n"
            "def pcm(p):\n"
            "    w = wave.open(p, \"rb\"); return w.readframes(w.getnframes())\n"
            "gap = bytes(int(%f * 32000) & ~1)\n"
            "data = gap + b\"\".join(pcm(p) + gap for p in sys.argv[1:])\n"
            "t = time.time(); i = 0\n"
            "while True:\n"
            "    chunk = data[i:i + 640] if i < len(data) else bytes(640)\n"
            "    i += 640\n"
            "    sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()\n"
            "    t += 0.02; time.sleep(max(0, t - time.time()))\n"
            "' %s\n") % (gap_s, files)


async def local_wake_suite():
    print("\n== wake word detected on the TV (microWakeWord) ==")
    mww = os.environ.get("LGTV_ASSIST_MWW") or os.path.join(ROOT, "native", "build", "host", "mww")
    models = os.path.join(ROOT, "app", "daemon", "models")
    recordings = os.path.join(os.environ.get("MWW_DEPS") or os.path.join(ROOT, "native", ".deps"), "pymicro-wakeword", "tests")
    if not (os.path.exists(mww) and os.path.exists(os.path.join(models, "okay_nabu.tflite")) and os.path.isdir(recordings)):
        check("detector, models and recordings present (run native/build.sh host and webos)", False, (mww, models, recordings))
        return
    nabu = os.path.join(recordings, "okay_nabu", "1.wav")
    jarvis = os.path.join(recordings, "hey_jarvis", "1.wav")
    fakes = {"luna-send": luna_send("pl-PL"), "pactl": PACTL, "parec": parec_playing([jarvis, nabu])}
    with DaemonHarness(settings={"name": NAME, "api_key": base64.b64encode(os.urandom(32)).decode()}, fakes=fakes) as d:
        client = APIClient("127.0.0.1", d.port, None, noise_psk=d.key, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        check("status: wake word on the TV, Okay Nabu", (d.status().get("wake") or {}).get("on") == "tv" and d.status()["wake"].get("word") == "Okay Nabu", d.status().get("wake"))
        check("status lists the four models", sorted(m["id"] for m in d.status().get("wakeModels", [])) == ["alexa", "hey_jarvis", "hey_mycroft", "okay_nabu"], d.status().get("wakeModels"))
        voice = Voice(client)
        # 2 s silence, "hey jarvis" (must not wake), 2 s, "okay nabu" (must), ...
        check("nothing is sent to Home Assistant before the wake word", not await wait_for(lambda: voice.starts, 4.5) and not voice.audio, voice.starts)
        check("'Okay Nabu' starts a run on the TV's initiative", await wait_for(lambda: voice.starts, 8), d.log()[-500:])
        check("the run starts at speech-to-text (flags = VAD only)", voice.starts[:1] == [1], voice.starts)
        hits = re.findall(r"wake word: Okay Nabu \d", d.log())
        check("'Hey Jarvis' before it did not wake the TV (one detection, for 'Okay Nabu')", len(hits) == 1, d.log()[-600:])
        await wait_for(lambda: len(voice.audio) >= 32000, 5)
        check("audio after the wake word reaches Home Assistant (%d bytes)" % len(voice.audio), len(voice.audio) >= 32000)
        check("wake word -> Polish 'listening' toast", await wait_for(lambda: "Słucham…" in luna_log(d)), luna_log(d)[-300:])
        client.send_voice_assistant_event(Ev.VOICE_ASSISTANT_RUN_END, None)
        runs = len(voice.starts)
        await asyncio.sleep(3)
        check("after the run nothing more is sent until the next wake word", len(voice.starts) == runs, voice.starts)
        # switching the wake word to Home Assistant: the continuous stream comes back
        s = d.read_settings(); s["wake_word"] = "ha"
        with open(d.settings_path, "w") as f:
            json.dump(s, f)
        check("wake_word 'ha' -> Home Assistant gets a wake word run again", await wait_for(lambda: len(voice.starts) > runs and voice.starts[-1] == 3, 10), voice.starts)
        check("status: wake word by Home Assistant", (d.status().get("wake") or {}).get("on") == "ha", d.status().get("wake"))
        await client.disconnect()
        check("daemon alive, nothing uncaught", d.proc.poll() is None and "uncaught" not in d.log(), d.log()[-300:])

    # a detector that cannot run must not leave the TV deaf
    broken = {"luna-send": luna_send("pl-PL"), "pactl": PACTL, "parec": PAREC}
    os.environ["LGTV_ASSIST_MWW"] = "/bin/false"
    try:
        with DaemonHarness(settings={"name": NAME, "encryption": False}, fakes=broken) as d:
            client = APIClient("127.0.0.1", d.port, None, expected_name=NAME)
            await asyncio.wait_for(client.connect(login=True), 15)
            voice = Voice(client)
            ok = await wait_for(lambda: voice.starts and voice.starts[-1] == 3, 25)
            check("a detector that keeps failing -> falls back to Home Assistant's wake word", ok and "giving up on the detector" in d.log(), d.log()[-500:])
            await client.disconnect()
    finally:
        del os.environ["LGTV_ASSIST_MWW"]


async def language_suite():
    print("\n== language fallbacks ==")
    for title, settings, ui, want in [
        ("settings service answers es-ES", {}, "es-ES", "Pantalla"),
        ("settings service answers fr-FR (not translated)", {}, "fr-FR", "Screen"),
        ("no answer, locale reported by the app (de-DE)", {"tv_locale": "de-DE"}, None, "Bildschirm"),
        ("no answer, nothing known", {}, None, "Screen"),
        ("language picked in the app wins over the TV menu", {"lang": "en", "tv_locale": "pl-PL"}, "pl-PL", "Screen"),
    ]:
        with DaemonHarness(settings=dict(settings, name=NAME), fakes={"luna-send": luna_send(ui)}) as d:
            client = APIClient("127.0.0.1", d.port, None, expected_name=NAME)
            await asyncio.wait_for(client.connect(login=True), 15)
            ents, _ = await asyncio.wait_for(client.list_entities_services(), 10)
            names = sorted(e.name for e in ents)
            check(title + " -> " + want, want in names, names)
            await client.disconnect()


def tmpfile(d, name, text):
    p = os.path.join(d, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    return p


# What ls-monitor prints while the mic button is pressed (as on an LG CX, webOS 5.6): every message twice (TX, RX),
# the mic retrying twice, a cancel, and unrelated traffic
LS_MONITOR_LINES = [
    '82138.493 TX call 4 com.webos.surfacemanager (nfPnUocb) com.webos.service.voiceconductor (sKph4S9l) (null) //setInputEvent \u00ab{"event":"down","inputType":"hold"}\u00bb',
    '82138.495 RX call 4 com.webos.service.voiceconductor (sKph4S9l) com.webos.surfacemanager (nfPnUocb) (null) //setInputEvent \u00ab{"event":"down","inputType":"hold"}\u00bb',
    '82138.496 TX call 9 com.webos.app.home (aaaaaaaa) com.webos.service.tvpower (bbbbbbbb) (null) /power/getPowerState \u00ab{}\u00bb',
    '82138.505 TX call 64 com.webos.service.voiceconductor (sKph4S9l) com.webos.service.voiceinput (marXVmgu) (null) //startStreaming \u00ab{"keyType":"thinQtv"}\u00bb',
    '82138.505 RX call 64 com.webos.service.voiceinput (marXVmgu) com.webos.service.voiceconductor (sKph4S9l) (null) //startStreaming \u00ab{"keyType":"thinQtv"}\u00bb',
    '82138.567 TX call 65 com.webos.service.voiceconductor (sKph4S9l) com.webos.service.voiceinput (marXVmgu) /com/palm/luna/private/cancel \u00ab{"token":64}\u00bb',
    '82138.705 TX call 66 com.webos.service.voiceconductor (sKph4S9l) com.webos.service.voiceinput (marXVmgu) (null) //startStreaming \u00ab{"keyType":"thinQtv"}\u00bb',
]
LS_MONITOR = "#!/bin/sh\ncat <<'EOF'\n" + "\n".join(LS_MONITOR_LINES) + "\nEOF\nexec sleep 600\n"


async def diag_suite():
    """Diagnostics (status.diag) and the mic button path: every voiceconductor method declared in LG's API file is
    registered, requests are recorded with their sender, a press starts a push-to-talk run in Home Assistant, the
    system check finds Glasshouse, and the mic button test (SIGUSR2) reports what ls-monitor saw."""
    import signal
    import tempfile
    import time
    print("\n== diagnostics and the mic button ==")
    tmp = tempfile.mkdtemp(prefix="lgtv-diag-")
    api = tmpfile(tmp, "voiceconductor.api.json", json.dumps({"voiceconductor.api": [
        "com.webos.service.voiceconductor/setInputEvent", "com.webos.service.voiceconductor/recognizeVoice",
        "com.webos.service.voiceconductor/system/setInputEvent", "com.webos.service.voiceconductor/interactor/setContext",
        "com.webos.service.voiceconductor/*"]}))
    apps = os.path.join(tmp, "apps")
    os.makedirs(os.path.join(apps, "com.example.glasshouse"))
    os.makedirs(os.path.join(apps, "io.github.xrogers.lgtvassist"))
    env = {"LGTV_ASSIST_VC_API": api, "LGTV_ASSIST_APPS_DIR": apps, "LGTV_ASSIST_KEYTEST_S": "2"}
    fakes = {"luna-send": luna_send("en-GB"), "ls-monitor": LS_MONITOR}
    with DaemonHarness(settings={"name": NAME, "encryption": False}, fakes=fakes, env=env) as d:
        await wait_for(lambda: d.status().get("diag", {}).get("sys"), 5)
        st = d.status()["diag"]
        methods = d.luna_methods().get("com.webos.service.voiceconductor private", [])
        check("diag: holds the voiceconductor name", st["vc"]["held"] and st["vc"]["api"], st["vc"])
        check("diag: every method of LG's API file is registered (no wildcard), plus ours",
              set(methods) == {"/setInputEvent", "/recognizeVoice", "/system/setInputEvent", "/interactor/setContext",
                               "/getSupportedLanguages", "/system/getSupportedLanguages", "/interactor/register"}, methods)
        check("diag: same methods on the public bus", d.luna_methods().get("com.webos.service.voiceconductor public") == methods)
        check("diag: system check finds Glasshouse", st["sys"]["glasshouse"] == ["com.example.glasshouse"], st["sys"])

        client = APIClient("127.0.0.1", d.port, None, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        voice = Voice(client)
        await wait_for(lambda: "voice assistant subscribed" in d.log(), 5)
        d.luna_request("setInputEvent", {"event": "down", "inputType": "hold"})
        check("mic button down -> push-to-talk run starts in Home Assistant (flags 0)",
              await wait_for(lambda: voice.starts == [0], 5), voice.starts)
        check("mic button: logged with its sender", "key: mic down from com.webos.surfacemanager" in d.log())
        d.luna_request("setInputEvent", {"event": "up"}, category="/system", sender="com.webos.service.keyfilters")
        check("mic button up (on /system) -> logged", await wait_for(lambda: "key: mic up from com.webos.service.keyfilters" in d.log(), 5))
        k = d.status()["diag"]["keys"]
        check("diag: presses counted with the last sender", k["count"] == 2 and k["event"] == "up" and k["from"] == "com.webos.service.keyfilters", k)
        d.luna_request("recognizeVoice", {"subscribe": True}, sender="com.webos.app.browser")
        await wait_for(lambda: any(r["method"] == "/recognizeVoice" for r in d.luna_responses()), 5)
        r = [x for x in d.luna_responses() if x["method"] == "/recognizeVoice"]
        check("a declared method we don't implement: answered with an error, logged",
              r and r[0]["response"]["returnValue"] is False and "vc: /recognizeVoice from com.webos.app.browser" in d.log(), (r, d.log()[-300:]))
        d.luna_request("startSomethingNew", {})
        await wait_for(lambda: any(x["method"] == "/startSomethingNew" for x in d.luna_responses()), 5)
        r = [x for x in d.luna_responses() if x["method"] == "/startSomethingNew"]
        check("an undeclared method: the hub answers Unknown method", r and "Unknown method" in r[0]["response"]["errorText"], r)
        calls = d.status()["diag"]["calls"]
        check("diag: last requests, newest first, with sender and event",
              [c["m"] for c in calls][:3] == ["/recognizeVoice", "/system/setInputEvent", "/setInputEvent"] and calls[2]["event"] == "down", calls)

        os.kill(d.proc.pid, signal.SIGUSR2)
        check("mic button test: running", await wait_for(lambda: (d.status()["diag"].get("keyTest") or {}).get("state") == "running", 3))
        d.luna_request("setInputEvent", {"event": "down"})
        d.luna_request("setInputEvent", {"event": "up"})
        await wait_for(lambda: d.status()["diag"]["keyTest"]["state"] == "done", 6)
        kt = d.status()["diag"]["keyTest"]
        check("mic button test: counts the presses during the test", kt["keys"] == 2, kt)
        check("mic button test: keeps one copy of each voice message, without numbers, repeats counted",
              kt["monitor"] is True and kt["lines"] == [
                  'call com.webos.surfacemanager com.webos.service.voiceconductor //setInputEvent \u00ab{"event":"down","inputType":"hold"}\u00bb',
                  'call com.webos.service.voiceconductor com.webos.service.voiceinput //startStreaming \u00ab{"keyType":"thinQtv"}\u00bb (x2)'], kt)
        await client.disconnect()

    # no ls-monitor on the TV
    fakes["ls-monitor"] = "#!/bin/sh\nexit 127\n"
    with DaemonHarness(settings={"name": NAME, "encryption": False}, fakes=fakes, env=env) as d:
        os.kill(d.proc.pid, signal.SIGUSR2)
        time.sleep(0.5)
        await wait_for(lambda: (d.status()["diag"].get("keyTest") or {}).get("state") == "done", 6)
        kt = d.status()["diag"]["keyTest"]
        check("mic button test without ls-monitor: says so", kt["monitor"] is False and kt["keys"] == 0, kt)

    # the name is held by someone else: the attempts and the error are reported
    env2 = dict(env, LGTV_HARNESS_VC_TAKEN="1")
    with DaemonHarness(settings={"name": NAME, "encryption": False}, fakes=fakes, env=env2) as d:
        await wait_for(lambda: d.status().get("diag", {}).get("vc", {}).get("attempts", 0) >= 2, 6)
        vc = d.status()["diag"]["vc"]
        check("diag: name taken -> not held, attempts and error reported", not vc["held"] and vc["attempts"] >= 2 and "taken" in vc["error"], vc)
        check("log: name taken", "is taken" in d.log())


async def playback_limit_suite():
    """A player that never finishes is stopped after the limit, and the announcement still completes."""
    import time
    print("\n== playback limit ==")
    hang = "#!/bin/sh\necho $$ > \"$LGTV_HARNESS_DIR/tmp/player.pid\"\nexec sleep 600\n"
    with DaemonHarness(settings={"name": NAME, "encryption": False}, fakes={"luna-send": luna_send("en-GB"), "mpg123": hang},
                       env={"LGTV_ASSIST_PLAY_MAX_S": "1"}) as d:
        client = APIClient("127.0.0.1", d.port, None, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        t0 = time.time()
        fin = await client.send_voice_assistant_announcement_await_response("http://127.0.0.1:9/stream.mp3", 15, "Hello")
        took = time.time() - t0
        check("stuck player: announcement completes after the limit (%.1f s)" % took, fin.success is True and 0.8 < took < 6, (fin, took))
        check("stuck player: stop logged", "player: stopped after 1 s" in d.log(), d.log()[-400:])
        with open(os.path.join(d.dir, "tmp", "player.pid")) as f:
            pid = int(f.read())
        await asyncio.sleep(0.3)
        try:
            os.kill(pid, 0)
            gone = False
        except ProcessLookupError:
            gone = True
        check("stuck player: process is gone", gone, pid)
        await client.disconnect()


async def main():
    await session_suite(True)
    await session_suite(False)
    await local_wake_suite()
    await language_suite()
    await diag_suite()
    await playback_limit_suite()
    print("\n%d passed, %d failed" % (sum(results), len(results) - sum(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
