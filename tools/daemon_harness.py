"""Runs the REAL app/daemon/satellite.js on a dev machine (no TV needed), for smoke / interop tests.

    with DaemonHarness(settings={"encryption": True, "name": "lgtv-test"}) as d:
        d.port, d.key (api_key from settings.json, re-read on demand), d.log(), d.status(), d.mdns_packets()

What it fakes (all inside a private temp dir, nothing is written to /tmp/lgtv-assist.* or the TV paths):
  * `palmbus` (tools/daemon_harness/palmbus.js, on NODE_PATH)
  * luna-send / pactl / parec / amixer / mpg123 / gst-play-1.0 / timeout: executables that do nothing, first on PATH
  * LGTV_ASSIST_DATA (settings.json) and LGTV_ASSIST_TMP (log, status, pid files)
  * UDP multicast: tools/daemon_harness/preload.js stops the mDNS responder from touching the network and
    records what it would have sent
Node binary: $LGTV_NODE, else `node` from PATH.
"""
import base64
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SATELLITE = os.path.join(ROOT, "app", "daemon", "satellite.js")
FAKE_TOOLS = ["luna-send", "pactl", "parec", "amixer", "mpg123", "gst-play-1.0", "timeout"]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DaemonHarness:
    def __init__(self, settings=None, node=None, keep=False):
        self.settings = dict(settings or {})
        self.node = node or os.environ.get("LGTV_NODE") or shutil.which("node")
        self.keep = keep
        self.proc = None
        self.port = None
        self.dir = None

    # ---- paths
    @property
    def settings_path(self):
        return os.path.join(self.dir, "data", "settings.json")

    @property
    def log_path(self):
        return os.path.join(self.dir, "tmp", "lgtv-assist.log")

    def log(self):
        try:
            with open(self.log_path) as f:
                return f.read()
        except OSError:
            return ""

    def status(self):
        with open(os.path.join(self.dir, "tmp", "lgtv-assist.status.json")) as f:
            return json.load(f)

    def read_settings(self):
        with open(self.settings_path) as f:
            return json.load(f)

    @property
    def key(self):
        return self.read_settings().get("api_key")

    def mdns_packets(self):
        try:
            with open(os.path.join(self.dir, "tmp", "mdns.b64")) as f:
                return [base64.b64decode(line) for line in f if line.strip()]
        except OSError:
            return []

    # ---- lifecycle
    def start(self, timeout=15.0):
        self.dir = tempfile.mkdtemp(prefix="lgtv-harness-")
        for sub in ("data", "tmp", "bin"):
            os.mkdir(os.path.join(self.dir, sub))
        for tool in FAKE_TOOLS:
            p = os.path.join(self.dir, "bin", tool)
            with open(p, "w") as f:
                f.write("#!/bin/sh\nexit 0\n")
            os.chmod(p, 0o755)
        self.port = self.settings.setdefault("port", free_port())
        with open(self.settings_path, "w") as f:
            json.dump(self.settings, f)
        env = dict(os.environ)
        env.update({
            "PATH": os.path.join(self.dir, "bin") + os.pathsep + env.get("PATH", ""),
            "NODE_PATH": os.path.join(HERE, "daemon_harness"),
            "LGTV_ASSIST_DATA": os.path.join(self.dir, "data"),
            "LGTV_ASSIST_TMP": os.path.join(self.dir, "tmp", "lgtv-assist"),
            "LGTV_HARNESS_MDNS": os.path.join(self.dir, "tmp", "mdns.b64"),
        })
        self.proc = subprocess.Popen(
            [self.node, "-r", os.path.join(HERE, "daemon_harness", "preload.js"), SATELLITE],
            env=env, stdout=subprocess.DEVNULL, stderr=open(os.path.join(self.dir, "tmp", "stderr.txt"), "w"),
            cwd=self.dir, start_new_session=True)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("daemon exited early (%s)\n%s\n%s" % (self.proc.returncode, self.log(), self.stderr()))
            if "api: listening on" in self.log():
                return self
            time.sleep(0.05)
        self.stop()
        raise RuntimeError("daemon did not start in %ss\n%s" % (timeout, self.log()))

    def stderr(self):
        try:
            with open(os.path.join(self.dir, "tmp", "stderr.txt")) as f:
                return f.read()
        except OSError:
            return ""

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                    self.proc.wait(timeout=5)
                except Exception:
                    pass
        if self.dir and not self.keep:
            shutil.rmtree(self.dir, ignore_errors=True)

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()
