// ESPHome native API encryption (server side): Noise_NNpsk0_25519_ChaChaPoly_SHA256 in pure JavaScript.
//
// The TV runs Node 8 / OpenSSL 1.0.2, which has neither X25519 nor ChaCha20-Poly1305, so both are done here
// (typed arrays, no BigInt, no dependencies). SHA-256 and HMAC come from Node's crypto.
//
// Sources and licences:
//  * X25519: field arithmetic (gf = Float64Array(16), car25519/sel25519/pack25519/inv25519, Montgomery
//    ladder) follows TweetNaCl (D. J. Bernstein, T. Lange, P. Schwabe et al., public domain) as ported in
//    tweetnacl-js (Unlicense / public domain).
//  * Poly1305: 13-bit limb representation (10 limbs, 2^130-5) as in poly1305-donna-16 (public domain) and
//    tweetnacl-js; the multiplication and carries are written here as loops.
//  * ChaCha20: RFC 8439 block function, written out here (round code generated, unrolled).
//  * Noise state machine and ESPHome framing: written from the Noise spec (rev 34) and the ESPHome /
//    aioesphomeapi sources (api_frame_helper_noise.cpp, aioesphomeapi/_frame_helper/noise.py).
// Everything in this file is released under the project's MIT licence.
//
// Wire format (ESPHome): frame = 0x01, uint16 BE length, payload.
//   client -> server: hello frame (payload normally empty), then handshake frame (0x00 + Noise message 1)
//   server -> client: hello frame (0x01, name\0, mac\0), then handshake frame (0x00 + Noise message 2)
//   afterwards every frame is encrypt(type_hi, type_lo, len_hi, len_lo, protobuf bytes).
//   Prologue = "NoiseAPIInit" + uint16 BE length of the client hello frame + its payload.
//   A rejected handshake is a frame whose payload is 0x01 + ASCII reason ("Handshake MAC failure" means
//   "wrong key" to aioesphomeapi).
'use strict';
var crypto = require('crypto');

// ====================================================================== X25519
function gf(init) {
  var r = new Float64Array(16), i;
  if (init) for (i = 0; i < init.length; i++) r[i] = init[i];
  return r;
}
var _121665 = gf([0xdb41, 1]);
var GT = new Float64Array(31);   // scratch for M()

function car25519(o) {
  var i, v, c = 1;
  for (i = 0; i < 16; i++) {
    v = o[i] + c + 65535;
    c = Math.floor(v / 65536);
    o[i] = v - c * 65536;
  }
  o[0] += c - 1 + 37 * (c - 1);
}
function sel25519(p, q, b) {
  var t, c = ~(b - 1), i;
  for (i = 0; i < 16; i++) { t = c & (p[i] ^ q[i]); p[i] ^= t; q[i] ^= t; }
}
function pack25519(o, n) {
  var i, j, b, m = gf(), t = gf();
  for (i = 0; i < 16; i++) t[i] = n[i];
  car25519(t); car25519(t); car25519(t);
  for (j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (i = 1; i < 15; i++) {
      m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
      m[i - 1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    b = (m[15] >> 16) & 1;
    m[14] &= 0xffff;
    sel25519(t, m, 1 - b);
  }
  for (i = 0; i < 16; i++) { o[2 * i] = t[i] & 0xff; o[2 * i + 1] = t[i] >> 8; }
}
function unpack25519(o, n) {
  for (var i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
  o[15] &= 0x7fff;
}
function A(o, a, b) { for (var i = 0; i < 16; i++) o[i] = a[i] + b[i]; }
function Z(o, a, b) { for (var i = 0; i < 16; i++) o[i] = a[i] - b[i]; }
function M(o, a, b) {
  var i, j, t = GT, ai;
  for (i = 0; i < 31; i++) t[i] = 0;
  for (i = 0; i < 16; i++) { ai = a[i]; for (j = 0; j < 16; j++) t[i + j] += ai * b[j]; }
  for (i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
  for (i = 0; i < 16; i++) o[i] = t[i];
  car25519(o); car25519(o);
}
function S(o, a) { M(o, a, a); }
function inv25519(o, i) {
  var c = gf(), a;
  for (a = 0; a < 16; a++) c[a] = i[a];
  for (a = 253; a >= 0; a--) { S(c, c); if (a !== 2 && a !== 4) M(c, c, i); }
  for (a = 0; a < 16; a++) o[a] = c[a];
}

// q = n * p on Curve25519 (all Uint8Array(32)); n is clamped as RFC 7748 requires, the top bit of p is ignored.
function scalarmult(q, n, p) {
  var z = new Uint8Array(32), x = new Float64Array(80), r, i;
  var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf();
  for (i = 0; i < 31; i++) z[i] = n[i];
  z[31] = (n[31] & 127) | 64;
  z[0] &= 248;
  unpack25519(x, p);
  for (i = 0; i < 16; i++) { b[i] = x[i]; d[i] = a[i] = c[i] = 0; }
  a[0] = d[0] = 1;
  for (i = 254; i >= 0; --i) {
    r = (z[i >>> 3] >>> (i & 7)) & 1;
    sel25519(a, b, r); sel25519(c, d, r);
    A(e, a, c); Z(a, a, c); A(c, b, d); Z(b, b, d);
    S(d, e); S(f, a); M(a, c, a); M(c, b, e);
    A(e, a, c); Z(a, a, c); S(b, a); Z(c, d, f);
    M(a, c, _121665); A(a, a, d); M(c, c, a);
    M(a, d, f); M(d, b, x); S(b, e);
    sel25519(a, b, r); sel25519(c, d, r);
  }
  for (i = 0; i < 16; i++) { x[i + 16] = a[i]; x[i + 32] = c[i]; x[i + 48] = b[i]; x[i + 64] = d[i]; }
  var x32 = x.subarray(32), x16 = x.subarray(16);
  inv25519(x32, x32);
  M(x16, x16, x32);
  pack25519(q, x16);
}
var BASE = new Uint8Array(32); BASE[0] = 9;
function x25519(k, u) {
  if (k.length !== 32 || u.length !== 32) throw new Error('x25519: keys are 32 bytes');
  var out = Buffer.alloc(32); scalarmult(out, k, u); return out;
}
function x25519Base(k) { return x25519(k, BASE); }
function isZero32(b) { var a = 0; for (var i = 0; i < b.length; i++) a |= b[i]; return a === 0; }

// ====================================================================== ChaCha20
function chachaKeyWords(key) {
  var w = new Uint32Array(8);
  for (var i = 0; i < 8; i++) w[i] = key[4 * i] | (key[4 * i + 1] << 8) | (key[4 * i + 2] << 16) | (key[4 * i + 3] << 24);
  return w;
}
// 64 bytes of keystream for block `counter` into out[oo..oo+64]; nonce = words n0 n1 n2 (little endian)
function chachaBlock(kw, counter, n0, n1, n2, out, oo) {
  var j4 = kw[0], j5 = kw[1], j6 = kw[2], j7 = kw[3], j8 = kw[4], j9 = kw[5], j10 = kw[6], j11 = kw[7];
  var x0 = 0x61707865, x1 = 0x3320646e, x2 = 0x79622d32, x3 = 0x6b206574, x4 = j4, x5 = j5, x6 = j6, x7 = j7,
    x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = counter | 0, x13 = n0, x14 = n1, x15 = n2, i;
  for (i = 0; i < 10; i++) {
    x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 16) | (x12 >>> 16);
    x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 12) | (x4 >>> 20);
    x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 8) | (x12 >>> 24);
    x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 7) | (x4 >>> 25);
    x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 16) | (x13 >>> 16);
    x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 12) | (x5 >>> 20);
    x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 8) | (x13 >>> 24);
    x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 7) | (x5 >>> 25);
    x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 16) | (x14 >>> 16);
    x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 12) | (x6 >>> 20);
    x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 8) | (x14 >>> 24);
    x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 7) | (x6 >>> 25);
    x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 16) | (x15 >>> 16);
    x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 12) | (x7 >>> 20);
    x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 8) | (x15 >>> 24);
    x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 7) | (x7 >>> 25);
    x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 16) | (x15 >>> 16);
    x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 12) | (x5 >>> 20);
    x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 8) | (x15 >>> 24);
    x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 7) | (x5 >>> 25);
    x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 16) | (x12 >>> 16);
    x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 12) | (x6 >>> 20);
    x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 8) | (x12 >>> 24);
    x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 7) | (x6 >>> 25);
    x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 16) | (x13 >>> 16);
    x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 12) | (x7 >>> 20);
    x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 8) | (x13 >>> 24);
    x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 7) | (x7 >>> 25);
    x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 16) | (x14 >>> 16);
    x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 12) | (x4 >>> 20);
    x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 8) | (x14 >>> 24);
    x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 7) | (x4 >>> 25);
  }
  x0 = (x0 + 0x61707865) | 0; x1 = (x1 + 0x3320646e) | 0; x2 = (x2 + 0x79622d32) | 0; x3 = (x3 + 0x6b206574) | 0;
  x4 = (x4 + j4) | 0; x5 = (x5 + j5) | 0; x6 = (x6 + j6) | 0; x7 = (x7 + j7) | 0;
  x8 = (x8 + j8) | 0; x9 = (x9 + j9) | 0; x10 = (x10 + j10) | 0; x11 = (x11 + j11) | 0;
  x12 = (x12 + (counter | 0)) | 0; x13 = (x13 + n0) | 0; x14 = (x14 + n1) | 0; x15 = (x15 + n2) | 0;
  out[oo] = x0; out[oo + 1] = x0 >>> 8; out[oo + 2] = x0 >>> 16; out[oo + 3] = x0 >>> 24;
  out[oo + 4] = x1; out[oo + 5] = x1 >>> 8; out[oo + 6] = x1 >>> 16; out[oo + 7] = x1 >>> 24;
  out[oo + 8] = x2; out[oo + 9] = x2 >>> 8; out[oo + 10] = x2 >>> 16; out[oo + 11] = x2 >>> 24;
  out[oo + 12] = x3; out[oo + 13] = x3 >>> 8; out[oo + 14] = x3 >>> 16; out[oo + 15] = x3 >>> 24;
  out[oo + 16] = x4; out[oo + 17] = x4 >>> 8; out[oo + 18] = x4 >>> 16; out[oo + 19] = x4 >>> 24;
  out[oo + 20] = x5; out[oo + 21] = x5 >>> 8; out[oo + 22] = x5 >>> 16; out[oo + 23] = x5 >>> 24;
  out[oo + 24] = x6; out[oo + 25] = x6 >>> 8; out[oo + 26] = x6 >>> 16; out[oo + 27] = x6 >>> 24;
  out[oo + 28] = x7; out[oo + 29] = x7 >>> 8; out[oo + 30] = x7 >>> 16; out[oo + 31] = x7 >>> 24;
  out[oo + 32] = x8; out[oo + 33] = x8 >>> 8; out[oo + 34] = x8 >>> 16; out[oo + 35] = x8 >>> 24;
  out[oo + 36] = x9; out[oo + 37] = x9 >>> 8; out[oo + 38] = x9 >>> 16; out[oo + 39] = x9 >>> 24;
  out[oo + 40] = x10; out[oo + 41] = x10 >>> 8; out[oo + 42] = x10 >>> 16; out[oo + 43] = x10 >>> 24;
  out[oo + 44] = x11; out[oo + 45] = x11 >>> 8; out[oo + 46] = x11 >>> 16; out[oo + 47] = x11 >>> 24;
  out[oo + 48] = x12; out[oo + 49] = x12 >>> 8; out[oo + 50] = x12 >>> 16; out[oo + 51] = x12 >>> 24;
  out[oo + 52] = x13; out[oo + 53] = x13 >>> 8; out[oo + 54] = x13 >>> 16; out[oo + 55] = x13 >>> 24;
  out[oo + 56] = x14; out[oo + 57] = x14 >>> 8; out[oo + 58] = x14 >>> 16; out[oo + 59] = x14 >>> 24;
  out[oo + 60] = x15; out[oo + 61] = x15 >>> 8; out[oo + 62] = x15 >>> 16; out[oo + 63] = x15 >>> 24;
}

var KS = new Uint8Array(64);     // keystream scratch
var PK = new Uint8Array(64);     // block 0 (Poly1305 key) scratch

// dst[do..do+len) = src[so..so+len) ^ keystream starting at block `counter`; src and dst may be the same array
function chachaXor(kw, n0, n1, n2, counter, src, so, dst, dof, len) {
  var k, n;
  while (len > 0) {
    chachaBlock(kw, counter++, n0, n1, n2, KS, 0);
    n = len < 64 ? len : 64;
    for (k = 0; k < n; k++) dst[dof + k] = src[so + k] ^ KS[k];
    so += n; dof += n; len -= n;
  }
}

// ====================================================================== Poly1305
function Poly1305() {
  this.r = new Int32Array(10); this.r5 = new Int32Array(10); this.h = new Float64Array(10);
  this.d = new Float64Array(10); this.pad = new Int32Array(8);
  this.buf = new Uint8Array(16); this.left = 0; this.fin = 0;
}
Poly1305.prototype.init = function (key, o) {
  var r = this.r, t0, t1, t2, t3, t4, t5, t6, t7, i;
  t0 = key[o] | (key[o + 1] << 8);
  t1 = key[o + 2] | (key[o + 3] << 8);
  t2 = key[o + 4] | (key[o + 5] << 8);
  t3 = key[o + 6] | (key[o + 7] << 8);
  t4 = key[o + 8] | (key[o + 9] << 8);
  t5 = key[o + 10] | (key[o + 11] << 8);
  t6 = key[o + 12] | (key[o + 13] << 8);
  t7 = key[o + 14] | (key[o + 15] << 8);
  r[0] = t0 & 0x1fff;
  r[1] = ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
  r[2] = ((t1 >>> 10) | (t2 << 6)) & 0x1f03;
  r[3] = ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
  r[4] = ((t3 >>> 4) | (t4 << 12)) & 0x00ff;
  r[5] = (t4 >>> 1) & 0x1ffe;
  r[6] = ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
  r[7] = ((t5 >>> 11) | (t6 << 5)) & 0x1f81;
  r[8] = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
  r[9] = (t7 >>> 5) & 0x007f;
  for (i = 0; i < 10; i++) { this.r5[i] = 5 * r[i]; this.h[i] = 0; }
  for (i = 0; i < 8; i++) this.pad[i] = key[o + 16 + 2 * i] | (key[o + 17 + 2 * i] << 8);
  this.left = 0; this.fin = 0;
};
Poly1305.prototype.blocks = function (m, mo, len) {
  var h = this.h, r = this.r, r5 = this.r5, d = this.d, hibit = this.fin ? 0 : (1 << 11);
  var t0, t1, t2, t3, t4, t5, t6, t7, i, j, s, c;
  while (len >= 16) {
    t0 = m[mo] | (m[mo + 1] << 8);
    t1 = m[mo + 2] | (m[mo + 3] << 8);
    t2 = m[mo + 4] | (m[mo + 5] << 8);
    t3 = m[mo + 6] | (m[mo + 7] << 8);
    t4 = m[mo + 8] | (m[mo + 9] << 8);
    t5 = m[mo + 10] | (m[mo + 11] << 8);
    t6 = m[mo + 12] | (m[mo + 13] << 8);
    t7 = m[mo + 14] | (m[mo + 15] << 8);
    h[0] += t0 & 0x1fff;
    h[1] += ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
    h[2] += ((t1 >>> 10) | (t2 << 6)) & 0x1fff;
    h[3] += ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
    h[4] += ((t3 >>> 4) | (t4 << 12)) & 0x1fff;
    h[5] += (t4 >>> 1) & 0x1fff;
    h[6] += ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
    h[7] += ((t5 >>> 11) | (t6 << 5)) & 0x1fff;
    h[8] += ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
    h[9] += (t7 >>> 5) | hibit;
    // h = h * r mod 2^130-5 (limbs j+k >= 10 wrap around with a factor 5)
    for (i = 0; i < 10; i++) {
      s = 0;
      for (j = 0; j <= i; j++) s += h[j] * r[i - j];
      for (j = i + 1; j < 10; j++) s += h[j] * r5[i - j + 10];
      d[i] = s;
    }
    c = 0;
    for (i = 0; i < 10; i++) {
      s = d[i] + c;
      c = Math.floor(s / 8192);
      h[i] = s - c * 8192;
    }
    s = h[0] + c * 5;
    c = Math.floor(s / 8192);
    h[0] = s - c * 8192;
    h[1] += c;
    mo += 16; len -= 16;
  }
};
Poly1305.prototype.update = function (m, mo, len) {
  var i, want;
  if (this.left) {
    want = 16 - this.left;
    if (want > len) want = len;
    for (i = 0; i < want; i++) this.buf[this.left + i] = m[mo + i];
    len -= want; mo += want; this.left += want;
    if (this.left < 16) return;
    this.blocks(this.buf, 0, 16);
    this.left = 0;
  }
  if (len >= 16) {
    want = len - (len % 16);
    this.blocks(m, mo, want);
    mo += want; len -= want;
  }
  for (i = 0; i < len; i++) this.buf[i] = m[mo + i];
  this.left = len;
};
Poly1305.prototype.finish = function (out, oo) {
  var h = this.h, g = this.d, i, c, f, mask;
  if (this.left) {
    this.buf[this.left] = 1;
    for (i = this.left + 1; i < 16; i++) this.buf[i] = 0;
    this.fin = 1;
    this.blocks(this.buf, 0, 16);
  }
  // full carry
  c = Math.floor(h[1] / 8192); h[1] -= c * 8192;
  for (i = 2; i < 10; i++) { h[i] += c; c = Math.floor(h[i] / 8192); h[i] -= c * 8192; }
  h[0] += c * 5; c = Math.floor(h[0] / 8192); h[0] -= c * 8192;
  h[1] += c; c = Math.floor(h[1] / 8192); h[1] -= c * 8192;
  h[2] += c;
  // g = h + 5 - 2^130; use g when h >= 2^130 - 5
  g[0] = h[0] + 5; c = Math.floor(g[0] / 8192); g[0] -= c * 8192;
  for (i = 1; i < 10; i++) { g[i] = h[i] + c; c = Math.floor(g[i] / 8192); if (i < 9) g[i] -= c * 8192; }
  g[9] -= c * 8192;
  mask = -c;                     // c is 1 when h >= p
  for (i = 0; i < 10; i++) h[i] = (h[i] & ~mask) | (g[i] & mask);
  // limbs -> 16-bit words
  var w = new Int32Array(8);
  w[0] = (h[0] | (h[1] << 13)) & 0xffff;
  w[1] = ((h[1] >>> 3) | (h[2] << 10)) & 0xffff;
  w[2] = ((h[2] >>> 6) | (h[3] << 7)) & 0xffff;
  w[3] = ((h[3] >>> 9) | (h[4] << 4)) & 0xffff;
  w[4] = ((h[4] >>> 12) | (h[5] << 1) | (h[6] << 14)) & 0xffff;
  w[5] = ((h[6] >>> 2) | (h[7] << 11)) & 0xffff;
  w[6] = ((h[7] >>> 5) | (h[8] << 8)) & 0xffff;
  w[7] = ((h[8] >>> 8) | (h[9] << 5)) & 0xffff;
  f = w[0] + this.pad[0]; w[0] = f & 0xffff;
  for (i = 1; i < 8; i++) { f = (((w[i] + this.pad[i]) | 0) + (f >>> 16)) | 0; w[i] = f & 0xffff; }
  for (i = 0; i < 8; i++) { out[oo + 2 * i] = w[i] & 0xff; out[oo + 2 * i + 1] = w[i] >>> 8; }
};
var POLY = new Poly1305();
var ZEROS16 = new Uint8Array(16), LENS = new Uint8Array(16);

// ====================================================================== ChaCha20-Poly1305 (RFC 8439)
function setLE32(a, o, v) { a[o] = v; a[o + 1] = v >>> 8; a[o + 2] = v >>> 16; a[o + 3] = v >>> 24; }

// tag over aad || pad || ct || pad || len(aad) || len(ct), Poly1305 key = block 0 of the stream
function aeadTag(kw, n0, n1, n2, aad, ct, co, clen, out, oo) {
  var alen = aad ? aad.length : 0;
  chachaBlock(kw, 0, n0, n1, n2, PK, 0);
  POLY.init(PK, 0);
  if (alen) { POLY.update(aad, 0, alen); if (alen & 15) POLY.update(ZEROS16, 0, 16 - (alen & 15)); }
  POLY.update(ct, co, clen);
  if (clen & 15) POLY.update(ZEROS16, 0, 16 - (clen & 15));
  setLE32(LENS, 0, alen); setLE32(LENS, 4, 0); setLE32(LENS, 8, clen); setLE32(LENS, 12, 0);
  POLY.update(LENS, 0, 16);
  POLY.finish(out, oo);
}
var TAG = new Uint8Array(16);

// Encrypts buf[off..off+len) in place and writes the 16-byte tag at buf[off+len..off+len+16)
function sealInPlace(kw, n0, n1, n2, aad, buf, off, len) {
  chachaXor(kw, n0, n1, n2, 1, buf, off, buf, off, len);
  aeadTag(kw, n0, n1, n2, aad, buf, off, len, buf, off + len);
}
// buf[off..off+len) is ciphertext || tag. Returns false (buf untouched) on a bad tag, otherwise decrypts in
// place and returns true (plaintext is buf[off..off+len-16)).
function openInPlace(kw, n0, n1, n2, aad, buf, off, len) {
  var clen = len - 16, i, diff = 0;
  if (clen < 0) return false;
  aeadTag(kw, n0, n1, n2, aad, buf, off, clen, TAG, 0);
  for (i = 0; i < 16; i++) diff |= TAG[i] ^ buf[off + clen + i];
  if (diff !== 0) return false;
  chachaXor(kw, n0, n1, n2, 1, buf, off, buf, off, clen);
  return true;
}
function nonceWords(nonce) {
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes');
  return [nonce[0] | (nonce[1] << 8) | (nonce[2] << 16) | (nonce[3] << 24),
    nonce[4] | (nonce[5] << 8) | (nonce[6] << 16) | (nonce[7] << 24),
    nonce[8] | (nonce[9] << 8) | (nonce[10] << 16) | (nonce[11] << 24)];
}
// Buffer-in / Buffer-out helpers (tests, handshake); the hot path uses CipherState below
function aeadEncrypt(key, nonce, aad, pt) {
  var nw = nonceWords(nonce), out = Buffer.alloc(pt.length + 16);
  pt.copy ? pt.copy(out, 0) : out.set(pt, 0);
  sealInPlace(chachaKeyWords(key), nw[0], nw[1], nw[2], aad, out, 0, pt.length);
  return out;
}
function aeadDecrypt(key, nonce, aad, ct) {
  var nw = nonceWords(nonce), tmp = Buffer.from(ct);
  if (!openInPlace(chachaKeyWords(key), nw[0], nw[1], nw[2], aad, tmp, 0, tmp.length)) return null;
  return tmp.slice(0, tmp.length - 16);
}
function chacha20Block(key, counter, nonce) {
  var nw = nonceWords(nonce), out = Buffer.alloc(64);
  chachaBlock(chachaKeyWords(key), counter, nw[0], nw[1], nw[2], out, 0);
  return out;
}
function chacha20Xor(key, counter, nonce, data) {
  var nw = nonceWords(nonce), out = Buffer.alloc(data.length);
  chachaXor(chachaKeyWords(key), nw[0], nw[1], nw[2], counter, data, 0, out, 0, data.length);
  return out;
}
function poly1305(key, msg) {
  var p = new Poly1305(), out = Buffer.alloc(16);
  p.init(key, 0); p.update(msg, 0, msg.length); p.finish(out, 0);
  return out;
}

// ====================================================================== Noise
var NOISE_NAME = 'Noise_NNpsk0_25519_ChaChaPoly_SHA256';
var TWO32 = 4294967296, NONCE_MAX = 9007199254740991;   // 2^53 - 1 messages per direction is far beyond reach

function sha256() {
  var h = crypto.createHash('sha256');
  for (var i = 0; i < arguments.length; i++) h.update(arguments[i]);
  return h.digest();
}
function hmac(key) {
  var h = crypto.createHmac('sha256', key);
  for (var i = 1; i < arguments.length; i++) h.update(arguments[i]);
  return h.digest();
}
// Noise HKDF: outputs[i] = HMAC(temp, outputs[i-1] || i)
function hkdf(ck, ikm, count) {
  var temp = hmac(ck, ikm), out = [], prev = Buffer.alloc(0);
  for (var i = 1; i <= count; i++) { prev = hmac(temp, prev, Buffer.from([i])); out.push(prev); }
  return out;
}

function NoiseError(message, mac) { this.message = message; this.mac = !!mac; this.stack = new Error(message).stack; }
NoiseError.prototype = Object.create(Error.prototype);
NoiseError.prototype.name = 'NoiseError';

// CipherState: key + 64-bit nonce counter (nonce bytes = 4 zero bytes || counter little endian)
function CipherState(key) { this.kw = chachaKeyWords(key); this.n = 0; }
CipherState.prototype.seal = function (aad, buf, off, len) {   // in place; tag appended after the data
  var n = this.n;
  if (n >= NONCE_MAX) throw new NoiseError('nonce exhausted');
  sealInPlace(this.kw, 0, n % TWO32 | 0, Math.floor(n / TWO32), aad, buf, off, len);
  this.n = n + 1;
};
CipherState.prototype.open = function (aad, buf, off, len) {   // in place; false if the tag is wrong
  var n = this.n;
  if (n >= NONCE_MAX) throw new NoiseError('nonce exhausted');
  if (!openInPlace(this.kw, 0, n % TWO32 | 0, Math.floor(n / TWO32), aad, buf, off, len)) return false;
  this.n = n + 1;
  return true;
};

// SymmetricState of the Noise spec
function SymmetricState(name) {
  var nb = Buffer.from(name, 'ascii');
  if (nb.length <= 32) { this.h = Buffer.alloc(32); nb.copy(this.h); } else this.h = sha256(nb);
  this.ck = this.h; this.cs = null;
}
SymmetricState.prototype.mixHash = function (data) { this.h = sha256(this.h, data); };
SymmetricState.prototype.mixKey = function (ikm) {
  var o = hkdf(this.ck, ikm, 2);
  this.ck = o[0]; this.cs = new CipherState(o[1]);
};
SymmetricState.prototype.mixKeyAndHash = function (ikm) {
  var o = hkdf(this.ck, ikm, 3);
  this.ck = o[0]; this.mixHash(o[1]); this.cs = new CipherState(o[2]);
};
SymmetricState.prototype.encryptAndHash = function (pt) {
  if (!this.cs) { this.mixHash(pt); return Buffer.from(pt); }
  var buf = Buffer.alloc(pt.length + 16);
  pt.copy(buf, 0);
  this.cs.seal(this.h, buf, 0, pt.length);
  this.mixHash(buf);
  return buf;
};
SymmetricState.prototype.decryptAndHash = function (ct) {
  if (!this.cs) { this.mixHash(ct); return Buffer.from(ct); }
  var buf = Buffer.from(ct);
  if (!this.cs.open(this.h, buf, 0, buf.length)) throw new NoiseError('Handshake MAC failure', true);
  this.mixHash(ct);
  return buf.slice(0, buf.length - 16);
};

// Responder side of NNpsk0:  -> psk, e   <- e, ee
function Responder(psk, prologue) {
  if (!Buffer.isBuffer(psk) || psk.length !== 32) throw new Error('psk must be a 32 byte Buffer');
  this.psk = psk; this.s = new SymmetricState(NOISE_NAME); this.s.mixHash(prologue); this.re = null; this.done = false;
}
Responder.prototype.readMessage1 = function (msg) {
  if (msg.length < 48) throw new NoiseError('Handshake error: message 1 too short');
  var s = this.s;
  s.mixKeyAndHash(this.psk);                    // psk0: first token of the first message
  this.re = Buffer.from(msg.slice(0, 32));
  s.mixHash(this.re); s.mixKey(this.re);        // "e" token (in a psk handshake it also mixes the key)
  s.decryptAndHash(msg.slice(32));              // payload (empty) + tag: this is where a wrong psk shows
};
Responder.prototype.writeMessage2 = function (ephemeral) {
  var s = this.s, e = ephemeral || crypto.randomBytes(32), pub = x25519Base(e), dh;
  s.mixHash(pub); s.mixKey(pub);
  dh = x25519(e, this.re);
  if (isZero32(dh)) throw new NoiseError('Handshake error: low order point');
  s.mixKey(dh);                                 // "ee"
  var ct = s.encryptAndHash(Buffer.alloc(0));
  this.done = true;
  return Buffer.concat([pub, ct]);
};
Responder.prototype.split = function () {
  var o = hkdf(this.s.ck, Buffer.alloc(0), 2);
  // initiator -> responder uses the first key
  return { recv: new CipherState(o[0]), send: new CipherState(o[1]) };
};

// ====================================================================== ESPHome frame helper (server)
var HELLO = 1, HANDSHAKE = 2, READY = 3, CLOSED = 4;
var EMPTY = Buffer.alloc(0);
var MAX_HANDSHAKE_FRAME = 128;      // ESPHome: MAX_HANDSHAKE_SIZE
var MAX_DATA_FRAME = 32768;         // ESPHome: MAX_MESSAGE_SIZE (32 KiB platforms)
var PLAIN_BAD_INDICATOR = Buffer.concat([Buffer.from([0]), Buffer.from('Bad indicator byte', 'ascii')]);

function frameOf(payload) {
  var f = Buffer.allocUnsafe(3 + payload.length);
  f[0] = 1; f.writeUInt16BE(payload.length, 1); payload.copy(f, 3);
  return f;
}
function rejectFrame(text) { return frameOf(Buffer.concat([Buffer.from([1]), Buffer.from(text, 'ascii')])); }

// opts: psk (Buffer 32), name (string), mac (string, ESPHome sends 12 lowercase hex digits),
//       write(buf), onPacket(type, payload Buffer), onClose(reason), onReady() optional
// receive(chunk) never throws; any protocol/crypto error closes the transport once through onClose.
function Transport(opts) {
  this.psk = opts.psk; this.name = opts.name; this.mac = opts.mac;
  this.write = opts.write; this.onPacket = opts.onPacket; this.onClose = opts.onClose; this.onReady = opts.onReady || null;
  this.state = HELLO; this.buf = EMPTY; this.prologue = null; this.hs = null; this.enc = null; this.dec = null;
  this.maxData = opts.maxData || MAX_DATA_FRAME;
}
Transport.prototype.isReady = function () { return this.state === READY; };
Transport.prototype.isClosed = function () { return this.state === CLOSED; };

Transport.prototype.fail = function (reason, rejectText) {
  if (this.state === CLOSED) return;
  var wasReady = this.state === READY;
  this.state = CLOSED; this.buf = EMPTY; this.hs = null; this.enc = null; this.dec = null;
  if (rejectText !== undefined && !wasReady) { try { this.write(rejectFrame(rejectText)); } catch (e) {} }
  try { this.onClose(reason); } catch (e) {}
};
Transport.prototype.close = function (reason) { this.fail(reason || 'closed'); };

Transport.prototype.receive = function (chunk) {
  if (this.state === CLOSED) return;
  this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
  try { this.pump(); } catch (e) { this.fail('internal error: ' + (e && e.message)); }
};

Transport.prototype.pump = function () {
  var b, len, limit, payload;
  while (this.state !== CLOSED) {
    b = this.buf;
    if (b.length < 1) return;
    if (b[0] !== 1) return this.fail('bad indicator byte 0x' + (b[0] < 16 ? '0' : '') + b[0].toString(16), 'Bad indicator byte');
    if (b.length < 3) return;
    len = (b[1] << 8) | b[2];
    limit = this.state === READY ? this.maxData : MAX_HANDSHAKE_FRAME;
    if (len > limit) return this.fail('frame too large (' + len + ' > ' + limit + ')', 'Bad handshake packet len');
    if (b.length < 3 + len) return;
    payload = b.slice(3, 3 + len);
    this.buf = b.slice(3 + len);
    if (this.state === READY) this.onData(payload);
    else if (this.state === HELLO) this.onHello(payload);
    else this.onHandshake(payload);
  }
};

Transport.prototype.onHello = function (payload) {
  // prologue covers the client's hello frame (length + contents), which is normally empty
  var lenb = Buffer.alloc(2); lenb.writeUInt16BE(payload.length, 0);
  this.prologue = Buffer.concat([Buffer.from('NoiseAPIInit', 'ascii'), lenb, payload]);
  this.write(frameOf(Buffer.concat([Buffer.from([1]), Buffer.from(this.name, 'utf8'), Buffer.from([0]),
    Buffer.from(this.mac, 'utf8'), Buffer.from([0])])));
  this.hs = new Responder(this.psk, this.prologue);
  this.state = HANDSHAKE;
};

Transport.prototype.onHandshake = function (payload) {
  if (payload.length === 0) return this.fail('empty handshake message', 'Empty handshake message');
  if (payload[0] !== 0) return this.fail('bad handshake status byte ' + payload[0], 'Bad handshake error byte');
  var msg2, ciphers;
  try {
    this.hs.readMessage1(payload.slice(1));
    msg2 = this.hs.writeMessage2();
    ciphers = this.hs.split();
  } catch (e) {
    if (!(e instanceof NoiseError)) throw e;
    return this.fail(e.mac ? 'handshake failed: wrong key (MAC failure)' : e.message, e.mac ? 'Handshake MAC failure' : 'Handshake error');
  }
  this.write(frameOf(Buffer.concat([Buffer.from([0]), msg2])));
  this.dec = ciphers.recv; this.enc = ciphers.send; this.hs = null;
  this.state = READY;
  if (this.onReady) this.onReady();
};

Transport.prototype.onData = function (frame) {
  // frame is a slice of the receive buffer; it is decrypted in place (only after the tag verified)
  if (frame.length < 16 || !this.dec.open(null, frame, 0, frame.length)) return this.fail('decrypt failure');
  var n = frame.length - 16;
  if (n < 4) return this.fail('decrypted message too short (' + n + ')');
  var type = (frame[0] << 8) | frame[1], dlen = (frame[2] << 8) | frame[3];
  if (dlen > n - 4) return this.fail('bad data length ' + dlen + ' > ' + (n - 4));
  this.onPacket(type, frame.slice(4, 4 + dlen));
};

// Encrypts one protobuf message and writes it as a single frame. Returns false if it could not be sent.
Transport.prototype.send = function (type, payload) {
  if (this.state !== READY) return false;
  var n = payload ? payload.length : 0, ml = 4 + n, out;
  if (ml + 16 > 65535) return false;
  out = Buffer.allocUnsafe(3 + ml + 16);
  out[0] = 1; out[1] = (ml + 16) >>> 8; out[2] = ml + 16;
  out[3] = type >>> 8; out[4] = type; out[5] = n >>> 8; out[6] = n;
  if (n) payload.copy(out, 7);
  try { this.enc.seal(null, out, 3, ml); } catch (e) { this.fail('encrypt failure: ' + e.message); return false; }
  this.write(out);
  return true;
};

// ====================================================================== key helpers
// api_key: base64 of exactly 32 bytes (same as ESPHome's `api: encryption: key:`), canonical encoding,
// not all zeros (ESPHome reserves the zero key for "unprovisioned").
function parseKey(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+\/]{43}=$/.test(s)) return null;
  var b = Buffer.from(s, 'base64');
  if (b.length !== 32 || b.toString('base64') !== s || isZero32(b)) return null;
  return b;
}
function generateKey() {
  var b;
  do { b = crypto.randomBytes(32); } while (isZero32(b));
  return b.toString('base64');
}

module.exports = {
  NOISE_NAME: NOISE_NAME, Transport: Transport, Responder: Responder, CipherState: CipherState,
  parseKey: parseKey, generateKey: generateKey, PLAIN_BAD_INDICATOR: PLAIN_BAD_INDICATOR,
  x25519: x25519, x25519Base: x25519Base, chacha20Block: chacha20Block, chacha20Xor: chacha20Xor, poly1305: poly1305,
  aeadEncrypt: aeadEncrypt, aeadDecrypt: aeadDecrypt, hmacSha256: hmac, hkdf: hkdf, sha256: sha256
};
