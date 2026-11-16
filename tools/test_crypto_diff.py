#!/usr/bin/env python3
"""Differential test of app/daemon/lib/noise.js primitives against Python's `cryptography` (random inputs).

    /tmp/venv/bin/python tools/test_crypto_diff.py     # needs `cryptography` (a dependency of aioesphomeapi) and node
"""
import json
import os
import subprocess
import sys

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = os.environ.get("LGTV_NODE", "node")
JS = r"""
var N = require(process.argv[1] + '/app/daemon/lib/noise.js'), cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
var h = function (s) { return Buffer.from(s, 'hex'); };
console.log(JSON.stringify(cases.map(function (c) {
  if (c.t === 'x') return N.x25519(h(c.k), h(c.u)).toString('hex');
  var aad = c.aad === null ? null : h(c.aad);
  return N.aeadEncrypt(h(c.k), h(c.n), aad, h(c.m)).toString('hex');
})));
"""


def main():
    cases, want = [], []
    for _ in range(300):
        k, u = os.urandom(32), os.urandom(32)
        cases.append({"t": "x", "k": k.hex(), "u": u.hex()})
        # python reference: X25519 with the (clamped by the library) scalar and an arbitrary u
        want.append(X25519PrivateKey.from_private_bytes(k).exchange(X25519PublicKey.from_public_bytes(u)).hex())
    for i in range(600):
        k, n, m = os.urandom(32), os.urandom(12), os.urandom(i % 300)
        aad = None if i % 3 == 0 else os.urandom(i % 50)
        cases.append({"t": "a", "k": k.hex(), "n": n.hex(), "m": m.hex(), "aad": aad.hex() if aad is not None else None})
        want.append(ChaCha20Poly1305(k).encrypt(n, m, aad).hex())
    out = subprocess.run([NODE, "-e", JS, ROOT], input=json.dumps(cases).encode(), stdout=subprocess.PIPE, check=True).stdout
    got = json.loads(out)
    bad = [i for i in range(len(want)) if got[i] != want[i]]
    print("%d cases (300 X25519, 600 ChaCha20-Poly1305), %d mismatches" % (len(want), len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
