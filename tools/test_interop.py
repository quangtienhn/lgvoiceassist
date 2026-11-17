#!/usr/bin/env python3
"""Interoperability test: the REAL satellite daemon against the REAL aioesphomeapi client.

One command (any venv with aioesphomeapi; Node from PATH or $LGTV_NODE):

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install aioesphomeapi
    /tmp/venv/bin/python tools/test_interop.py            # exit code 0 = all passed

The daemon is started by tools/daemon_harness.py (stub palmbus, fake luna-send/pactl/..., temp dirs, no network
side effects): with a key set, without one (Home Assistant then hands it over, as it does to an ESPHome device),
and with encryption turned off.
"""
import asyncio
import base64
import os
import socket
import stat
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from daemon_harness import DaemonHarness  # noqa: E402

import aioesphomeapi  # noqa: E402
from aioesphomeapi import APIClient, ZERO_NOISE_PSK  # noqa: E402
from aioesphomeapi.api_pb2 import PingRequest, PingResponse  # noqa: E402
from aioesphomeapi.core import (  # noqa: E402
    BadNameAPIError,
    EncryptionPlaintextAPIError,
    InvalidEncryptionKeyAPIError,
    RequiresEncryptionAPIError,
)

NAME = "lgtv-test"
NOISE = "Noise_NNpsk0_25519_ChaChaPoly_SHA256"
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + (("  -- " + str(detail)) if detail and not ok else ""))


async def expect_error(name, exc_type, **kw):
    client = APIClient("127.0.0.1", kw.pop("port"), None, **kw)
    try:
        await asyncio.wait_for(client.connect(login=False, log_errors=False), 15)
    except Exception as e:  # noqa: BLE001
        check(name, type(e) is exc_type, "got %s: %s" % (type(e).__name__, e))
        return
    await client.disconnect()
    check(name, False, "connected without error")


async def ping(client, n=1):
    for _ in range(n):
        await asyncio.wait_for(client._get_connection().send_message_await_response(PingRequest(), PingResponse), 10)


def new_key():
    """A key the way Home Assistant makes one: base64 text of 32 random bytes."""
    return base64.b64encode(os.urandom(32)).decode()


def last_txt(d):
    """The TXT records of the most recent mDNS announcement."""
    pk = [p for p in d.mdns_packets() if b"friendly_name=" in p]
    return pk[-1] if pk else b""


async def encrypted_suite():
    print("\n== key set: only encrypted connections ==")
    key = new_key()
    with DaemonHarness(settings={"name": NAME, "friendly_name": "LG Test", "api_key": key, "mic_gain": 71}) as d:
        check("status file: encryption on, not provisionable", d.status().get("encryption") is True and d.status().get("provisionable") is False, d.status())
        check("key never appears in the log or status file", key not in d.log() and key not in open(os.path.join(d.dir, "tmp", "lgtv-assist.status.json")).read())

        # correct key
        client = APIClient("127.0.0.1", d.port, None, noise_psk=key, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        info = await client.device_info()
        check("correct key: device_info name", info.name == NAME, info.name)
        check("correct key: api_encryption_supported, not provisionable", info.api_encryption_supported is True and info.api_encryption_provisionable is False)
        check("correct key: friendly_name / mac / model", info.friendly_name == "LG Test" and len(info.mac_address) == 17 and "LG" in info.model, info)
        ents, services = await asyncio.wait_for(client.list_entities_services(), 15)
        kinds = sorted(type(e).__name__ for e in ents)
        check("correct key: entities (media player + screen switch)", kinds == ["MediaPlayerInfo", "SwitchInfo"], kinds)
        # larger exchange: nonce counters in both directions, many frames, concurrency
        for i in range(300):
            di = await asyncio.wait_for(client.device_info(), 10)
            if di.name != NAME:
                break
        check("300 sequential device_info() round trips stay consistent", i == 299 and di.name == NAME)
        await asyncio.gather(*[ping(client, 100) for _ in range(10)])
        check("1000 concurrent PingRequests answered", True)
        for _ in range(20):
            ents, _ = await asyncio.wait_for(client.list_entities_services(), 15)
        check("20 more entity listings (multi-frame replies) consistent", len(ents) == 2)
        # media player state frames (server-initiated) arrive too
        states = []
        client.subscribe_states(states.append)
        await asyncio.sleep(0.5)
        check("server-initiated frames after SubscribeStates (states received)", len(states) >= 1, states)
        await client.disconnect()

        # expected_name mismatch is detected from the server hello
        await expect_error("wrong expected_name -> BadNameAPIError", BadNameAPIError, port=d.port, noise_psk=key, expected_name="nope")
        # wrong key / zero key / no key
        await expect_error("wrong key -> InvalidEncryptionKeyAPIError", InvalidEncryptionKeyAPIError, port=d.port, noise_psk=new_key(), expected_name=NAME)
        await expect_error("all-zero provisioning key is refused once a key is set", InvalidEncryptionKeyAPIError, port=d.port, noise_psk=ZERO_NOISE_PSK, expected_name=NAME)
        await expect_error("no key (plaintext client) -> RequiresEncryptionAPIError", RequiresEncryptionAPIError, port=d.port)

        # hostile / broken peers must not take the daemon down
        for payload in (b"\x01\x00\x00" + b"\x01\x00\x31\x00" + os.urandom(48), b"\x01\xff\xff", os.urandom(300), b"\x01\x00\x00\x01\x00\x01\x00"):
            sk = socket.create_connection(("127.0.0.1", d.port))
            sk.sendall(payload)
            sk.settimeout(2)
            try:
                sk.recv(4096)
            except socket.timeout:
                pass
            sk.close()
        stall = socket.create_connection(("127.0.0.1", d.port))
        stall.sendall(b"\x01\x00\x00\x01\x00\x31\x00\x01")      # stalls mid-handshake, stays open
        await asyncio.sleep(0.3)
        client = APIClient("127.0.0.1", d.port, None, noise_psk=key, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        check("daemon still serves after garbage / stalled peers", (await client.device_info()).name == NAME)
        await client.disconnect()
        if "--slow" in sys.argv:
            stall.settimeout(30)
            t0 = asyncio.get_event_loop().time()

            def until_eof():
                got = b""
                while True:
                    chunk = stall.recv(4096)
                    if not chunk:
                        return got
                    got += chunk

            try:
                data = await asyncio.get_event_loop().run_in_executor(None, until_eof)
            except socket.timeout:
                data = None
            dt = asyncio.get_event_loop().time() - t0
            check("stalled handshake is closed by the daemon after ~20 s (--slow)", data is not None and 15 < dt < 28 and "handshake timeout" in d.log(), "%s %.1fs" % (data, dt))
        stall.close()
        check("daemon process still alive, no uncaught exception logged", d.proc.poll() is None and "uncaught" not in d.log(), d.log()[-500:])

        txt = last_txt(d)
        check("mDNS TXT advertises api_encryption=" + NOISE, ("api_encryption=" + NOISE).encode() in txt, "%d bytes captured" % len(txt))
        check("mDNS TXT: not provisionable", b"api_encryption_supported" not in txt and b"api_provisioning" not in txt)

        # a session that proved the key may replace it (all sessions are then closed) or remove it
        key2 = new_key()
        client = APIClient("127.0.0.1", d.port, None, noise_psk=key, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        check("key replaced over a session that proved the old key", await client.noise_encryption_set_key(key2.encode()) is True)
        await asyncio.sleep(0.6)
        await client.disconnect(force=True)
        await expect_error("old key no longer accepted", InvalidEncryptionKeyAPIError, port=d.port, noise_psk=key, expected_name=NAME)
        client = APIClient("127.0.0.1", d.port, None, noise_psk=key2, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        check("new key works and is stored", (await client.device_info()).name == NAME and d.key == key2 and d.read_settings().get("mic_gain") == 71)
        check("key removed (empty key) over a proven session", await client.noise_encryption_set_key(b"") is True)
        await asyncio.sleep(0.6)
        await client.disconnect(force=True)
        check("without a key the daemon is provisionable again", "api_key" not in d.read_settings() and d.status().get("provisionable") is True, d.status())
        client = APIClient("127.0.0.1", d.port, None, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        check("... and serves plaintext again", (await client.device_info()).api_encryption_provisionable is True)
        await client.disconnect()
        check("no key ever appears in the log", key not in d.log() and key2 not in d.log())


async def provisioning_suite():
    print("\n== no key yet: Home Assistant hands one over (zero-key Noise session) ==")
    with DaemonHarness(settings={"name": NAME, "friendly_name": "LG Test", "mic_gain": 71}) as d:
        check("status file: not encrypted, provisionable", d.status().get("encryption") is False and d.status().get("provisionable") is True, d.status())
        txt = last_txt(d)
        check("mDNS TXT: api_encryption_supported + api_provisioning=zero-psk", ("api_encryption_supported=" + NOISE).encode() in txt and b"api_provisioning=zero-psk" in txt, txt[-200:])
        check("mDNS TXT: no api_encryption= (Home Assistant would ask for a key)", b"api_encryption=" not in txt)

        # Home Assistant's main connection: plaintext, sees a device that can be given a key
        lost = asyncio.Event()

        async def on_stop(expected):
            lost.set()

        main = APIClient("127.0.0.1", d.port, None, expected_name=NAME)
        await asyncio.wait_for(main.connect(on_stop=on_stop, login=True), 15)
        info = await main.device_info()
        check("plaintext: api_encryption_supported and api_encryption_provisionable", info.api_encryption_supported is True and info.api_encryption_provisionable is True, info)
        ents, _ = await asyncio.wait_for(main.list_entities_services(), 15)
        check("plaintext: full API available while unprovisioned", len(ents) == 2)

        # unusable keys are refused and change nothing
        check("all-zero key refused", await main.noise_encryption_set_key(base64.b64encode(bytes(32))) is False)
        check("garbage key refused", await main.noise_encryption_set_key(b"not a key") is False)
        check("still unprovisioned after refused keys", "api_key" not in d.read_settings() and d.status().get("provisionable") is True)

        # what homeassistant/components/esphome/manager.py does: a second, short lived connection with the zero key
        key = new_key()
        prov = APIClient("127.0.0.1", d.port, None, noise_psk=ZERO_NOISE_PSK, expected_name=NAME)
        await asyncio.wait_for(prov.connect(), 15)
        check("key accepted over the zero-key Noise session", await prov.noise_encryption_set_key(key.encode()) is True)
        await prov.disconnect(force=True)
        try:
            await asyncio.wait_for(lost.wait(), 5)
        except asyncio.TimeoutError:
            pass
        check("the keyless main session is closed by the daemon", lost.is_set())
        await main.disconnect(force=True)

        s = d.read_settings()
        check("key stored, other settings preserved", s.get("api_key") == key and s.get("name") == NAME and s.get("mic_gain") == 71, {k: v for k, v in s.items() if k != "api_key"})
        check("settings.json is not readable by others", (os.stat(d.settings_path).st_mode & (stat.S_IRWXG | stat.S_IRWXO)) == 0)
        check("status file: encryption on", d.status().get("encryption") is True and d.status().get("provisionable") is False, d.status())
        check("key never appears in the log or status file", key not in d.log() and key not in open(os.path.join(d.dir, "tmp", "lgtv-assist.status.json")).read())
        txt = last_txt(d)
        check("mDNS re-announced with api_encryption=", ("api_encryption=" + NOISE).encode() in txt and b"api_provisioning" not in txt, txt[-200:])
        await expect_error("plaintext now refused -> RequiresEncryptionAPIError", RequiresEncryptionAPIError, port=d.port)
        await expect_error("zero key now refused -> InvalidEncryptionKeyAPIError", InvalidEncryptionKeyAPIError, port=d.port, noise_psk=ZERO_NOISE_PSK, expected_name=NAME)
        client = APIClient("127.0.0.1", d.port, None, noise_psk=key, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        info = await client.device_info()
        check("the new key works; no longer provisionable", info.name == NAME and info.api_encryption_supported is True and info.api_encryption_provisionable is False)
        await client.disconnect()
        check("daemon alive, no uncaught exception", d.proc.poll() is None and "uncaught" not in d.log(), d.log()[-400:])

    print("\n== no key yet: older Home Assistant sends the key over the plaintext session ==")
    with DaemonHarness(settings={"name": NAME}) as d:
        key = new_key()
        client = APIClient("127.0.0.1", d.port, None, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        check("key accepted over plaintext (deprecated path)", await client.noise_encryption_set_key(key.encode()) is True)
        await asyncio.sleep(0.6)
        await client.disconnect(force=True)
        await expect_error("plaintext refused afterwards", RequiresEncryptionAPIError, port=d.port)
        client = APIClient("127.0.0.1", d.port, None, noise_psk=key, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        check("the key works", (await client.device_info()).name == NAME)
        await client.disconnect()

    print("\n== unusable api_key in settings counts as no key ==")
    with DaemonHarness(settings={"name": NAME, "api_key": "not-a-valid-key"}) as d:
        check("treated as unprovisioned, and said so in the log", d.status().get("provisionable") is True and "not a usable key" in d.log(), d.log()[-300:])


async def plaintext_suite():
    print("\n== encryption turned off in the app ==")
    with DaemonHarness(settings={"name": NAME, "friendly_name": "LG Test", "encryption": False, "api_key": new_key()}) as d:
        check("status file: no encryption, not provisionable", d.status().get("encryption") is False and d.status().get("provisionable") is False, d.status())
        client = APIClient("127.0.0.1", d.port, None, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        info = await client.device_info()
        check("plaintext client: device_info works", info.name == NAME, info.name)
        check("encryption not announced (Home Assistant will not set a key)", info.api_encryption_supported is False and info.api_encryption_provisionable is False)
        ents, _ = await asyncio.wait_for(client.list_entities_services(), 15)
        check("plaintext client: entities", sorted(type(e).__name__ for e in ents) == ["MediaPlayerInfo", "SwitchInfo"])
        await asyncio.gather(*[ping(client, 50) for _ in range(5)])
        check("plaintext client: 250 concurrent pings", True)
        check("a key is refused while encryption is off", await client.noise_encryption_set_key(new_key().encode()) is False)
        await client.disconnect()
        await expect_error("key supplied to plaintext server -> EncryptionPlaintextAPIError", EncryptionPlaintextAPIError,
                           port=d.port, noise_psk=new_key(), expected_name=NAME)
        await expect_error("zero key supplied to plaintext server -> EncryptionPlaintextAPIError", EncryptionPlaintextAPIError,
                           port=d.port, noise_psk=ZERO_NOISE_PSK, expected_name=NAME)
        client = APIClient("127.0.0.1", d.port, None)
        await asyncio.wait_for(client.connect(login=True), 15)
        check("plaintext server still fine after rejected noise clients", (await client.device_info()).name == NAME)
        await client.disconnect()
        txt = last_txt(d)
        check("mDNS: no encryption TXT records when off", b"api_encryption" not in txt and b"api_provisioning" not in txt and len(txt) > 0, "%d bytes" % len(txt))
        check("daemon alive, no uncaught exception", d.proc.poll() is None and "uncaught" not in d.log())


async def main():
    from importlib.metadata import version
    print("aioesphomeapi", version("aioesphomeapi"), "| node:", os.environ.get("LGTV_NODE") or "PATH")
    await encrypted_suite()
    await provisioning_suite()
    await plaintext_suite()
    bad = results.count(False)
    print("\n%d passed, %d failed" % (len(results) - bad, bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
