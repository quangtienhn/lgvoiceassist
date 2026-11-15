// LG TV Assist luna service: control + status backend for the app UI.
// Must run as root (elevated by Homebrew Channel) to take over the mic button and control LG services.
'use strict';
var Service = require('webos-service');
var fs = require('fs'), path = require('path'), cp = require('child_process');

var ID = 'io.github.xrogers.lgtvassist.service';
var DAEMON = path.join(__dirname, 'daemon');
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
function needRoot(message) {
  if (isRoot()) return false;
  message.respond({ returnValue: false, errorText: 'not running as root', notRoot: true });
  return true;
}

service.register('status', function (message) {
  var st = readJson('/tmp/lgtv-assist.status.json', {});
  message.respond({
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

service.register('start', function (message) {
  if (needRoot(message)) return;
  try { fs.mkdirSync(DATA); } catch (e) {}
  try { fs.unlinkSync(path.join(DATA, 'disabled')); } catch (e) {}
  try { installHook(); } catch (e) { return message.respond({ returnValue: false, errorText: 'hook: ' + e.message }); }
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
  ['friendly_name', 'name', 'toasts', 'suggested_area', 'max_seconds'].forEach(function (k) {
    if (p[k] !== undefined) s[k] = p[k];
  });
  if (s.name) s.name = String(s.name).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 31);
  try { fs.mkdirSync(DATA); } catch (e) {}
  fs.writeFileSync(file, JSON.stringify(s, null, 1));
  var pid = alive('/tmp/lgtv-assist.daemon.pid');
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (e) {} }
  message.respond({ returnValue: true, settings: s });
});
