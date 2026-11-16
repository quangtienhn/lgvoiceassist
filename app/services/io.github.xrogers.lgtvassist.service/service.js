// LG TV Assist luna service: control + status backend for the app UI.
// Must run as root (elevated by Homebrew Channel) to take over the mic button and control LG services.
'use strict';
var Service = require('webos-service');
var fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');

var ID = 'io.github.xrogers.lgtvassist.service';
var APP_ID = 'io.github.xrogers.lgtvassist';
// The daemon runs from the app folder: Life's Good Without Spying only honours a claim from a process
// started out of /media/developer/apps/usr/palm/applications/<app id>/.
var DAEMON = path.join(__dirname, '..', '..', 'applications', APP_ID, 'daemon');
var DATA = '/media/developer/lgtv-assist';
var HOOK = '/var/lib/webosbrew/init.d/60-lgtv-assist';
var service = new Service(ID);

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function alive(pidFile) {
  try { var pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10); process.kill(pid, 0); return pid; } catch (e) { return 0; }
}
function isRoot() { return typeof process.getuid === 'function' && process.getuid() === 0; }
function sh(script, cb) {
  cp.execFile('/bin/sh', [path.join(DAEMON, script)], { timeout: 20000 }, function (err, out, errOut) {
    cb(err, String(out || '') + String(errOut || ''));
  });
}
function tail(file, n) {
  try { var lines = fs.readFileSync(file, 'utf8').split('\n'); return lines.slice(-n - 1).join('\n'); } catch (e) { return ''; }
}
function installHook() {
  fs.mkdirSync && !fs.existsSync(path.dirname(HOOK)) && fs.mkdirSync(path.dirname(HOOK));
  fs.writeFileSync(HOOK, fs.readFileSync(path.join(DAEMON, 'init-hook.sh')));
  fs.chmodSync(HOOK, 493);   // 0755
}
function validKey(k) { return typeof k === 'string' && /^[A-Za-z0-9+\/]{43}=$/.test(k) && Buffer.from(k, 'base64').length === 32; }
function needRoot(message) {
  if (isRoot()) return false;
  message.respond({ returnValue: false, errorText: 'not running as root', notRoot: true });
  return true;
}


// ------------------------------------------------------------------ Life's Good Without Spying
// nospy can stub LG's voice services. We register two exceptions (off until the user turns them on
// in nospy): keep voiceinput running (it serves the remote mic audio) and claim the voiceconductor
// name (nospy's stand-in steps aside while our daemon holds it). See nospy-lib.sh "Exceptions".
var NOSPY = '/media/developer/apps/usr/palm/applications/ooo.lew.lifesgoodwithoutspying';
var NOSPY_CTL = NOSPY + '/init/nospy-ctl.sh';
var EXC_DIR = '/var/lib/webosbrew/lifesgoodwithoutspying.exceptions.d';
var EXC_FILE = EXC_DIR + '/' + APP_ID;
var EXC_CONTENT = 'keep voiceinput\nclaim com.webos.service.voiceconductor\n';
var KEY_KEEP = 'exception.' + APP_ID + ':keep:voiceinput';
var KEY_CLAIM = 'exception.' + APP_ID + ':claim:com.webos.service.voiceconductor';
var nospyCache = null, nospyAt = 0;

function nospyInstalled() { return fs.existsSync(NOSPY_CTL); }

// Register our exceptions with nospy. We deliberately do NOT run nospy's apply: it would apply every
// saved nospy setting, even when the user has nospy disabled. nospy lists registered exceptions on its
// own (it scans EXC_DIR); the user turns them on and applies in nospy's UI.
function nospyRegister() {
  if (!nospyInstalled()) return false;
  var cur = null;
  try { cur = fs.readFileSync(EXC_FILE, 'utf8'); } catch (e) {}
  if (cur === EXC_CONTENT) return false;
  try { fs.mkdirSync(EXC_DIR); } catch (e) {}
  fs.writeFileSync(EXC_FILE, EXC_CONTENT);
  nospyAt = 0;
  return true;
}

function nospyStatus(cb) {
  if (!nospyInstalled()) return cb({ installed: false });
  if (nospyCache && Date.now() - nospyAt < 20000) return cb(nospyCache);
  cp.execFile('/bin/sh', [NOSPY_CTL, 'status'], { timeout: 15000 }, function (err, out) {
    var kv = {};
    String(out || '').split('\n').forEach(function (l) { var i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); });
    var stubs = parseInt(kv.stubs, 10) || 0;
    function applied(k) { return (kv['applied.' + k] !== undefined ? kv['applied.' + k] : kv[k]) === 'on'; }
    nospyCache = {
      installed: true,
      registered: fs.existsSync(EXC_FILE),
      active: stubs > 0,
      voiceBlocked: applied('voice.stop') && stubs > 0,
      keep: applied(KEY_KEEP),
      claim: applied(KEY_CLAIM),
      savedKeep: kv['saved.' + KEY_KEEP] === 'on',
      savedClaim: kv['saved.' + KEY_CLAIM] === 'on'
    };
    nospyCache.ok = !nospyCache.voiceBlocked || (nospyCache.keep && nospyCache.claim);
    nospyAt = Date.now();
    cb(nospyCache);
  });
}

service.register('status', function (message) {
  var st = readJson('/tmp/lgtv-assist.status.json', {});
  nospyStatus(function (ns) {
  message.respond({
    nospy: ns,
    returnValue: true,
    root: isRoot(),
    enabled: !fs.existsSync(path.join(DATA, 'disabled')),
    running: !!alive('/tmp/lgtv-assist.daemon.pid'),
    hookInstalled: fs.existsSync(HOOK),
    settings: readJson(path.join(DATA, 'settings.json'), {}),
    daemon: st,
    log: message.payload && message.payload.log ? tail('/tmp/lgtv-assist.log', message.payload.log) : undefined
  });
  });
});

service.register('start', function (message) {
  if (needRoot(message)) return;
  try { fs.mkdirSync(DATA); } catch (e) {}
  try { fs.unlinkSync(path.join(DATA, 'disabled')); } catch (e) {}
  try { installHook(); } catch (e) { return message.respond({ returnValue: false, errorText: 'hook: ' + e.message }); }
  try { nospyRegister(); } catch (e) { /* nospy optional */ }
  // detached: the daemon must outlive this (idle-stopped) service process
  var p = cp.spawn('/bin/sh', [path.join(DAEMON, 'autostart.sh')], { detached: true, stdio: 'ignore' });
  p.unref();
  setTimeout(function () { message.respond({ returnValue: true, running: !!alive('/tmp/lgtv-assist.daemon.pid') }); }, 2500);
});

service.register('stop', function (message) {
  if (needRoot(message)) return;
  sh('stop.sh', function (err, out) {
    message.respond({ returnValue: !err, output: out, running: !!alive('/tmp/lgtv-assist.daemon.pid') });
  });
});

service.register('restart', function (message) {
  if (needRoot(message)) return;
  var pid = alive('/tmp/lgtv-assist.daemon.pid');
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (e) {} }   // loop.sh restarts it
  setTimeout(function () { message.respond({ returnValue: true, running: !!alive('/tmp/lgtv-assist.daemon.pid') }); }, 4500);
});

service.register('setSettings', function (message) {
  if (needRoot(message)) return;
  var p = message.payload || {}, file = path.join(DATA, 'settings.json');
  var s = readJson(file, {});
  ['friendly_name', 'name', 'toasts', 'suggested_area', 'max_seconds', 'hands_free', 'mic_gain', 'duck', 'duck_volume', 'wake_screen', 'lang', 'tv_locale', 'encryption'].forEach(function (k) {
    if (p[k] !== undefined) s[k] = p[k];
  });
  if (s.name) s.name = String(s.name).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 31);
  if (s.toasts !== undefined && s.toasts !== true && s.toasts !== false && s.toasts !== 'listen') s.toasts = true;
  // lang: a two-letter code the user chose in the app; anything else ("auto") means follow the TV menu language,
  // which the app reports as tv_locale (e.g. "pl-PL")
  if (s.lang !== undefined && !/^[a-z]{2}$/.test(String(s.lang))) delete s.lang;
  if (s.tv_locale !== undefined && !/^[A-Za-z_-]{2,16}$/.test(String(s.tv_locale))) delete s.tv_locale;
  // encryption: the ESPHome API then only accepts Home Assistant with the pre-shared key (base64 of 32 bytes),
  // which is made once, the first time encryption is turned on, and shown in the app
  if (s.encryption !== undefined) s.encryption = s.encryption === true;
  if (s.encryption && !validKey(s.api_key)) s.api_key = crypto.randomBytes(32).toString('base64');
  try { fs.mkdirSync(DATA); } catch (e) {}
  var prev = readJson(file, {});
  fs.writeFileSync(file, JSON.stringify(s, null, 1));
  // the daemon picks up most settings live; identity (name/port) and encryption changes need a restart
  var restart = prev.name !== s.name || prev.friendly_name !== s.friendly_name || prev.port !== s.port ||
    !!prev.encryption !== !!s.encryption || (s.encryption && prev.api_key !== s.api_key);
  var pid = restart && alive('/tmp/lgtv-assist.daemon.pid');
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (e) {} }
  message.respond({ returnValue: true, settings: s, restarted: !!pid });
});

service.register('nospyRegister', function (message) {
  if (needRoot(message)) return;
  var changed = false;
  try { changed = nospyRegister(); } catch (e) { return message.respond({ returnValue: false, errorText: e.message }); }
  message.respond({ returnValue: true, installed: nospyInstalled(), changed: changed });
});
