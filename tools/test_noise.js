#!/usr/bin/env node
// Self-contained tests for app/daemon/lib/noise.js (X25519, ChaCha20-Poly1305, Poly1305, HKDF/HMAC and the
// ESPHome Noise_NNpsk0_25519_ChaChaPoly_SHA256 server transport). Plain node, no dependencies, Node >= 8.
// Usage: node tools/test_noise.js        (exit code 0 = all passed)
'use strict';
var path = require('path'), crypto = require('crypto');
var N = require(path.join(__dirname, '..', 'app', 'daemon', 'lib', 'noise.js'));

var passed = 0, failed = 0;
function hex(s) { return Buffer.from(s.replace(/\s+/g, ''), 'hex'); }
function check(name, ok, detail) {
  if (ok) { passed++; console.log('ok   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function eq(name, got, want) {
  var g = Buffer.isBuffer(got) ? got.toString('hex') : String(got), w = Buffer.isBuffer(want) ? want.toString('hex') : String(want);
  check(name, g === w, g === w ? '' : '\n       got  ' + g + '\n       want ' + w);
}

// ---------------------------------------------------------------- X25519 (RFC 7748)
eq('x25519 RFC7748 5.2 vector 1',
  N.x25519(hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'), hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')),
  hex('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552'));
eq('x25519 RFC7748 5.2 vector 2 (u has the top bit set)',
  N.x25519(hex('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d'), hex('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493')),
  hex('95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957'));
(function () {
  var k = Buffer.alloc(32), u = Buffer.alloc(32), t, i;
  k[0] = 9; u[0] = 9;
  for (i = 1; i <= 1000; i++) {
    t = N.x25519(k, u); u = k; k = t;
    if (i === 1) eq('x25519 RFC7748 5.2 iterated, 1 iteration', k, hex('422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079'));
  }
  eq('x25519 RFC7748 5.2 iterated, 1000 iterations', k, hex('684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51'));
})();
(function () {
  var ap = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'), bp = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  var apub = N.x25519Base(ap), bpub = N.x25519Base(bp);
  eq('x25519 RFC7748 6.1 Alice public', apub, hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'));
  eq('x25519 RFC7748 6.1 Bob public', bpub, hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'));
  var s = hex('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
  eq('x25519 RFC7748 6.1 shared (Alice side)', N.x25519(ap, bpub), s);
  eq('x25519 RFC7748 6.1 shared (Bob side)', N.x25519(bp, apub), s);
})();
eq('x25519 low order point (u=0) gives all zeros', N.x25519(crypto.randomBytes(32), Buffer.alloc(32)), Buffer.alloc(32));

// ---------------------------------------------------------------- ChaCha20 block (RFC 8439)
(function () {
  var key = Buffer.alloc(32), i;
  for (i = 0; i < 32; i++) key[i] = i;
  eq('chacha20 block RFC8439 2.3.2', N.chacha20Block(key, 1, hex('000000090000004a00000000')),
    hex('10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e' +
        'd2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e'));
  eq('chacha20 block RFC8439 A.1 #1 (zero key, counter 0)', N.chacha20Block(Buffer.alloc(32), 0, Buffer.alloc(12)),
    hex('76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7' +
        'da41597c5157488d7724e03fb8d84a376a43b8f41518a11cc387b669b2ee6586'));
  // counter must wrap correctly into the second block
  var two = N.chacha20Xor(key, 1, hex('000000090000004a00000000'), Buffer.alloc(128));
  eq('chacha20 xor spans two blocks', two.slice(64), N.chacha20Block(key, 2, hex('000000090000004a00000000')));
})();

// ---------------------------------------------------------------- Poly1305 (RFC 8439)
eq('poly1305 RFC8439 2.5.2', N.poly1305(hex('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b'),
  Buffer.from('Cryptographic Forum Research Group')), hex('a8061dc1305136c6c22b8baf0c0127a9'));
eq('poly1305 RFC8439 A.3 #1 (zero key, zero msg)', N.poly1305(Buffer.alloc(32), Buffer.alloc(64)), Buffer.alloc(16));
eq('poly1305 RFC8439 A.3 #5 (reduction wrap)', N.poly1305(hex('02' + '00'.repeat(15) + '00'.repeat(16)), hex('ff'.repeat(16))),
  hex('03' + '00'.repeat(15)));
eq('poly1305 RFC8439 A.3 #6', N.poly1305(hex('02' + '00'.repeat(15) + 'ff'.repeat(16)), hex('02' + '00'.repeat(15))),
  hex('03' + '00'.repeat(15)));
eq('poly1305 RFC8439 A.3 #7', N.poly1305(hex('01' + '00'.repeat(15) + '00'.repeat(16)), hex('ff'.repeat(16) + 'f0' + 'ff'.repeat(15) + '11' + '00'.repeat(15))),
  hex('05' + '00'.repeat(15)));
eq('poly1305 RFC8439 A.3 #8', N.poly1305(hex('01' + '00'.repeat(15) + '00'.repeat(16)), hex('ff'.repeat(16) + 'fb' + 'fe'.repeat(15) + '01'.repeat(16))),
  Buffer.alloc(16));

// ---------------------------------------------------------------- ChaCha20-Poly1305 AEAD (RFC 8439 2.8.2)
(function () {
  var pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  var aad = hex('50515253c0c1c2c3c4c5c6c7'), key = Buffer.alloc(32), i;
  for (i = 0; i < 32; i++) key[i] = 0x80 + i;
  var nonce = hex('070000004041424344454647');
  var ct = hex('d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6' +
    '3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36' +
    '92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc' +
    '3ff4def08e4b7a9de576d26586cec64b6116');
  var tag = hex('1ae10b594f09e26a7e902ecbd0600691');
  var sealed = N.aeadEncrypt(key, nonce, aad, pt);
  eq('aead RFC8439 2.8.2 ciphertext', sealed.slice(0, pt.length), ct);
  eq('aead RFC8439 2.8.2 tag', sealed.slice(pt.length), tag);
  eq('aead RFC8439 2.8.2 decrypt', N.aeadDecrypt(key, nonce, aad, sealed), pt);
  var t1 = Buffer.from(sealed); t1[t1.length - 1] ^= 1;
  check('aead rejects a tampered tag', N.aeadDecrypt(key, nonce, aad, t1) === null);
  var t2 = Buffer.from(sealed); t2[5] ^= 0x80;
  check('aead rejects a tampered ciphertext', N.aeadDecrypt(key, nonce, aad, t2) === null);
  var a2 = Buffer.from(aad); a2[0] ^= 1;
  check('aead rejects a different AAD', N.aeadDecrypt(key, nonce, a2, sealed) === null);
  var n2 = Buffer.from(nonce); n2[11] ^= 1;
  check('aead rejects a different nonce', N.aeadDecrypt(key, n2, aad, sealed) === null);
  check('aead rejects truncated input (<16 bytes)', N.aeadDecrypt(key, nonce, aad, sealed.slice(0, 15)) === null);
  // lengths around the 16 / 64 byte boundaries, with and without AAD: round trip + tamper
  var ok = true, len, a, s, d;
  for (len = 0; len <= 200; len++) {
    for (a = 0; a < 2; a++) {
      var m = crypto.randomBytes(len), ad = a ? crypto.randomBytes(len % 37) : null;
      s = N.aeadEncrypt(key, nonce, ad, m);
      d = N.aeadDecrypt(key, nonce, ad, s);
      if (!d || !d.equals(m)) ok = false;
      if (s.length) { s[s.length - 1 - (len % 16)] ^= 4; if (N.aeadDecrypt(key, nonce, ad, s) !== null) ok = false; }
    }
  }
  check('aead round trip + tamper for lengths 0..200 (with/without AAD)', ok);
})();

// ---------------------------------------------------------------- HMAC / HKDF as used by Noise
eq('hmac-sha256 RFC4231 case 1', N.hmacSha256(Buffer.alloc(20, 0x0b), Buffer.from('Hi There')),
  hex('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'));
(function () {
  // Noise HKDF(ck, ikm, 2) == RFC 5869 HKDF with empty info (T1 || T2); RFC 5869 test case 3 has an empty salt,
  // i.e. ck = 32 zero bytes
  var o = N.hkdf(Buffer.alloc(32), Buffer.alloc(22, 0x0b), 2);
  eq('hkdf RFC5869 test case 3 (T1||T2[0..10])', Buffer.concat([o[0], o[1]]).slice(0, 42),
    hex('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8'));
  var o3 = N.hkdf(Buffer.alloc(32, 7), Buffer.alloc(5, 1), 3);
  check('hkdf 3 outputs chain correctly',
    o3[0].equals(N.hmacSha256(N.hmacSha256(Buffer.alloc(32, 7), Buffer.alloc(5, 1)), Buffer.from([1]))) &&
    o3[2].equals(N.hmacSha256(N.hmacSha256(Buffer.alloc(32, 7), Buffer.alloc(5, 1)), o3[1], Buffer.from([3]))));
})();

// ---------------------------------------------------------------- key helpers
(function () {
  var k = N.generateKey();
  check('generateKey makes a parseable key', N.parseKey(k) !== null && N.parseKey(k).length === 32);
  check('parseKey rejects garbage', !N.parseKey('') && !N.parseKey(null) && !N.parseKey('abc') && !N.parseKey(k + 'A') &&
    !N.parseKey(Buffer.alloc(31, 1).toString('base64')) && !N.parseKey(Buffer.alloc(33, 1).toString('base64')) &&
    !N.parseKey(Buffer.alloc(32).toString('base64')));
})();

// ---------------------------------------------------------------- independent initiator (written from the Noise spec)
// Deliberately does not use the Responder / SymmetricState / Transport code under test; it only uses the
// primitives that are checked against published vectors above.
function Initiator(psk, helloPayload) {
  var self = this;
  function H(a, b) { return N.sha256(a, b); }
  this.nonceBuf = function (n) { var b = Buffer.alloc(12); b.writeUInt32LE(n % 4294967296, 4); b.writeUInt32LE(Math.floor(n / 4294967296), 8); return b; };
  var name = Buffer.from('Noise_NNpsk0_25519_ChaChaPoly_SHA256');
  var h = N.sha256(name), ck = h, k = null, n = 0;
  var lenb = Buffer.alloc(2); lenb.writeUInt16BE(helloPayload.length, 0);
  h = H(h, Buffer.concat([Buffer.from('NoiseAPIInit'), lenb, helloPayload]));
  function hk(ikm, cnt) {                       // HKDF per Noise spec section 4.3
    var tk = N.hmacSha256(ck, ikm), o1 = N.hmacSha256(tk, Buffer.from([1])), o2 = N.hmacSha256(tk, o1, Buffer.from([2]));
    return cnt === 2 ? [o1, o2] : [o1, o2, N.hmacSha256(tk, o2, Buffer.from([3]))];
  }
  this.msg1 = function () {
    var t = hk(psk, 3); ck = t[0]; h = H(h, t[1]); k = t[2]; n = 0;                 // psk0
    this.e = crypto.randomBytes(32); var pub = N.x25519Base(this.e);
    h = H(h, pub); t = hk(pub, 2); ck = t[0]; k = t[1]; n = 0;                      // e (+ MixKey because of psk)
    var ct = N.aeadEncrypt(k, this.nonceBuf(n++), h, Buffer.alloc(0)); h = H(h, ct);
    return Buffer.concat([pub, ct]);
  };
  this.readMsg2 = function (m) {
    if (m.length !== 48) throw new Error('msg2 length ' + m.length);
    var re = m.slice(0, 32); h = H(h, re); var t = hk(re, 2); ck = t[0]; k = t[1]; n = 0;
    t = hk(N.x25519(this.e, re), 2); ck = t[0]; k = t[1]; n = 0;                    // ee
    var pt = N.aeadDecrypt(k, this.nonceBuf(n++), h, m.slice(32));
    if (!pt) throw new Error('msg2 MAC failure');
    h = H(h, m.slice(32));
    var o = hk(Buffer.alloc(0), 2); self.send = o[0]; self.recv = o[1]; self.sn = 0; self.rn = 0;
  };
  this.encrypt = function (plain) { return N.aeadEncrypt(this.send, this.nonceBuf(this.sn++), null, plain); };
  this.decrypt = function (ct) { var p = N.aeadDecrypt(this.recv, this.nonceBuf(this.rn++), null, ct); if (!p) throw new Error('decrypt failure'); return p; };
}

function frame(p) { var f = Buffer.alloc(3 + p.length); f[0] = 1; f.writeUInt16BE(p.length, 1); p.copy(f, 3); return f; }
function parseFrames(buf) {
  var out = [], o = 0;
  while (buf.length - o >= 3) {
    if (buf[o] !== 1) { out.bad = true; break; }
    var l = buf.readUInt16BE(o + 1); if (buf.length - o < 3 + l) break;
    out.push(buf.slice(o + 3, o + 3 + l)); o += 3 + l;
  }
  return out;
}
function mkServer(psk, extra) {
  var s = { out: [], packets: [], closed: [], ready: 0 };
  s.t = new N.Transport({ psk: psk, name: 'lg-tv-assist', mac: 'aabbccddeeff',
    write: function (b) { s.out.push(Buffer.from(b)); }, onPacket: function (type, d) { s.packets.push([type, Buffer.from(d)]); },
    onClose: function (r) { s.closed.push(r); }, onReady: function () { s.ready++; } });
  s.take = function () { var b = Buffer.concat(s.out); s.out = []; return b; };
  return s;
}
function typed(type, payload) {                  // client -> server data frame, like aioesphomeapi make_noise_packets
  var hdr = Buffer.from([type >> 8, type & 255, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([hdr, payload]);
}

(function () {
  var psk = crypto.randomBytes(32), s = mkServer(psk), c = new Initiator(psk, Buffer.alloc(0));
  s.t.receive(Buffer.concat([Buffer.from([1, 0, 0]), frame(Buffer.concat([Buffer.from([0]), c.msg1()]))]));
  var fr = parseFrames(s.take());
  check('handshake: server sent hello + handshake frames', fr.length === 2 && s.ready === 1 && s.closed.length === 0);
  eq('handshake: server hello = 01 name 00 mac 00', fr[0], Buffer.concat([Buffer.from([1]), Buffer.from('lg-tv-assist'), Buffer.from([0]), Buffer.from('aabbccddeeff'), Buffer.from([0])]));
  check('handshake: handshake frame is 00 + 48 bytes', fr[1].length === 49 && fr[1][0] === 0);
  c.readMsg2(fr[1].slice(1));
  // client -> server, many messages (nonce counters, all sizes incl. ones that are not a multiple of 16)
  var i, ok = true, sizes = [0, 1, 15, 16, 17, 63, 64, 65, 255, 1000, 2048, 4000, 30000];
  for (i = 0; i < 300; i++) {
    var p = crypto.randomBytes(sizes[i % sizes.length]), type = (i * 37) & 0xffff;
    var f = frame(c.encrypt(typed(type, p)));
    s.t.receive(f);
    var got = s.packets[s.packets.length - 1];
    if (!got || got[0] !== type || !got[1].equals(p)) { ok = false; break; }
  }
  check('transport: 300 client->server messages decode (nonce counters in step)', ok && s.packets.length === 300 && s.closed.length === 0);
  // server -> client
  ok = true;
  for (i = 0; i < 300; i++) {
    var p2 = crypto.randomBytes(sizes[(i * 5) % sizes.length]), ty = (i * 101) & 0xffff;
    if (!s.t.send(ty, p2)) { ok = false; break; }
    var ff = parseFrames(s.take());
    var plain = c.decrypt(ff[0]);
    if (ff.length !== 1 || plain.readUInt16BE(0) !== ty || plain.readUInt16BE(2) !== p2.length || !plain.slice(4).equals(p2)) { ok = false; break; }
  }
  check('transport: 300 server->client messages decrypt with the independent initiator', ok);
  check('transport: oversize message refused, not thrown', s.t.send(1, Buffer.alloc(70000)) === false && !s.t.isClosed());
  // tamper
  var bad = frame(c.encrypt(typed(7, Buffer.from('x')))); bad[bad.length - 1] ^= 1;
  s.t.receive(bad);
  check('transport: tampered data frame closes the connection once', s.closed.length === 1 && /decrypt/.test(s.closed[0]) && s.t.isClosed());
  s.t.receive(crypto.randomBytes(100));
  check('transport: data after close is ignored', s.closed.length === 1);
})();

// byte-by-byte delivery + bytes split anywhere
(function () {
  var psk = crypto.randomBytes(32), s = mkServer(psk), c = new Initiator(psk, Buffer.alloc(0)), i;
  var wire = Buffer.concat([Buffer.from([1, 0, 0]), frame(Buffer.concat([Buffer.from([0]), c.msg1()]))]);
  for (i = 0; i < wire.length; i++) s.t.receive(wire.slice(i, i + 1));
  var fr = parseFrames(s.take()); c.readMsg2(fr[1].slice(1));
  var data = Buffer.concat([frame(c.encrypt(typed(9, Buffer.from('abc')))), frame(c.encrypt(typed(10, Buffer.alloc(0)))), frame(c.encrypt(typed(11, Buffer.alloc(500, 5))))]);
  for (i = 0; i < data.length; i++) s.t.receive(data.slice(i, i + 1));
  check('transport: 1-byte chunks (handshake and data) work', s.ready === 1 && s.packets.length === 3 && s.packets[2][0] === 11 && s.packets[2][1].length === 500 && s.closed.length === 0);
  // three frames in a single chunk
  var s2 = mkServer(psk), c2 = new Initiator(psk, Buffer.alloc(0));
  s2.t.receive(Buffer.concat([wire.slice(0, 3), frame(Buffer.concat([Buffer.from([0]), c2.msg1()]))]));
  c2.readMsg2(parseFrames(s2.take())[1].slice(1));
  s2.t.receive(Buffer.concat([frame(c2.encrypt(typed(1, Buffer.from('a')))), frame(c2.encrypt(typed(2, Buffer.from('b'))))]));
  check('transport: two frames in one chunk', s2.packets.length === 2 && s2.packets[1][0] === 2);
})();

// non-empty client hello payload goes into the prologue
(function () {
  var psk = crypto.randomBytes(32), hello = Buffer.from('flags'), s = mkServer(psk), c = new Initiator(psk, hello);
  s.t.receive(Buffer.concat([frame(hello), frame(Buffer.concat([Buffer.from([0]), c.msg1()]))]));
  c.readMsg2(parseFrames(s.take())[1].slice(1));
  s.t.receive(frame(c.encrypt(typed(5, Buffer.from('hi')))));
  check('prologue includes the client hello length and payload', s.packets.length === 1 && s.packets[0][0] === 5);
  var s2 = mkServer(psk), c2 = new Initiator(psk, Buffer.alloc(0));
  s2.t.receive(Buffer.concat([frame(hello), frame(Buffer.concat([Buffer.from([0]), c2.msg1()]))]));
  var out = parseFrames(s2.take());
  check('prologue mismatch is a MAC failure reject', s2.closed.length === 1 && out[out.length - 1].toString('latin1') === '\x01Handshake MAC failure');
})();

// wrong key
(function () {
  var s = mkServer(crypto.randomBytes(32)), c = new Initiator(crypto.randomBytes(32), Buffer.alloc(0));
  s.t.receive(Buffer.concat([Buffer.from([1, 0, 0]), frame(Buffer.concat([Buffer.from([0]), c.msg1()]))]));
  var fr = parseFrames(s.take());
  check('wrong psk: hello then reject frame "\\x01Handshake MAC failure"', fr.length === 2 && fr[1].toString('latin1') === '\x01Handshake MAC failure' && s.closed.length === 1 && s.ready === 0);
})();

// protocol errors
(function () {
  var psk = crypto.randomBytes(32), s, fr;
  // plaintext client (what aioesphomeapi sends first: 00 len type protobuf)
  s = mkServer(psk); s.t.receive(Buffer.from('00 11 01 0a 0d 61 69 6f 65 73 70 68 6f 6d 65 61 70 69'.replace(/ /g, ''), 'hex'));
  fr = s.take();
  eq('plaintext client: reply is a noise reject frame starting with 0x01 (RequiresEncryption)', fr, Buffer.concat([Buffer.from([1, 0, 19, 1]), Buffer.from('Bad indicator byte')]));
  check('plaintext client: connection closed', s.closed.length === 1);
  s = mkServer(psk); s.t.receive(Buffer.from([0x00])); check('plaintext client: even a single byte is rejected', s.closed.length === 1 && s.take()[0] === 1);
  // oversized handshake frame
  s = mkServer(psk); s.t.receive(Buffer.from([1, 0, 129]));
  fr = s.take(); check('oversized hello frame: rejected', s.closed.length === 1 && fr.toString('latin1').indexOf('Bad handshake packet len') > 0);
  // empty / bad status handshake frames
  s = mkServer(psk); s.t.receive(Buffer.from([1, 0, 0, 1, 0, 0])); fr = s.take();
  check('empty handshake frame: rejected', s.closed.length === 1 && fr.toString('latin1').indexOf('Empty handshake message') > 0);
  s = mkServer(psk); s.t.receive(Buffer.from([1, 0, 0, 1, 0, 2, 7, 7])); fr = s.take();
  check('bad handshake status byte: rejected', s.closed.length === 1 && fr.toString('latin1').indexOf('Bad handshake error byte') > 0);
  s = mkServer(psk); s.t.receive(Buffer.concat([Buffer.from([1, 0, 0]), frame(Buffer.concat([Buffer.from([0]), crypto.randomBytes(20)]))])); fr = s.take();
  check('short handshake message: rejected with "Handshake error"', s.closed.length === 1 && fr.toString('latin1').indexOf('Handshake error') > 0);
  // stalled mid-handshake: nothing is thrown, nothing is closed by the transport itself (timeout is the caller's job)
  s = mkServer(psk); s.t.receive(Buffer.from([1, 0, 0, 1, 0, 49, 0, 1, 2]));
  check('stalled partial handshake frame: kept pending, no close', s.closed.length === 0 && !s.t.isReady());
  // garbage fuzz: never throws, closes at most once
  var thrown = 0, i, j;
  for (i = 0; i < 300; i++) {
    s = mkServer(psk);
    try {
      for (j = 0; j < 4; j++) s.t.receive(Buffer.concat([Buffer.from([1, 0, 0]), crypto.randomBytes(1 + (i * 7 + j) % 60)]).slice(0, 1 + (i % 70)));
    } catch (e) { thrown++; }
    if (s.closed.length > 1) thrown++;
  }
  check('fuzz: random bytes never throw / double close', thrown === 0);
  // oversized data frame after a real handshake
  var c = new Initiator(psk, Buffer.alloc(0)); s = mkServer(psk);
  s.t.receive(Buffer.concat([Buffer.from([1, 0, 0]), frame(Buffer.concat([Buffer.from([0]), c.msg1()]))]));
  c.readMsg2(parseFrames(s.take())[1].slice(1));
  s.t.receive(Buffer.from([1, 0xff, 0xff]));
  check('oversized data frame (65535): closed', s.closed.length === 1 && /too large/.test(s.closed[0]));
  // data_len lies about the content
  c = new Initiator(psk, Buffer.alloc(0)); s = mkServer(psk);
  s.t.receive(Buffer.concat([Buffer.from([1, 0, 0]), frame(Buffer.concat([Buffer.from([0]), c.msg1()]))]));
  c.readMsg2(parseFrames(s.take())[1].slice(1));
  s.t.receive(frame(c.encrypt(Buffer.from([0, 1, 0, 50, 1, 2, 3]))));
  check('inner length larger than the message: closed', s.closed.length === 1 && /bad data length/.test(s.closed[0]));
  c = new Initiator(psk, Buffer.alloc(0)); s = mkServer(psk);
  s.t.receive(Buffer.concat([Buffer.from([1, 0, 0]), frame(Buffer.concat([Buffer.from([0]), c.msg1()]))]));
  c.readMsg2(parseFrames(s.take())[1].slice(1));
  s.t.receive(frame(c.encrypt(Buffer.from([0, 1, 0]))));
  check('decrypted message shorter than 4 bytes: closed', s.closed.length === 1 && /too short/.test(s.closed[0]));
  // replayed frame (nonce already used) must not decrypt
  c = new Initiator(psk, Buffer.alloc(0)); s = mkServer(psk);
  s.t.receive(Buffer.concat([Buffer.from([1, 0, 0]), frame(Buffer.concat([Buffer.from([0]), c.msg1()]))]));
  c.readMsg2(parseFrames(s.take())[1].slice(1));
  var one = frame(c.encrypt(typed(3, Buffer.from('z'))));
  s.t.receive(one); s.t.receive(one);
  check('replayed frame is rejected', s.packets.length === 1 && s.closed.length === 1);
})();

// ---------------------------------------------------------------- benchmark
(function () {
  var cs = new N.CipherState(crypto.randomBytes(32)), buf = Buffer.alloc(2048 + 16, 3), i, t0, n = 4000, dt;
  for (i = 0; i < 200; i++) cs.seal(null, buf, 0, 2048);
  t0 = process.hrtime();
  for (i = 0; i < n; i++) cs.seal(null, buf, 0, 2048);
  dt = process.hrtime(t0); dt = dt[0] + dt[1] / 1e9;
  console.log('bench: ChaCha20-Poly1305 seal, 2048-byte messages: ' + (n * 2048 / 1048576 / dt).toFixed(2) + ' MB/s (' + (dt / n * 1e6).toFixed(1) + ' us/message)');
  var d = new N.CipherState(Buffer.alloc(32, 1)), e = new N.CipherState(Buffer.alloc(32, 1));
  var tmp = Buffer.alloc(2048 + 16, 9);
  for (i = 0; i < 200; i++) { e.seal(null, tmp, 0, 2048); d.open(null, tmp, 0, 2048 + 16); }
  t0 = process.hrtime();
  for (i = 0; i < n; i++) { e.seal(null, tmp, 0, 2048); d.open(null, tmp, 0, 2048 + 16); }
  dt = process.hrtime(t0); dt = dt[0] + dt[1] / 1e9;
  console.log('bench: seal+open round trip, 2048-byte messages: ' + (n * 2048 / 1048576 / dt).toFixed(2) + ' MB/s each way');
  var k = crypto.randomBytes(32), u = N.x25519Base(k), m = 60;
  for (i = 0; i < 5; i++) u = N.x25519(k, u);
  t0 = process.hrtime();
  for (i = 0; i < m; i++) u = N.x25519(k, u);
  dt = process.hrtime(t0); dt = dt[0] + dt[1] / 1e9;
  console.log('bench: X25519 scalar multiplication: ' + (dt / m * 1000).toFixed(2) + ' ms/op (a handshake needs 2)');
  console.log('bench: node ' + process.version + ' ' + process.arch);
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
