// LG TV Assist: makes a rooted LG webOS TV an ESPHome voice satellite for Home Assistant.
//
//  * Home Assistant connects to us (ESPHome native API, plaintext, port 6053) and finds us via mDNS
//    (_esphomelib._tcp). No token or login on the TV.
//  * Push-to-talk on the Magic Remote mic button: we hold the luna name com.webos.service.voiceconductor
//    (LG's service is stopped), so keyfilters sends us //setInputEvent down/up.
//  * Audio: LG's voiceinput streams the remote mic (HID F9 03 / F9 04, mSBC decoded by LG) as raw
//    PCM s16le 16 kHz mono on a unix socket; we forward it as VoiceAssistantAudio.
//  * Replies, announcements and media_player URLs are played with mpg123 (MP3) or gst-play-1.0.
//
// Node 8 (TV firmware), no npm dependencies. Runs as root (needs luna name + LG service control).
'use strict';
var palmbus = require('palmbus');
var net = require('net'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
var pb = require('./lib/pb'), msgs = require('./lib/messages'), Mdns = require('./lib/mdns');
var M = msgs.M, E = msgs.E;

var VERSION = '0.5.3';
var DATA_DIR = process.env.LGTV_ASSIST_DATA || '/media/developer/lgtv-assist';
var LOG = '/tmp/lgtv-assist.log';
var STATUS = '/tmp/lgtv-assist.status.json';

function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } }
var CFG = Object.assign({ name: 'lg-tv-assist', friendly_name: 'LG TV', port: 6053, max_seconds: 15,
  toasts: true, suggested_area: '', hands_free: true, mic_gain: 85, duck: true, duck_volume: 5, wake_screen: true }, readJson(path.join(DATA_DIR, 'settings.json'), {}));

function log() {
  var s = new Date().toISOString().slice(11, 23) + ' ' + Array.prototype.join.call(arguments, ' ');
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, s + '\n');
  } catch (e) {}
  if (process.stdout.isTTY) console.log(s);
}

// ------------------------------------------------------------------ network identity
function netInfo() {
  var ifs = os.networkInterfaces(), best = null;
  Object.keys(ifs).forEach(function (n) {
    ifs[n].forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address) && !best) best = { ip: a.address, mac: a.mac, ifname: n };
    });
  });
  return best || { ip: '0.0.0.0', mac: '00:00:00:00:00:00', ifname: '?' };
}
var NET = netInfo();
var MAC = NET.mac.toUpperCase();

// ------------------------------------------------------------------ status (for the app UI)
var status = { mic: 'starting', usbMic: null, listening: false, version: VERSION, started: new Date().toISOString(), ip: NET.ip, port: CFG.port, name: CFG.name,
  ha: null, haSince: null, lastSession: null, lastText: null, lastReply: null, lastError: null };
function saveStatus() { try { fs.writeFileSync(STATUS, JSON.stringify(status)); } catch (e) {} }
saveStatus();
try { fs.writeFileSync('/tmp/lgtv-assist.daemon.pid', String(process.pid)); } catch (e) {}

// ------------------------------------------------------------------ child processes
// Children must not inherit our luna hub socket (palmbus fds lack CLOEXEC); a child outliving us
// keeps the voiceconductor name registered and we could not come back after a restart.
var CLOSE_FDS = 'for f in /proc/$$/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; exec "$@"';
function spawnClean(cmd, args, opts) { return cp.spawn('/bin/sh', ['-c', CLOSE_FDS, 'sh', cmd].concat(args), opts || {}); }

function lunaSend(uri, params) {
  spawnClean('luna-send', ['-n', '1', '-w', '3000', uri, JSON.stringify(params)], { stdio: 'ignore' }).on('error', function () {});
}
function toast(text) {
  if (!text || !CFG.toasts) return;
  lunaSend('luna://com.webos.notification/createToast',
    { message: String(text).slice(0, 180), sourceId: 'com.webos.service.voiceconductor', noaction: true });
}

// ------------------------------------------------------------------ luna: be "voiceconductor"
var VC = 'com.webos.service.voiceconductor';
var APP_ID = 'io.github.xrogers.lgtvassist';
var VC_ANSWERS = { '/': { setInputEvent: {}, getSupportedLanguages: { voiceEngines: {}, voiceLanguages: {} } },
  '/interactor': { register: { subscribed: true } } };
var handles = null;

// Life's Good Without Spying may answer for voiceconductor with its own stand-in. With our "claim"
// exception turned on, it steps aside for the process named in its claim file (pid, start time, app id;
// the process must run from our app folder). Without it we don't fight the stand-in.
var NOSPY_ANSWER_PID = '/tmp/lifesgoodwithoutspying.answer.' + VC + '.pid';
var NOSPY_CLAIM = '/tmp/lifesgoodwithoutspying.claim.' + VC;
var NOSPY_APPLIED = '/var/lib/webosbrew/lifesgoodwithoutspying.conf-applied';
function procStartTime(pid) {
  var st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  return st.slice(st.lastIndexOf(')') + 2).split(' ')[19];
}
function nospyClaimAllowed() {
  try {
    return fs.readFileSync(NOSPY_APPLIED, 'utf8').split('\n')
      .indexOf('exception.' + APP_ID + ':claim:' + VC + '=on') >= 0;
  } catch (e) { return false; }
}
function nospyStandIn() {
  try {
    var pid = parseInt(fs.readFileSync(NOSPY_ANSWER_PID, 'utf8'), 10);
    return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').indexOf('nospy-luna-stub.js') >= 0 ? pid : 0;
  } catch (e) { return 0; }
}
function nospyClaim() {
  var stand = nospyStandIn();
  if (!stand) return false;
  if (!nospyClaimAllowed()) { status.mic = 'blocked by Life\'s Good Without Spying (turn on the LG TV Assist exception)'; saveStatus(); return false; }
  try { fs.writeFileSync(NOSPY_CLAIM, process.pid + ' ' + procStartTime(process.pid) + ' ' + APP_ID + '\n'); } catch (e) { return false; }
  try { process.kill(stand, 'SIGTERM'); } catch (e) {}
  log('nospy: claimed', VC, '- stopped its stand-in', stand);
  return true;
}

function onVcRequest(msg) {
  var body = {}; try { body = JSON.parse(msg.payload() || '{}'); } catch (e) {}
  var r = JSON.parse(JSON.stringify((VC_ANSWERS[msg.category()] || {})[msg.method()] || {}));
  r.returnValue = true; msg.respond(JSON.stringify(r));
  if (msg.method() === 'setInputEvent') {
    if (body.event === 'down') pttDown(); else if (body.event === 'up') pttUp();
  }
}

function registerVc(attempt) {
  attempt = attempt || 0;
  try {
    var hs = [false, true].map(function (pub) {
      var h = new palmbus.Handle(VC, pub);
      Object.keys(VC_ANSWERS).forEach(function (cat) {
        Object.keys(VC_ANSWERS[cat]).forEach(function (m) { h.registerMethod(cat, m); });
      });
      h.addListener('request', onVcRequest);
      return h;
    });
    handles = hs;
    status.mic = 'ok'; saveStatus();
    log('registered', VC);
  } catch (e) {
    if (attempt === 0) log('luna:', VC, 'is taken (' + e.message + '); retrying');
    nospyClaim();
    setTimeout(function () { registerVc(attempt + 1); }, attempt < 10 ? 1000 : 10000);
  }
}
registerVc();
log('lgtv-assist', VERSION, 'ip', NET.ip, 'mac', MAC);

// ------------------------------------------------------------------ remote mic (LG voiceinput)
var VI = 'luna://com.webos.service.voiceinput/', VI_PARAMS = { keyType: 'thinQtv', deviceType: 'remote' };
function viCall(method, cb) {
  if (!handles) { if (cb) cb('{"returnValue":false}'); return; }
  var c = handles[0].call(VI + method, JSON.stringify(VI_PARAMS));
  c.addListener('response', function (m) { if (cb) cb(m.payload()); });
}

function Mic(onData, onOpen, onFail) {
  this.onData = onData; this.onOpen = onOpen; this.onFail = onFail;
  this.sub = null; this.sock = null; this.keep = null; this.closed = false; this.t0 = Date.now();
  this.open(0);
}
Mic.prototype.open = function (attempt) {
  var self = this;
  if (this.closed) return;
  if (!handles) return this.onFail && this.onFail('voiceconductor name not held');
  var c = handles[0].subscribe(VI + 'startStreaming', JSON.stringify({ keyType: 'thinQtv', subscribe: true, deviceType: 'remote' }));
  this.sub = c;
  c.addListener('response', function (m) {
    var r = {}; try { r = JSON.parse(m.payload()); } catch (e) {}
    if (self.closed) return;
    if (r.returnValue === false && !self.sock) {
      try { c.cancel(); } catch (e) {}
      // remote may still be reconnecting (BLE) or the previous stream winding down
      if (attempt < 15) return setTimeout(function () { self.open(attempt + 1); }, 200);
      log('mic: voiceinput refused:', r.errorText || JSON.stringify(r));
      return self.onFail && self.onFail(r.errorText || 'mic unavailable');
    }
    if (r.socketPath && !self.sock) {
      self.sock = net.connect(r.socketPath);
      self.sock.on('data', function (pcm) { if (!self.closed) self.onData(pcm); });
      self.sock.on('error', function (e) { log('mic socket error', e.message); });
      self.keep = setInterval(function () { viCall('restartTimer'); }, 2500);
      log('mic: open after', Date.now() - self.t0, 'ms');
      if (self.onOpen) self.onOpen();
    }
  });
};
Mic.prototype.close = function () {
  if (this.closed) return;
  this.closed = true;
  clearInterval(this.keep);
  if (this.sock) { try { this.sock.destroy(); } catch (e) {} }
  var sub = this.sub, opened = !!this.sock;
  // Stop as the same client that started, then drop the subscription. Also when the socket isn't
  // open yet: voiceinput may already be capturing, and would refuse the next start for seconds.
  viCall('stopStreaming', function (out) {
    if (opened && !/"returnValue"\s*:\s*true/.test(out)) log('mic: stopStreaming', out);
    try { if (sub) sub.cancel(); } catch (e) {}
  });
};

// ------------------------------------------------------------------ player
var MP_KEY = 0x4c475456;   // 'LGTV'
var player = { proc: null, queue: [], state: E.MP_STATE.IDLE, volume: 1.0, muted: false, announcing: false, done: null };

function playUrls(urls, announcement, done) {
  stopPlayback(true);
  if (session && session.type === 'wake' && !session.woke) abortSession('playback');
  player.queue = urls.filter(Boolean);
  player.announcing = !!announcement;
  player.done = done || null;
  // HA's ESPHome media_player maps only idle/playing/paused (ANNOUNCING raised KeyError and stalled the entry)
  setPlayerState(E.MP_STATE.PLAYING);
  playNext();
}
function playNext() {
  var url = player.queue.shift();
  if (!url) {
    player.proc = null;
    setPlayerState(E.MP_STATE.IDLE);
    var cb = player.done; player.done = null;
    if (cb) cb(true); else scheduleListening(300);
    return;
  }
  var scale = player.muted ? 0 : Math.round(32768 * player.volume);
  var p = /\.mp3(\?|$)/i.test(url) || !/\.(flac|wav|ogg|opus)(\?|$)/i.test(url)
    ? spawnClean('timeout', ['-t', '120', 'mpg123', '-q', '-f', String(scale), url], { stdio: 'ignore' })
    : spawnClean('timeout', ['-t', '120', 'gst-play-1.0', '-q', '--volume=' + (player.muted ? 0 : player.volume), url], { stdio: 'ignore' });
  player.proc = p;
  p.on('error', function () {});
  p.on('exit', function () { if (player.proc === p) playNext(); });
}
function stopPlayback(silent) {
  player.queue = [];
  var p = player.proc; player.proc = null;
  if (p) { try { p.kill(); } catch (e) {} }
  var cb = player.done; player.done = null;
  if (cb) cb(false);
  if (!silent) setPlayerState(E.MP_STATE.IDLE);
}
function setPlayerState(st) { player.state = st; broadcast('MediaPlayerStateResponse', playerStateMsg()); }
function playerStateMsg() { return { key: MP_KEY, state: player.state, volume: player.volume, muted: player.muted }; }

// ------------------------------------------------------------------ ESPHome API server
var clients = [];          // connected API clients
var va = null;             // client subscribed to voice assistant

function Client(sock) {
  this.sock = sock; this.buf = Buffer.alloc(0); this.name = '?'; this.subscribedStates = false;
  clients.push(this);
}
Client.prototype.send = function (type, obj) {
  if (this.sock.destroyed) return;
  var def = M[type], body = pb.encode(def[1], obj || {}), hdr = [0];
  pb.writeVarint(hdr, body.length); pb.writeVarint(hdr, def[0]);
  this.sock.write(Buffer.concat([Buffer.from(hdr), body]));
};
Client.prototype.onData = function (d) {
  this.buf = Buffer.concat([this.buf, d]);
  while (this.buf.length >= 3) {
    if (this.buf[0] !== 0) { log('api: bad preamble (encrypted client?)'); this.sock.destroy(); return; }
    var r1, r2;
    try { r1 = pb.readVarint(this.buf, 1); r2 = pb.readVarint(this.buf, r1[1]); } catch (e) { return; }
    var len = r1[0], type = r2[0], start = r2[1];
    if (this.buf.length < start + len) return;
    var payload = this.buf.slice(start, start + len);
    this.buf = this.buf.slice(start + len);
    var name = msgs.byId[type];
    if (!name) continue;
    var msg = {};
    try { msg = pb.decode(M[name][1], payload); } catch (e) { log('api: decode', name, e.message); continue; }
    try { this.handle(name, msg); } catch (e) { log('api: handler', name, e.stack); }
  }
};
Client.prototype.handle = function (name, m) {
  var self = this;
  switch (name) {
    case 'HelloRequest':
      this.name = m.client_info || '?';
      return this.send('HelloResponse', { api_version_major: 1, api_version_minor: 10, server_info: 'lgtv-assist ' + VERSION, name: CFG.name });
    case 'AuthenticationRequest': return this.send('AuthenticationResponse', {});
    case 'DisconnectRequest': this.send('DisconnectResponse', {}); return this.sock.end();
    case 'PingRequest': return this.send('PingResponse', {});
    case 'DeviceInfoRequest':
      return this.send('DeviceInfoResponse', {
        name: CFG.name, friendly_name: CFG.friendly_name, mac_address: MAC, esphome_version: '2025.9.0',
        model: 'LG webOS TV (Magic Remote mic)', manufacturer: 'LG Electronics', project_name: 'lgtv-assist.LG TV Assist',
        project_version: VERSION, suggested_area: CFG.suggested_area,
        voice_assistant_feature_flags: E.VA_FEATURE.VOICE_ASSISTANT | E.VA_FEATURE.API_AUDIO | E.VA_FEATURE.ANNOUNCE |
          E.VA_FEATURE.START_CONVERSATION | E.VA_FEATURE.TIMERS });
    case 'ListEntitiesRequest':
      this.send('ListEntitiesMediaPlayerResponse', {
        object_id: 'lg_tv_assist_media_player', key: MP_KEY, name: 'Media Player', icon: 'mdi:television-speaker',
        supports_pause: false,
        supported_formats: [{ format: 'mp3', purpose: 0 }, { format: 'mp3', purpose: 1 }],
        feature_flags: E.MP_FEATURE.PLAY | E.MP_FEATURE.STOP | E.MP_FEATURE.PLAY_MEDIA | E.MP_FEATURE.VOLUME_SET |
          E.MP_FEATURE.VOLUME_MUTE | E.MP_FEATURE.MEDIA_ANNOUNCE });
      this.send('ListEntitiesSwitchResponse', { object_id: 'lg_tv_screen', key: SCREEN_KEY, name: 'Ekran', icon: 'mdi:television' });
      return this.send('ListEntitiesDoneResponse', {});
    case 'SubscribeStatesRequest':
    case 'SubscribeHomeAssistantStatesRequest':
      this.subscribedStates = true;
      this.send('SwitchStateResponse', screenStateMsg());
      return this.send('MediaPlayerStateResponse', playerStateMsg());
    case 'SwitchCommandRequest':
      if (m.key === SCREEN_KEY) setScreen(!!m.state, 'home assistant');
      return;
    case 'MediaPlayerCommandRequest':
      if (m.has_media_url && m.media_url) { log('media: play', m.media_url); playUrls([m.media_url], m.announcement); }
      if (m.has_volume) { player.volume = Math.max(0, Math.min(1, m.volume || 0)); setPlayerState(player.state); }
      if (m.has_command) {
        var c = E.MP_CMD[m.command];
        if (c === 'STOP' || c === 'PAUSE') stopPlayback();
        else if (c === 'MUTE' || c === 'UNMUTE') { player.muted = c === 'MUTE'; setPlayerState(player.state); }
        else if (c === 'VOLUME_UP') { player.volume = Math.min(1, player.volume + 0.1); setPlayerState(player.state); }
        else if (c === 'VOLUME_DOWN') { player.volume = Math.max(0, player.volume - 0.1); setPlayerState(player.state); }
      }
      return;
    case 'SubscribeVoiceAssistantRequest':
      if (m.subscribe) { va = this; log('api: voice assistant subscribed by', this.name, '(flags ' + (m.flags || 0) + ')'); setHa(this); scheduleListening(1000); }
      else if (va === this) { va = null; setHa(null); }
      return;
    case 'VoiceAssistantConfigurationRequest':
      return this.send('VoiceAssistantConfigurationResponse', { available_wake_words: [], active_wake_words: [], max_active_wake_words: 0 });
    case 'VoiceAssistantResponse': return onVaResponse(this, m);
    case 'VoiceAssistantEventResponse': return onVaEvent(this, m);
    case 'VoiceAssistantAnnounceRequest': return onAnnounce(this, m);
    case 'VoiceAssistantTimerEventResponse': return onTimer(m);
    default: return;   // logs, services, time, set configuration: ignore
  }
};
Client.prototype.closed = function () {
  clients = clients.filter(function (c) { return c !== this; }, this);
  if (va === this) { va = null; setHa(null); endSession('ha disconnected', true); }
};

function setHa(c) {
  status.ha = c ? c.name + ' @ ' + c.sock.remoteAddress : null;
  status.haSince = c ? new Date().toISOString() : null;
  saveStatus();
}

function broadcast(type, obj) { clients.forEach(function (c) { if (c.subscribedStates) c.send(type, obj); }); }

var server = net.createServer(function (sock) {
  var c = new Client(sock);
  sock.setNoDelay(true);
  log('api: connection from', sock.remoteAddress);
  sock.on('data', function (d) { c.onData(d); });
  sock.on('error', function () {});
  sock.on('close', function () { log('api: closed', sock.remoteAddress); c.closed(); });
});
server.on('error', function (e) { log('api server error', e.message); process.exit(1); });
server.listen(CFG.port, '0.0.0.0', function () { log('api: listening on', CFG.port); });

// ------------------------------------------------------------------ USB microphone (hands-free)
// A USB microphone shows up in LG's PulseAudio as alsa_input.usb-*. We read it with parec (16 kHz mono)
// and let Home Assistant detect the wake word (pipeline wake word stage, e.g. openWakeWord).
var usb = { source: null, configured: null, checking: false };
var PA = ['-s', 'unix:/var/run/pulse/native'];

function checkUsbMic() {
  if (usb.checking) return;
  usb.checking = true;
  var out = '', p = spawnClean('pactl', PA.concat(['list', 'sources', 'short']));
  p.stdout.on('data', function (d) { out += d; });
  p.on('error', function () { usb.checking = false; });
  p.on('close', function () {
    usb.checking = false;
    var src = null;
    out.split('\n').forEach(function (l) {
      var name = l.split('\t')[1];
      if (name && /^alsa_input\.usb-/.test(name) && !/\.monitor$/.test(name) && !src) src = name;
    });
    if (src !== usb.source) {
      log('usb mic:', src || 'none');
      usb.source = src;
      status.usbMic = src; saveStatus();
      if (src) configureUsbMic(src);
      else if (session && session.type === 'wake') abortSession('usb mic removed');
    }
    ensureListening();
  });
}

function configureUsbMic(src) {
  // software volume 100 %, hardware capture gain on every USB card (default ~19 dB is too quiet for a room)
  spawnClean('pactl', PA.concat(['set-source-volume', src, '100%']), { stdio: 'ignore' }).on('error', function () {});
  try {
    fs.readFileSync('/proc/asound/cards', 'utf8').split('\n').forEach(function (l) {
      var m = /^\s*(\d+)\s+\[.*\]:\s*USB-Audio/.exec(l);
      if (m) spawnClean('amixer', ['-q', '-c', m[1], 'sset', 'Mic', 'capture', (CFG.mic_gain || 85) + '%', 'cap'], { stdio: 'ignore' }).on('error', function () {});
    });
  } catch (e) {}
  usb.configured = src;
}

function UsbMic(src, onData) {
  this.closed = false;
  var p = this.proc = spawnClean('parec', PA.concat(['-d', src, '--rate=16000', '--channels=1', '--format=s16le', '--latency-msec=40']));
  var self = this;
  p.stdout.on('data', function (pcm) { if (!self.closed) onData(pcm); });
  p.on('error', function () {});
  p.on('exit', function () { if (!self.closed) { log('usb mic: parec exited'); usb.source = null; } });
}
UsbMic.prototype.close = function () { this.closed = true; try { this.proc.kill(); } catch (e) {} };

// ------------------------------------------------------------------ TV volume ducking
var duck = { saved: null };
function getTvVolume(cb) {
  if (!handles) return cb(null);
  var c = handles[0].call('luna://com.webos.service.audio/master/getVolume', '{}');
  c.addListener('response', function (m) {
    var r = {}; try { r = JSON.parse(m.payload()); } catch (e) {}
    cb(r.volumeStatus && typeof r.volumeStatus.volume === 'number' ? r.volumeStatus.volume : (typeof r.volume === 'number' ? r.volume : null));
  });
}
function duckTv() {
  if (CFG.duck === false || duck.saved !== null) return;
  getTvVolume(function (v) {
    var target = CFG.duck_volume === undefined ? 5 : CFG.duck_volume;
    if (v === null || v <= target) return;
    duck.saved = v;
    lunaSend('luna://com.webos.service.audio/master/setVolume', { volume: target });
  });
}
function restoreTv() {
  if (duck.saved === null) return;
  lunaSend('luna://com.webos.service.audio/master/setVolume', { volume: duck.saved });
  duck.saved = null;
}

// ------------------------------------------------------------------ screen (switch entity "Ekran")
// "Screen off" keeps the TV running (mic, hands-free listening, audio replies) with the panel dark.
// Real standby (power button, Quick Start+) suspends the whole system, so nothing can listen then.
var SCREEN_KEY = 0x5343524e;   // 'SCRN'
var screen = { state: null, on: null, sub: null };
function screenIsOn(st) { return !!st && !/screen off|standby|suspend|power off/i.test(st); }
// tvpower only answers luna-send (our palmbus handles get "Not permitted"): keep a luna-send -i subscription
function watchScreen() {
  if (screen.sub) return;
  var p = screen.sub = spawnClean('luna-send', ['-i', 'luna://com.webos.service.tvpower/power/getPowerState', '{"subscribe":true}']);
  var buf = '';
  p.stdout.on('data', function (d) {
    buf += d;
    var i;
    while ((i = buf.indexOf('}')) >= 0) {           // one flat JSON object per response
      var chunk = buf.slice(0, i + 1); buf = buf.slice(i + 1);
      var j = chunk.lastIndexOf('{'); if (j < 0) continue;
      var r = {}; try { r = JSON.parse(chunk.slice(j)); } catch (e) { continue; }
      if (!r.state) continue;
      var on = screenIsOn(r.state);
      if (r.state !== screen.state) log('screen:', r.state + (r.processing ? ' (' + r.processing + ')' : ''));
      screen.state = r.state;
      if (on !== screen.on) { screen.on = on; status.screen = r.state; saveStatus(); broadcast('SwitchStateResponse', screenStateMsg()); }
    }
  });
  p.on('error', function () {});
  p.on('exit', function () { screen.sub = null; setTimeout(watchScreen, 5000); });
}
function screenStateMsg() { return { key: SCREEN_KEY, state: !!screen.on, missing_state: screen.on === null }; }
function setScreen(on, why) {
  log('screen:', on ? 'turn on' : 'turn off', '(' + why + ')');
  lunaSend('luna://com.webos.service.tvpower/power/' + (on ? 'turnOnScreen' : 'turnOffScreen'), {});
}

// ------------------------------------------------------------------ voice session
// types: 'ptt'  - Magic Remote mic while the button is held (end = button release)
//        'vad'  - follow-up without a button (continue_conversation / start_conversation); HA's VAD ends it
//        'wake' - hands-free: USB mic streamed continuously, HA detects the wake word, then STT with VAD
var session = null, listenTimer = null, listenBackoff = 0;

function startSession(opts) {
  if (session) return;
  if (!va) { if (opts.type !== 'wake') toast('Home Assistant nie jest połączony z telewizorem'); return; }
  var type = opts.type || 'ptt';
  var s = session = { type: type, ptt: type === 'ptt', started: false, audioEnded: false, buf: [], bytes: 0, t0: Date.now(),
    client: va, woke: false };
  if (type !== 'wake') { status.lastSession = new Date().toISOString(); saveStatus(); stopPlayback(true); }
  if (type !== 'wake') s.maxTimer = setTimeout(function () { finishAudio('max length'); }, CFG.max_seconds * 1000);
  s.flags = type === 'ptt' ? 0 : type === 'wake' ? (E.VA_REQUEST_FLAG.USE_WAKE_WORD | E.VA_REQUEST_FLAG.USE_VAD) : E.VA_REQUEST_FLAG.USE_VAD;
  s.conversationId = opts.conversation_id || '';
  // While an aborted run is still winding down, hold the request (the mic already buffers audio).
  if (staleUntil && Date.now() < staleUntil) { s.deferred = true; clearTimeout(staleTimer); staleTimer = setTimeout(staleClear, staleUntil - Date.now()); }
  else sendStart(s);
  var onData = function (pcm) { onMicData(s, pcm); };
  if (type === 'ptt' || !usb.source) {
    s.mic = new Mic(onData, null, function (why) {
      if (type === 'ptt') toast('Mikrofon pilota niedostępny');
      else if (type === 'vad') toast('Naciśnij mikrofon na pilocie, aby odpowiedzieć');
      abortSession('mic: ' + why);
    });
  } else {
    s.mic = new UsbMic(usb.source, onData);
  }
  status.listening = type === 'wake'; saveStatus();
}

function onMicData(s, pcm) {
  if (s.audioEnded) return;
  s.bytes += pcm.length;
  if (!s.started) { if (s.type !== 'wake' || s.buf.length < 50) s.buf.push(pcm); return; }
  sendAudio(s, pcm);
}
function sendAudio(s, pcm) {
  for (var o = 0; o < pcm.length; o += 2048) s.client.send('VoiceAssistantAudio', { data: pcm.slice(o, o + 2048) });
}

function onVaResponse(client, m) {
  var s = session;
  if (!s || client !== s.client) return;
  if (m.error) {
    log('va: HA could not start the pipeline');
    if (s.type !== 'wake') toast('Asystent HA niedostępny');
    listenBackoff = Date.now() + 30000;
    return abortSession('ha error');
  }
  s.started = true;   // port 0 = audio over the API connection
  while (s.buf.length) sendAudio(s, s.buf.shift());
  if (s.audioEnded) s.client.send('VoiceAssistantAudio', { end: true });
}

function finishAudio(why) {
  var s = session;
  if (!s || s.audioEnded) return;
  clearTimeout(s.maxTimer);
  // let the socket flush the tail of the utterance
  setTimeout(function () {
    if (s.audioEnded) return;
    s.audioEnded = true;
    s.mic.close();
    log('va: audio end (' + why + '),', (s.bytes / 32000).toFixed(1), 's');
    if (s.ptt && s.bytes < 8000) { toast('Przytrzymaj przycisk mikrofonu i mów'); return abortSession('too short'); }
    if (s.started) s.client.send('VoiceAssistantAudio', { end: true });
  }, s.ptt ? 250 : 0);
}

// After we abort a run, HA still sends that run's last events (ERROR/RUN_END). They must not be taken
// for events of the session that replaced it (e.g. the remote button aborting hands-free listening).
var staleUntil = 0, staleTimer = null;

function sendStart(s) {
  s.deferred = false;
  s.client.send('VoiceAssistantRequest', { start: true, flags: s.flags, conversation_id: s.conversationId || '', wake_word_phrase: '' });
}
function staleClear() {
  staleUntil = 0; clearTimeout(staleTimer);
  if (session && session.deferred && !session.client.sock.destroyed) sendStart(session);
}

function abortSession(why) {
  var s = session;
  if (!s) return;
  clearTimeout(s.maxTimer);
  if (!s.audioEnded) { s.audioEnded = true; s.mic.close(); }
  if (s.client && !s.client.sock.destroyed) {
    s.client.send('VoiceAssistantRequest', { start: false });
    staleUntil = Date.now() + 1000;
  }
  endSession(why);
}

function endSession(why) {
  var s = session;
  if (!s) return;
  clearTimeout(s.maxTimer);
  if (!s.audioEnded) { s.audioEnded = true; s.mic.close(); }
  session = null;
  status.listening = false; saveStatus();
  if (s.type !== 'wake' || s.woke || why !== 'run end') log('va: session end:', why);
  if (!player.proc) restoreTv();
  scheduleListening(why === 'run end' ? 300 : 1500);
}

// (Re)start the hands-free wake word session whenever nothing else is going on.
function ensureListening() {
  if (CFG.hands_free === false || !usb.source || !va || session || player.proc || !handles) return;
  if (Date.now() < listenBackoff) return scheduleListening(listenBackoff - Date.now());
  restoreTv();
  startSession({ type: 'wake' });
}
function scheduleListening(ms) {
  clearTimeout(listenTimer);
  listenTimer = setTimeout(ensureListening, ms || 300);
}

function evData(m) { var d = {}; (m.data || []).forEach(function (x) { d[x.name] = x.value; }); return d; }

function onVaEvent(client, m) {
  var type = E.VA_EVENT[m.event_type], d = evData(m), s = session;
  var quiet = s && s.type === 'wake' && !s.woke && /^(RUN_START|WAKE_WORD_START)$/.test(type);
  if (staleUntil) {
    if (Date.now() > staleUntil) staleClear();
    else {
      if (type === 'RUN_END') staleClear();       // the aborted run is over
      return;                                      // a new session's request isn't sent yet, so this is old
    }
  }
  if (type !== 'INTENT_PROGRESS' && !quiet) log('va event', type, JSON.stringify(d).slice(0, 200));
  if (!s || client !== s.client) return;
  switch (type) {
    case 'WAKE_WORD_END':
      s.woke = true;
      s.bytes = 0;
      status.lastSession = new Date().toISOString(); saveStatus();
      s.maxTimer = setTimeout(function () { finishAudio('max length'); }, CFG.max_seconds * 1000);
      stopPlayback(true);
      duckTv();
      if (CFG.wake_screen !== false && screen.on === false) setScreen(true, 'wake word');
      toast('🎙️ Słucham…');
      break;
    case 'STT_VAD_END': if (!s.ptt) finishAudio('vad'); break;
    case 'STT_END':
      if (!s.audioEnded) finishAudio('stt end');
      status.lastText = d.text; saveStatus();
      if (d.text) toast('🎤 ' + d.text);
      break;
    case 'INTENT_END':
      s.continueConversation = d.continue_conversation === '1';
      s.conversationId = d.conversation_id || s.conversationId;
      break;
    case 'TTS_START':
      // LLM/conversation agent errors come back as English error dumps: show a short note, don't speak them
      if (d.text && /problem getting a response|RESOURCE_EXHAUSTED|Unable to get response/.test(d.text)) {
        s.muteTts = true;
        d.text = 'Asystent AI chwilowo niedostępny — działają komendy lokalne';
      }
      status.lastReply = d.text; saveStatus();
      if (d.text) toast(d.text);
      break;
    case 'TTS_END':
      if (d.url && s.muteTts) { scheduleListening(300); break; }
      if (d.url) {
        var cont = s.continueConversation, conv = s.conversationId;
        restoreTv();
        playUrls([d.url], true, function (ok) {
          if (ok && cont) startSession({ type: 'vad', conversation_id: conv });
          else scheduleListening(300);
        });
      }
      break;
    case 'ERROR':
      status.lastError = (d.code || '') + ' ' + (d.message || ''); saveStatus();
      if (s.type === 'wake' && !s.woke) { log('va: wake word stage error', d.code); listenBackoff = Date.now() + 10000; break; }
      toast(d.code === 'stt-no-text-recognized' ? 'Nie usłyszałem polecenia' : 'Asystent: ' + (d.message || d.code));
      break;
    case 'RUN_END':
      endSession('run end');
      break;
  }
}

function onAnnounce(client, m) {
  log('announce:', m.text || '', m.media_id);
  if (m.text) toast('📢 ' + m.text);
  if (session && session.type === 'wake' && !session.woke) abortSession('announcement');
  playUrls([m.preannounce_media_id, m.media_id], true, function (ok) {
    client.send('VoiceAssistantAnnounceFinished', { success: ok });
    if (ok && m.start_conversation) startSession({ type: 'vad' });
    else scheduleListening(300);
  });
}

function onTimer(m) {
  var t = E.TIMER_EVENT[m.event_type];
  log('timer', t, m.name || '', m.seconds_left);
  if (t === 'FINISHED') toast('⏰ ' + (m.name ? 'Minutnik „' + m.name + '” zakończony' : 'Minutnik zakończony'));
  else if (t === 'STARTED') toast('⏱️ Minutnik' + (m.name ? ' „' + m.name + '”' : '') + ': ' + Math.round(m.total_seconds / 60) + ' min');
}

// ------------------------------------------------------------------ push-to-talk
function pttDown() {
  log('key: mic down');
  if (session && session.type === 'wake' && !session.woke) {
    abortSession('ptt');               // the remote wins over hands-free listening
    clearTimeout(listenTimer);
  }
  if (session) return;
  startSession({ type: 'ptt' });
}
function pttUp() {
  log('key: mic up');
  if (session && session.ptt) finishAudio('key up');
}

// Live settings: toasts / hands_free / wake_screen / duck / mic_gain apply without a restart
// (the service restarts the daemon only when the name or port changes).
var SETTINGS = path.join(DATA_DIR, 'settings.json');
fs.watchFile(SETTINGS, { interval: 1000 }, function () {
  var next = readJson(SETTINGS, {});
  ['toasts', 'hands_free', 'wake_screen', 'duck', 'duck_volume', 'mic_gain', 'max_seconds'].forEach(function (k) {
    if (next[k] !== undefined && next[k] !== CFG[k]) { log('settings:', k, '=', JSON.stringify(next[k])); CFG[k] = next[k]; }
  });
  if (usb.source && next.mic_gain !== undefined) configureUsbMic(usb.source);
  if (CFG.hands_free === false && session && session.type === 'wake' && !session.woke) abortSession('hands-free off');
  else scheduleListening(300);
});

checkUsbMic();
setInterval(checkUsbMic, 15000);
watchScreen();

// ------------------------------------------------------------------ mDNS
var mdns = new Mdns({ instance: CFG.name, host: CFG.name, ip: NET.ip, port: CFG.port,
  txt: { friendly_name: CFG.friendly_name, version: '2025.9.0', mac: MAC.replace(/:/g, '').toLowerCase(),
    platform: 'HOST', board: 'lg-webos', network: NET.ifname.indexOf('wlan') === 0 ? 'wifi' : 'ethernet',
    project_name: 'lgtv-assist.LG TV Assist', project_version: VERSION } });
mdns.start(log);

function shutdown() {
  log('shutting down');
  try { if (fs.readFileSync(NOSPY_CLAIM, 'utf8').split(' ')[0] === String(process.pid)) fs.unlinkSync(NOSPY_CLAIM); } catch (e) {}
  mdns.stop();
  if (session) abortSession('shutdown');
  stopPlayback(true);
  setTimeout(function () { process.exit(0); }, 300);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', function (e) { log('uncaught', e && e.stack || e); });
setInterval(function () { return handles; }, 1 << 30);
