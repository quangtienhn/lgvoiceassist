// Tiny mDNS responder: advertises one _esphomelib._tcp service so Home Assistant auto-discovers us.
// (The TV runs avahi, but without avahi-publish or a writable /etc/avahi/services.)
'use strict';
var dgram = require('dgram');

var MCAST = '224.0.0.251', PORT = 5353;
var T = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };

function encName(name) {
  var parts = name.replace(/\.$/, '').split('.'), out = [];
  parts.forEach(function (p) { var b = Buffer.from(p, 'utf8'); out.push(Buffer.from([b.length]), b); });
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function readName(buf, pos, depth) {
  var labels = [], jumped = false, end = pos;
  depth = depth || 0;
  while (true) {
    var len = buf[pos];
    if (len === 0) { pos++; break; }
    if ((len & 0xc0) === 0xc0) {
      var ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) end = pos + 2;
      jumped = true;
      if (++depth > 10) break;
      pos = ptr; continue;
    }
    labels.push(buf.slice(pos + 1, pos + 1 + len).toString('utf8'));
    pos += 1 + len;
  }
  return [labels.join('.').toLowerCase(), jumped ? end : pos];
}

function rr(name, type, cls, ttl, rdata) {
  var h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(cls, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encName(name), h, rdata]);
}

function Responder(opts) {
  // opts: { instance, host, ip, port, txt: {k:v} }
  this.o = opts;
  this.svc = '_esphomelib._tcp.local';
  this.inst = opts.instance + '.' + this.svc;
  this.hostFqdn = opts.host + '.local';
  this.sock = null;
}

Responder.prototype.records = function (ttl) {
  var o = this.o;
  var srv = Buffer.alloc(6); srv.writeUInt16BE(0, 0); srv.writeUInt16BE(0, 2); srv.writeUInt16BE(o.port, 4);
  var txt = Buffer.concat(Object.keys(o.txt).map(function (k) {
    var s = Buffer.from(k + '=' + o.txt[k], 'utf8'); return Buffer.concat([Buffer.from([s.length]), s]);
  }));
  var a = Buffer.from(o.ip.split('.').map(Number));
  return {
    ptr: rr(this.svc, T.PTR, 1, ttl, encName(this.inst)),
    sd: rr('_services._dns-sd._udp.local', T.PTR, 1, ttl, encName(this.svc)),
    srv: rr(this.inst, T.SRV, 0x8001, ttl === 0 ? 0 : 120, Buffer.concat([srv, encName(this.hostFqdn)])),
    txt: rr(this.inst, T.TXT, 0x8001, ttl, txt),
    a: rr(this.hostFqdn, T.A, 0x8001, ttl === 0 ? 0 : 120, a)
  };
};

Responder.prototype.packet = function (answers, additionals, id) {
  var h = Buffer.alloc(12);
  h.writeUInt16BE(id || 0, 0); h.writeUInt16BE(0x8400, 2);
  h.writeUInt16BE(answers.length, 6); h.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([h].concat(answers, additionals));
};

Responder.prototype.send = function (pkt, port, addr) {
  if (!this.sock) return;
  this.sock.send(pkt, 0, pkt.length, port || PORT, addr || MCAST, function () {});
};

Responder.prototype.announce = function (ttl) {
  var r = this.records(ttl === undefined ? 4500 : ttl);
  this.send(this.packet([r.ptr, r.srv, r.txt, r.a], []));
};

Responder.prototype.onQuery = function (msg, rinfo) {
  if (msg.length < 12 || (msg.readUInt16BE(2) & 0x8000)) return;   // responses ignored
  var id = msg.readUInt16BE(0), qd = msg.readUInt16BE(4), pos = 12, r = this.records(4500);
  var ans = [], add = [], want = {};
  for (var i = 0; i < qd && pos < msg.length; i++) {
    var n = readName(msg, pos); pos = n[1];
    var type = msg.readUInt16BE(pos); pos += 4;
    var name = n[0];
    if (name === this.svc.toLowerCase() && (type === T.PTR || type === T.ANY)) want.ptr = 1;
    else if (name === '_services._dns-sd._udp.local' && (type === T.PTR || type === T.ANY)) want.sd = 1;
    else if (name === this.inst.toLowerCase()) {
      if (type === T.SRV || type === T.ANY) want.srv = 1;
      if (type === T.TXT || type === T.ANY) want.txt = 1;
    } else if (name === this.hostFqdn.toLowerCase() && (type === T.A || type === T.ANY)) want.a = 1;
  }
  if (want.sd) ans.push(r.sd);
  if (want.ptr) { ans.push(r.ptr); add.push(r.srv, r.txt, r.a); }
  if (want.srv) { ans.push(r.srv); if (!want.ptr) add.push(r.a); }
  if (want.txt) ans.push(r.txt);
  if (want.a) ans.push(r.a);
  if (!ans.length) return;
  var legacy = rinfo.port !== PORT;
  this.send(this.packet(ans, add, legacy ? id : 0), legacy ? rinfo.port : PORT, legacy ? rinfo.address : MCAST);
};

Responder.prototype.start = function (log) {
  var self = this;
  var s = this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', function (m, ri) { try { self.onQuery(m, ri); } catch (e) { if (log) log('mdns parse error', e.message); } });
  s.on('error', function (e) { if (log) log('mdns error', e.message); });
  s.bind(PORT, function () {
    try { s.addMembership(MCAST, self.o.ip); } catch (e) { try { s.addMembership(MCAST); } catch (e2) {} }
    try { s.setMulticastTTL(255); s.setMulticastInterface(self.o.ip); } catch (e) {}
    self.announce(); setTimeout(function () { self.announce(); }, 1000); setTimeout(function () { self.announce(); }, 3000);
    self.timer = setInterval(function () { self.announce(); }, 15 * 60 * 1000);
    if (log) log('mdns: advertising', self.inst, 'at', self.o.ip + ':' + self.o.port);
  });
};

Responder.prototype.stop = function () {
  if (!this.sock) return;
  clearInterval(this.timer);
  try { this.announce(0); } catch (e) {}
  var s = this.sock; this.sock = null;
  setTimeout(function () { try { s.close(); } catch (e) {} }, 100);
};

module.exports = Responder;
