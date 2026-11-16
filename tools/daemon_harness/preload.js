// Preloaded (node -r) by tools/daemon_harness.py: keeps lib/mdns.js off the network. bind() succeeds without
// binding, nothing is sent; every packet the responder would have sent is appended (base64, one per line) to
// $LGTV_HARNESS_MDNS so tests can inspect the advertised records.
'use strict';
var dgram = require('dgram'), fs = require('fs');
var P = dgram.Socket.prototype, out = process.env.LGTV_HARNESS_MDNS;
P.bind = function (port, cb) { if (typeof cb === 'function') process.nextTick(cb.bind(this)); return this; };
P.addMembership = P.setMulticastTTL = P.setMulticastInterface = function () {};
P.send = function (msg, offset, length, port, address, cb) {
  try { if (out) fs.appendFileSync(out, Buffer.from(msg).slice(offset, offset + length).toString('base64') + '\n'); } catch (e) {}
  if (typeof cb === 'function') process.nextTick(cb);
};
