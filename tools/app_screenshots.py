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
STATES = {
    # right after installing: the service has no root yet
    "app-first-run": {"returnValue": False, "errorText": "not running as root", "notRoot": True},
    # running, Home Assistant has not added the TV yet
    "app-waiting": dict(RUNNING, settings={"friendly_name": "LG TV", "has_key": False},
                        daemon=dict(DAEMON, encryption=False, listening=False)),
    # added to Home Assistant, USB microphone, wake word detected on the TV
    "app-running": RUNNING,
}

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
            page.add_init_script(MOCK % {"locale": json.dumps(args.lang), "status": json.dumps(status)})
            page.goto("file://" + os.path.join(ROOT, "app", "index.html"))
            page.wait_for_timeout(300)
            path = os.path.join(OUT, name + ".png")
            page.screenshot(path=path)
            print(path)
            page.close()
        br.close()


if __name__ == "__main__":
    main()
