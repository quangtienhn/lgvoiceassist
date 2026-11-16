// Stub of LG's native `palmbus` module, only so app/daemon/satellite.js can run off-TV (tools/daemon_harness.py).
// Handles accept registrations and never deliver a request; calls/subscriptions never answer.
'use strict';
function Call() {}
Call.prototype.addListener = function () { return this; };
Call.prototype.cancel = function () {};
function Handle(name, pub) { this.name = name; this.pub = pub; }
Handle.prototype.registerMethod = function () {};
Handle.prototype.addListener = function () { return this; };
Handle.prototype.call = function () { return new Call(); };
Handle.prototype.subscribe = function () { return new Call(); };
module.exports = { Handle: Handle };
