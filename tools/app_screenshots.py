#!/usr/bin/env python3
"""Renders the app's screens for the README (docs/screenshots/app-*.png) at the TV's 1920x1080.

The real app/index.html runs in Chromium with a stand-in for the TV's luna bus that answers `status` with the
example states below (made-up addresses), so the pictures always match the current UI and translations.

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install playwright && /tmp/venv/bin/playwright install chromium
    /tmp/venv/bin/python tools/app_screenshots.py [--lang en] [--chrome /path/to/chrome]
"""
import argparse
import json
import os

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "screenshots")

with open(os.path.join(ROOT, "app", "appinfo.json"), encoding="utf-8") as f:
    VERSION = json.load(f)["version"]

DAEMON = {"version": VERSION, "ip": "192.168.1.50", "port": 6053, "name": "lg-tv-assist", "encryption": True,
          "usbMic": "alsa_input.usb-C-Media_Electronics_Inc._USB_PnP_Sound_Device-00.analog-mono", "listening": True,
          "wake": {"on": "tv", "id": "okay_nabu", "word": "Okay Nabu"},
          "wakeModels": [{"id": m, "word": w} for m, w in (("alexa", "Alexa"), ("hey_jarvis", "Hey Jarvis"),
                                                           ("hey_mycroft", "Hey Mycroft"), ("okay_nabu", "Okay Nabu"))]}
RUNNING = {"returnValue": True, "root": True, "enabled": True, "running": True, "hookInstalled": True,
           "settings": {"friendly_name": "LG TV", "has_key": True},
           "daemon": dict(DAEMON, ha="Home Assistant 2026.11.2 @ 192.168.1.10",
                          lastText="Turn on the lights in the living room and set a timer for ten minutes",
                          lastReply="Turned on the lights. Timer set for 10 minutes."),
           "nospy": {"installed": False}}
DIAG = {"vc": {"held": True, "since": "2026-11-20T18:00:02.000Z", "attempts": 0, "error": None, "methods": 31, "api": True},
        "keys": {"count": 6, "last": None, "event": "up", "from": "com.webos.surfacemanager"},
        "calls": [{"t": "2026-11-20T18:41:07.512Z", "m": "/setInputEvent", "from": "com.webos.surfacemanager", "event": "up"},
                  {"t": "2026-11-20T18:41:05.904Z", "m": "/setInputEvent", "from": "com.webos.surfacemanager", "event": "down"}],
        "mic": {"at": None, "openMs": 38, "socket": "/tmp/voiceinput_remote1.soc", "bytes": 52480, "error": None},
        "sys": {"lgVc": [], "vcBin": True, "vcStub": True, "vi": [1234], "viStub": False, "viMasked": False, "hid": False,
                "hidRun": [], "hidMasked": False, "glasshouse": []},
        "platform": {"webos": "5.6.2", "sdkVersion": "5.6.2", "modelName": "OLED55CX6LA", "firmwareVersion": "04.30.75"},
        "keyTest": {"state": "done", "started": None, "seconds": 12, "keys": 2, "monitor": True, "lines": [
            "call com.webos.surfacemanager com.webos.service.voiceconductor /setInputEvent «{\"event\":\"down\",\"inputType\":\"hold\"}»",
            "call com.webos.service.voiceconductor com.webos.service.voiceinput /startStreaming «{\"keyType\":\"thinQtv\",\"subscribe\":true}»",
            "call com.webos.surfacemanager com.webos.service.voiceconductor /setInputEvent «{\"event\":\"up\",\"inputType\":\"hold\"}»"]}}

STATES = {
    # right after installing: the service has no root yet
    "app-first-run": {"returnValue": False, "errorText": "not running as root", "notRoot": True},
    # running, Home Assistant has not added the TV yet
    "app-waiting": dict(RUNNING, settings={"friendly_name": "LG TV", "has_key": False},
                        daemon=dict(DAEMON, encryption=False, listening=False)),
    # added to Home Assistant, USB microphone, wake word detected on the TV
    "app-running": RUNNING,
    # the Diagnostics panel after a mic button test
    "app-diagnostics": dict(RUNNING, daemon=dict(RUNNING["daemon"], diag=DIAG)),
}
OPEN = {"app-diagnostics": "#b-diag"}   # a button to select before the picture



def fill_times(status):
    """Times in the examples, relative to the moment of rendering."""
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc)

    def iso(sec):
        return (now + datetime.timedelta(seconds=sec)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    d = status.get("daemon")
    if d:
        d.setdefault("started", iso(-3 * 3600))
        g = d.get("diag")
        if g:
            g["keys"]["last"] = iso(-95)
            g["mic"]["at"] = iso(-97)
            g["keyTest"]["started"] = iso(-20)
            g["calls"][0]["t"], g["calls"][1]["t"] = iso(-95), iso(-97)
    return status

MOCK = """
window.PalmSystem = { locale: %(locale)s };
window.PalmServiceBridge = function () {};
window.PalmServiceBridge.prototype.call = function (uri, params) {
  var self = this, r = /\\/status$/.test(uri) ? %(status)s : { returnValue: true };
  setTimeout(function () { self.onservicecallback(JSON.stringify(r)); }, 5);
};
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="en", help="TV menu language the app sees (en, pl, de, es)")
    ap.add_argument("--chrome", help="Chromium binary (default: the one Playwright installed)")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=args.chrome) if args.chrome else pw.chromium.launch()
        for name, status in STATES.items():
            page = br.new_page(viewport={"width": 1920, "height": 1080})
            page.add_init_script(MOCK % {"locale": json.dumps(args.lang), "status": json.dumps(fill_times(json.loads(json.dumps(status))))})
            page.goto("file://" + os.path.join(ROOT, "app", "index.html"))
            page.wait_for_timeout(300)
            if name in OPEN:
                page.click(OPEN[name])
                page.wait_for_timeout(300)
            path = os.path.join(OUT, name + ".png")
            page.screenshot(path=path)
            print(path)
            page.close()
        br.close()


if __name__ == "__main__":
    main()
