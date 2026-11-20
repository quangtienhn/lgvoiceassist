// Stub of LG's native `palmbus` module, only so app/daemon/satellite.js can run off-TV (tools/daemon_harness.py).
// Calls/subscriptions never answer. Requests to the services the daemon registers can be played in by a test:
// each line appended to $LGTV_HARNESS_DIR/tmp/luna-requests is a JSON object
//   {"name": "com.webos.service.voiceconductor", "category": "/", "method": "setInputEvent",
//    "payload": {...}, "sender": "com.webos.surfacemanager", "public": false}
// and is delivered as the hub would: to a handle of that name and bus that registered the method, otherwise
// answered "Unknown method" by the "hub". Every answer is appended to tmp/luna-responses as
//   {"method": "<category>/<method>", "response": {...}}
// and the registered methods are kept in tmp/luna-methods.json ({"<name> <public|private>": ["/cat/method", ...]}).
'use strict';
var fs = require('fs'), path = require('path');
var DIR = process.env.LGTV_HARNESS_DIR ? path.join(process.env.LGTV_HARNESS_DIR, 'tmp') : null;
var handles = [];

function Call() {}
Call.prototype.addListener = function () { return this; };
Call.prototype.cancel = function () {};

function full(category, method) { return (category === '/' ? '' : category) + '/' + method; }
function answer(method, response) {
  if (DIR) fs.appendFileSync(path.join(DIR, 'luna-responses'), JSON.stringify({ method: method, response: response }) + '\n');
}

function Message(req) { this.req = req; }
Message.prototype.payload = function () { return JSON.stringify(this.req.payload || {}); };
Message.prototype.category = function () { return this.req.category || '/'; };
Message.prototype.method = function () { return this.req.method; };
Message.prototype.senderServiceName = function () { return this.req.sender || ''; };
Message.prototype.applicationID = function () { return ''; };
Message.prototype.respond = function (s) { answer(full(this.category(), this.method()), JSON.parse(s)); return true; };

function Handle(name, pub) {
  // LGTV_HARNESS_VC_TAKEN: someone else holds the mic button service, as when LG's voiceconductor still runs
  if (process.env.LGTV_HARNESS_VC_TAKEN && name === 'com.webos.service.voiceconductor') throw new Error('service name already taken (harness)');
  this.name = name; this.pub = !!pub; this.methods = {}; this.listeners = [];
  handles.push(this);
}
Handle.prototype.registerMethod = function (category, method) {
  this.methods[full(category, method)] = 1;
  if (DIR) {
    var all = {};
    handles.forEach(function (h) { all[h.name + ' ' + (h.pub ? 'public' : 'private')] = Object.keys(h.methods).sort(); });
    fs.writeFileSync(path.join(DIR, 'luna-methods.json'), JSON.stringify(all));
  }
};
Handle.prototype.addListener = function (ev, fn) { if (ev === 'request') this.listeners.push(fn); return this; };
Handle.prototype.call = function () { return new Call(); };
Handle.prototype.subscribe = function () { return new Call(); };

// play in requests written by a test
var offset = 0;
if (DIR) {
  setInterval(function () {
    var file = path.join(DIR, 'luna-requests'), data;
    try { data = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    var lines = data.slice(offset).split('\n');
    var last = lines.pop();                 // incomplete line: wait for the rest
    offset = data.length - last.length;
    lines.forEach(function (l) {
      if (!l.trim()) return;
      var req = JSON.parse(l), m = full(req.category || '/', req.method);
      var h = handles.filter(function (x) { return x.name === req.name && x.pub === !!req.public && x.methods[m]; })[0];
      if (!h) return answer(m, { returnValue: false, errorCode: -1, errorText: 'Unknown method "' + req.method + '" for category "' + (req.category || '/') + '"' });
      h.listeners.forEach(function (fn) { fn(new Message(req)); });
    });
  }, 100).unref();
}

module.exports = { Handle: Handle };
