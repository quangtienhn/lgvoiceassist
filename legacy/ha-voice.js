// ha-voice: push-to-talk Home Assistant Assist on a rooted LG webOS TV (tested: OLED55CX, webOS 5.6).
//
// How it works (all reverse-engineered on the TV, see README.md):
//  * We take the luna name com.webos.service.voiceconductor (LG's voice service must be stopped).
//    keyfilters then sends us the Magic Remote mic key: //setInputEvent {"event":"down"/"up"}.
//  * On "down" we ask LG's own voiceinput to stream the remote mic (luna startStreaming). It sends the
//    remote the HID feature report F9 03, decodes the mSBC audio and serves raw PCM s16le 16 kHz mono
//    on a unix socket (/tmp/voiceinput_remote1.soc). "up" -> stopStreaming (F9 04).
//  * The PCM is streamed to HA over the WebSocket API (assist_pipeline/run, stt -> tts), the reply
//    text is shown as a toast and the TTS mp3 is played with mpg123.
//
// Node 8 (TV firmware), no npm dependencies. Config: config.json next to this file.
'use strict';
var palmbus = require('palmbus');
var net = require('net'), tls = require('tls'), crypto = require('crypto');
var fs = require('fs'), path = require('path'), cp = require('child_process'), url = require('url');

var DIR = __dirname;
var CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
if (!CFG.token) { try { CFG.token = fs.readFileSync(path.join(DIR, 'token'), 'utf8').trim(); } catch (e) {} }
var MAX_MS = (CFG.max_seconds || 15) * 1000;
var LOG = path.join('/tmp', 'ha-voice.log');

function log() {
  var s = new Date().toISOString().slice(11, 23) + ' ' + Array.prototype.join.call(arguments, ' ');
  try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {}
  if (process.stdout.isTTY) console.log(s);
}

// ---------------------------------------------------------------- luna (as voiceconductor)
var NAME = 'com.webos.service.voiceconductor';
var ANSWERS = {
  '/': { setInputEvent: {}, getSupportedLanguages: { voiceEngines: {}, voiceLanguages: {} } },
  '/interactor': { register: { subscribed: true } }
};
var handles = [false, true].map(function (pub) {
  var h = new palmbus.Handle(NAME, pub);
  Object.keys(ANSWERS).forEach(function (cat) {
    Object.keys(ANSWERS[cat]).forEach(function (m) { h.registerMethod(cat, m); });
  });
  h.addListener('request', onRequest);
  return h;
});
log('registered', NAME);

function onRequest(msg) {
  var cat = msg.category(), m = msg.method(), body = {};
  try { body = JSON.parse(msg.payload() || '{}'); } catch (e) {}
  var r = JSON.parse(JSON.stringify((ANSWERS[cat] || {})[m] || {}));
  r.returnValue = true;
  msg.respond(JSON.stringify(r));
  if (m === 'setInputEvent') {
    log('key', body.event, body.inputType || '');
    if (body.event === 'down') startSession();
    else if (body.event === 'up') stopSession('key up');
  }
}


// Children must not inherit our luna hub socket (palmbus fds lack CLOEXEC): if one outlives us,
// the hub keeps the voiceconductor name registered and we can't come back after a restart.
var CLOSE_FDS = 'for f in /proc/$$/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; exec "$@"';
function spawnClean(cmd, args, opts) {
  return cp.spawn('/bin/sh', ['-c', CLOSE_FDS, 'sh', cmd].concat(args), opts || {});
}

function lunaCall(uri, params) {
  // fire-and-forget through luna-send (has the permissions our handle may lack)
  var p = spawnClean('luna-send', ['-n', '1', '-w', '3000', uri, JSON.stringify(params)], { stdio: 'ignore' });
  p.on('error', function () {});
}

function toast(text) {
  if (!text) return;
  lunaCall('luna://com.webos.notification/createToast',
    { message: String(text).slice(0, 180), sourceId: 'com.webos.service.voiceconductor', noaction: true });
}

// ---------------------------------------------------------------- HA websocket (minimal client)
var ws = null, wsReady = false, wsId = 1, pending = {};

function wsConnect() {
  var u = url.parse(CFG.ha_url);
  var secure = u.protocol === 'https:';
  var port = +u.port || (secure ? 443 : 80);
  var key = crypto.randomBytes(16).toString('base64');
  var sock = (secure ? tls : net).connect({ host: u.hostname, port: port, servername: u.hostname });
  var buf = Buffer.alloc(0), upgraded = false;
  ws = sock; wsReady = false;
  sock.on('connect', function () {
    sock.write('GET /api/websocket HTTP/1.1\r\nHost: ' + u.host + '\r\nUpgrade: websocket\r\n' +
      'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  if (secure) sock.on('secureConnect', function () { sock.emit('connect'); });
  sock.on('data', function (d) {
    buf = Buffer.concat([buf, d]);
    if (!upgraded) {
      var i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      if (!/ 101 /.test(buf.slice(0, i).toString())) { log('ws upgrade failed'); sock.destroy(); return; }
      upgraded = true; buf = buf.slice(i + 4);
    }
    var f;
    while ((f = parseFrame(buf))) {
      buf = buf.slice(f.len);
      if (f.op === 1) onWsText(f.data.toString());
      else if (f.op === 9) wsSend(f.data, 10);
      else if (f.op === 8) sock.destroy();
    }
  });
  sock.on('error', function (e) { log('ws error', e.message); });
  sock.on('close', function () {
    wsReady = false;
    if (session) endSession('ha disconnected');
    setTimeout(wsConnect, 3000);
  });
}

function parseFrame(b) {
  if (b.length < 2) return null;
  var op = b[0] & 15, len = b[1] & 127, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = b.readUInt32BE(6); off = 10; }
  if (b.length < off + len) return null;
  return { op: op, data: b.slice(off, off + len), len: off + len };
}

function wsSend(payload, op) {
  if (!ws || ws.destroyed) return;
  var data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  var len = data.length, hdr;
  if (len < 126) { hdr = Buffer.alloc(2); hdr[1] = 0x80 | len; }
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[1] = 0x80 | 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[1] = 0x80 | 127; hdr.writeUInt32BE(len, 6); }
  hdr[0] = 0x80 | (op || 1);
  var mask = crypto.randomBytes(4), out = Buffer.alloc(len);
  for (var i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3];
  ws.write(Buffer.concat([hdr, mask, out]));
}

function wsJson(obj, cb) {
  if (obj.type !== 'auth') { obj.id = wsId++; if (cb) pending[obj.id] = cb; }
  wsSend(JSON.stringify(obj), 1);
  return obj.id;
}

function onWsText(t) {
  var m; try { m = JSON.parse(t); } catch (e) { return; }
  if (m.type === 'auth_required') return wsJson({ type: 'auth', access_token: CFG.token });
  if (m.type === 'auth_ok') { wsReady = true; log('ha connected', m.ha_version); return; }
  if (m.type === 'auth_invalid') { log('ha auth invalid'); toast('Home Assistant: zły token'); return; }
  var cb = pending[m.id];
  if (cb) cb(m);
}

// ---------------------------------------------------------------- session
var session = null;

function startSession() {
  if (session) return;
  if (!wsReady) { toast('Brak połączenia z Home Assistant'); return; }
  var s = session = { audio: [], handler: null, sock: null, sub: null, done: false, sent: 0, t0: Date.now() };
  s.maxTimer = setTimeout(function () { stopSession('max length'); }, MAX_MS);

  // 1) HA pipeline: stt -> tts
  var req = { type: 'assist_pipeline/run', start_stage: 'stt', end_stage: 'tts',
    input: { sample_rate: 16000 } };
  if (CFG.pipeline) req.pipeline = CFG.pipeline;
  if (CFG.device_id) req.device_id = CFG.device_id;
  s.runId = wsJson(req, function (m) { onPipelineEvent(s, m); });

  // 2) remote mic via LG voiceinput (retry while the remote reconnects after the key press)
  openMic(s, 0);
}

var VI = 'luna://com.webos.service.voiceinput/';
var VI_PARAMS = { keyType: 'thinQtv', deviceType: 'remote' };
var useHandle = true;   // call voiceinput as "voiceconductor" (needed: it only lets the starter stop)

function openMic(s, attempt) {
  if (s !== session || s.done) return;
  var params = { keyType: 'thinQtv', subscribe: true, deviceType: 'remote' };
  if (useHandle) {
    var c = handles[0].subscribe(VI + 'startStreaming', JSON.stringify(params));
    s.sub = { kill: function () { try { c.cancel(); } catch (e) {} } };
    c.addListener('response', function (msg) {
      var r = {}; try { r = JSON.parse(msg.payload()); } catch (e) {}
      onMicResponse(s, attempt, r, JSON.stringify(r));
    });
    return;
  }
  var buf = '';
  var p = spawnClean('luna-send', ['-i', VI + 'startStreaming', JSON.stringify(params)]);
  s.sub = p;
  p.on('error', function () {});
  p.stdout.on('data', function (d) {
    buf += d;
    var m = /\{[\s\S]*?\}\s*$/.exec(buf);
    if (!m) return;
    var r = {}; try { r = JSON.parse(m[0]); } catch (e) { return; }
    buf = '';
    onMicResponse(s, attempt, r, m[0]);
  });
}

function onMicResponse(s, attempt, r, raw) {
  s.lastOut = raw;
  if (r.returnValue === false && !s.sock) {
    log('voiceinput refused (attempt ' + attempt + '):', raw.replace(/\s+/g, ' ').slice(0, 160));
    s.sub.kill();
    if (/Not permitted|permission/i.test(raw) && useHandle) {
      log('handle not permitted -> falling back to luna-send'); useHandle = false;
      return openMic(s, attempt);
    }
    if (attempt < 15 && !s.done) setTimeout(function () { openMic(s, attempt + 1); }, 200);
    return;
  }
  if (r.socketPath && !s.sock) {
    log('mic open after', Date.now() - s.t0, 'ms (attempt', attempt + ', via ' + (useHandle ? 'handle' : 'luna-send') + ')');
    s.sock = net.connect(r.socketPath);
    s.sock.on('data', function (pcm) { pushAudio(s, pcm); });
    s.sock.on('error', function (e) { log('mic socket error', e.message); });
    // voiceinput stops by itself after a few seconds unless the timer is restarted
    s.keepalive = setInterval(function () { viCall('restartTimer'); }, 2500);
  }
}

function viCall(method, cb) {
  if (useHandle) {
    var c = handles[0].call(VI + method, JSON.stringify(VI_PARAMS));
    c.addListener('response', function (msg) { if (cb) cb(msg.payload()); });
    return;
  }
  var p = spawnClean('luna-send', ['-n', '1', '-w', '3000', VI + method, JSON.stringify(VI_PARAMS)]);
  var out = '';
  p.stdout.on('data', function (d) { out += d; });
  p.on('error', function () {});
  p.on('close', function () { if (cb) cb(out); });
}

function pushAudio(s, pcm) {
  s.bytes = (s.bytes || 0) + pcm.length;
  if (s.handler === null) { s.audio.push(pcm); return; }
  sendAudio(s, pcm);
}

function sendAudio(s, pcm) {
  for (var o = 0; o < pcm.length; o += 4096) {
    var chunk = pcm.slice(o, o + 4096);
    wsSend(Buffer.concat([Buffer.from([s.handler]), chunk]), 2);
    s.sent += chunk.length;
  }
}

function closeMic(s) {
  if (s.keepalive) clearInterval(s.keepalive);
  if (s.sock) { try { s.sock.destroy(); } catch (e) {} }
  if (!s.sock && !s.sub) return;
  // stop as the same client that started (voiceinput answers "permission fail" otherwise),
  // then drop the subscription
  viCall('stopStreaming', function (out) {
    if (!/"returnValue"\s*:\s*true/.test(out)) log('stopStreaming:', String(out).replace(/\s+/g, ' ').slice(0, 160));
    if (s.sub) s.sub.kill();
  });
}

function stopSession(why) {
  var s = session;
  if (!s || s.done) return;
  s.done = true;
  clearTimeout(s.maxTimer);
  // give the socket a moment to flush the tail of the utterance
  setTimeout(function () {
    closeMic(s);
    if (s.handler !== null) {
      while (s.audio.length) sendAudio(s, s.audio.shift());
      wsSend(Buffer.from([s.handler]), 2);            // empty frame = end of audio
    }
    if (!s.sock) log('mic never opened; last voiceinput output:', (s.lastOut || '').replace(/\s+/g, ' ').slice(0, 200));
    log('audio end (' + why + '),', ((s.bytes || 0) / 32000).toFixed(1), 's captured');
    if ((s.bytes || 0) < 8000) { toast('Przytrzymaj przycisk mikrofonu i mów'); endSession('too short'); }
  }, 250);
}

function endSession(why) {
  var s = session;
  if (!s) return;
  if (!s.done) { s.done = true; clearTimeout(s.maxTimer); closeMic(s); }
  delete pending[s.runId];
  session = null;
  log('session end:', why);
}

function onPipelineEvent(s, m) {
  if (m.type === 'result' && !m.success) { log('pipeline error', JSON.stringify(m.error)); toast('Błąd asystenta'); return endSession('run failed'); }
  if (m.type !== 'event') return;
  var e = m.event, d = e.data || {};
  switch (e.type) {
    case 'run-start':
      s.handler = d.runner_data ? d.runner_data.stt_binary_handler_id : null;
      if (s.handler === null || s.handler === undefined) { log('no stt handler'); return endSession('no handler'); }
      while (s.audio.length) sendAudio(s, s.audio.shift());
      if (s.done && s.sent) wsSend(Buffer.from([s.handler]), 2);
      break;
    case 'stt-end':
      var text = d.stt_output && d.stt_output.text;
      log('stt:', text);
      if (text) toast('🎤 ' + text);
      break;
    case 'intent-end':
      var sp = d.intent_output && d.intent_output.response && d.intent_output.response.speech;
      var reply = sp && sp.plain && sp.plain.speech;
      log('reply:', reply && reply.slice(0, 200));
      if (reply && /problem getting a response|RESOURCE_EXHAUSTED|Unable to get response/.test(reply))
        { reply = 'Asystent AI chwilowo niedostępny (limit Gemini) — działają komendy lokalne'; s.muteTts = true; }
      if (reply) toast(reply);
      break;
    case 'tts-end':
      var u = d.tts_output && (d.tts_output.url || d.tts_output.url_path);
      if (u) {
        var full = /^https?:/.test(u) ? u : CFG.ha_url.replace(/\/$/, '') + u;
        if (s.muteTts) break;
        spawnClean('timeout', ['-t', '30', 'mpg123', '-q', full], { stdio: 'ignore' }).on('error', function () {});
      }
      break;
    case 'error':
      log('pipeline event error', d.code, d.message);
      if (d.code !== 'stt-no-text-recognized') toast('Asystent: ' + (d.message || d.code));
      else toast('Nie usłyszałem polecenia');
      break;
    case 'run-end':
      endSession('run-end');
      break;
  }
}

process.on('uncaughtException', function (e) { log('uncaught', e && e.stack || e); });
wsConnect();
setInterval(function () { return handles; }, 1 << 30);
