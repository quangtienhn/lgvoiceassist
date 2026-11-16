/* LG TV Assist UI (webOS web app, ES5 for old Chromium). Texts come from i18n.js. */
(function () {
  'use strict';
  var SVC = 'luna://io.github.xrogers.lgtvassist.service/';
  var I18N = window.LGTV_I18N;
  var bridges = [];
  var state = { status: null, showLog: false, busy: false, localLang: null, localeSent: false };
  var $ = function (id) { return document.getElementById(id); };

  // ---------------- language: the "lang" setting, otherwise the TV menu language
  function tvLocale() {
    try { if (window.PalmSystem && PalmSystem.locale) return String(PalmSystem.locale); } catch (e) {}
    return navigator.language || 'en';
  }
  var lang = null;
  function t(key, params) { return I18N.t(lang, key, params); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function applyLang(setting) {
    var next = I18N.resolve(setting, tvLocale());
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = lang;
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
  }
  applyLang(null);

  function luna(uri, params, cb) {
    if (typeof PalmServiceBridge === 'undefined') { cb({ returnValue: false, errorText: 'PalmServiceBridge unavailable' }); return; }
    var b = new PalmServiceBridge();
    bridges.push(b);
    b.onservicecallback = function (res) {
      bridges.splice(bridges.indexOf(b), 1);
      var r; try { r = JSON.parse(res); } catch (e) { r = { returnValue: false, errorText: String(res) }; }
      cb(r);
    };
    b.call(uri, JSON.stringify(params || {}));
  }

  function msg(text) { $('msg').textContent = text || ''; }
  function fail(r) { msg(r.returnValue ? '' : t('msg_error', { err: r.errorText || '' })); }
  function setCard(id, cls) { var el = $(id); el.className = 'card ' + cls; }
  function onOff(v) { return t(v ? 'on' : 'off'); }

  function render(s) {
    state.status = s;
    var d = s.daemon || {}, set = s.settings || {};
    // without root the service cannot save settings: a language chosen then lives only in this page
    applyLang(s.root ? set.lang : state.localLang);
    // tell the daemon which language the TV menu uses (it shows the toasts)
    if (s.root && s.settings && !state.localeSent) {
      state.localeSent = true;
      if (set.tv_locale !== tvLocale()) luna(SVC + 'setSettings', { tv_locale: tvLocale() }, function () {});
    }

    $('ver').textContent = 'v' + (d.version || '?');
    if (!s.root) { $('service').textContent = t('svc_noroot'); setCard('c-service', 'bad'); }
    else if (s.running) { $('service').textContent = t('svc_running'); setCard('c-service', 'ok'); }
    else if (!s.enabled) { $('service').textContent = t('svc_disabled'); setCard('c-service', 'warn'); }
    else { $('service').textContent = t('svc_stopped'); setCard('c-service', 'bad'); }

    var connected = s.running && d.ha;
    $('ha').textContent = connected ? t('ha_connected', { ha: d.ha }) : t('ha_waiting');
    setCard('c-ha', connected ? 'ok' : 'warn');
    $('addr').textContent = (d.ip || '?') + ':' + (d.port || 6053) + '  (' + (d.name || 'lg-tv-assist') + ')';
    var handsOn = set.hands_free !== false;
    var micName = d.usbMic ? d.usbMic.replace(/^alsa_input\.usb-/, '').replace(/\.analog-.*$/, '').replace(/-\d+$/, '').replace(/_/g, ' ') : null;
    $('usb').textContent = !micName ? t('usb_none')
      : !handsOn ? t('usb_off', { mic: micName })
      : d.listening ? t('usb_listening', { mic: micName }) : micName;
    $('b-hands').textContent = t('btn_hands', { v: onOff(handsOn) });
    $('b-wscreen').textContent = t('btn_wscreen', { v: onOff(set.wake_screen !== false) });
    $('b-wscreen').className = 'btn' + (d.usbMic && handsOn ? '' : ' hidden');
    // encryption key: Home Assistant asks for it, so show it whenever encryption is on
    var encOn = set.encryption === true;
    $('b-enc').textContent = t('btn_enc', { v: onOff(encOn) });
    $('b-enc').className = 'btn' + (s.root ? '' : ' hidden');
    $('keyrow').className = encOn && set.api_key ? '' : 'hidden';
    $('key').textContent = encOn && set.api_key ? set.api_key : '';
    var reply = d.lastReply || (d.lastError ? '⚠ ' + d.lastError : '');
    if (/problem getting a response|RESOURCE_EXHAUSTED|Unable to get response/.test(reply)) reply = t('ai_unavailable');
    state.full = t('you') + ' ' + (d.lastText || '—') + '\n\n' + t('assistant') + ' ' + (reply || '—') +
      (d.lastError ? '\n\n' + t('last_error') + ' ' + d.lastError : '');
    $('lastText').textContent = d.lastText || '—';
    $('lastReply').textContent = reply || '—';

    var hint;
    if (!s.root) hint = t('hint_root');
    else if (!connected) hint = t('hint_connect', { name: esc(set.friendly_name || 'LG TV'), ip: esc(d.ip || '?'), port: esc(d.port || 6053),
      key: t(encOn ? 'key_shown' : 'key_none') });
    else if (d.usbMic && handsOn) hint = t('hint_handsfree');
    else hint = t('hint_ptt');
    $('hint').innerHTML = hint;

    // Life's Good Without Spying: our exceptions must be on while it blocks voice services
    var ns = s.nospy || {}, nsHtml = '';
    if (ns.installed && ns.voiceBlocked && !ns.ok) nsHtml = t('nospy_blocked');
    else if (ns.installed && !ns.voiceBlocked && !(ns.savedKeep && ns.savedClaim)) nsHtml = t('nospy_registered');
    $('nospy').innerHTML = nsHtml;
    $('nospy').className = 'card hint nospy' + (nsHtml ? '' : ' hidden');
    $('b-nospy').className = 'btn' + (ns.installed && nsHtml ? '' : ' hidden');

    $('b-elevate').className = 'btn' + (s.root ? ' hidden' : '');
    $('b-toggle').textContent = t(s.enabled ? 'btn_off' : 'btn_on');
    var toasts = s.settings ? set.toasts : true;
    $('b-toasts').textContent = t('btn_toasts', { v: toasts === false ? t('off') : toasts === 'listen' ? t('toasts_listen') : t('toasts_all') });
    var chosen = s.root ? set.lang : state.localLang;
    $('b-lang').textContent = t('btn_lang', { v: I18N.strings.hasOwnProperty(chosen) ? I18N.names[chosen] : t('lang_auto', { name: I18N.names[lang] }) });

    fixFocus();
    fit();
  }

  // Long translations, or every card showing at once, can outgrow the screen: scale the page down to fit.
  // (Making it wider in turn re-flows the text into fewer lines, so one pass is always enough.)
  function fit() {
    var w = $('wrap'), H = window.innerHeight;
    w.style.transform = ''; w.style.width = ''; w.style.height = '';
    var h = w.scrollHeight;
    if (h <= H) return;
    var z = H / h;
    w.style.transformOrigin = '0 0';
    w.style.transform = 'scale(' + z + ')';
    w.style.width = (100 / z) + '%';
    w.style.height = (100 / z) + '%';
  }

  var NO_ROOT = { root: false, enabled: true, running: false, daemon: {}, settings: {} };

  function refresh() {
    luna(SVC + 'status', {}, function (r) {
      if (r.returnValue === false && !r.root) {
        render(NO_ROOT);
        if (r.errorText && !/root/.test(r.errorText)) msg(t('msg_service', { err: r.errorText }));
        return;
      }
      render(r);
    });
  }

  var actions = {
    elevate: function () {
      msg(t('msg_elevating'));
      luna('luna://org.webosbrew.hbchannel.service/elevateService', { id: 'io.github.xrogers.lgtvassist.service' }, function (r) {
        if (r.returnValue) {
          msg(t('msg_elevated'));
          setTimeout(function () {
            luna(SVC + 'start', {}, function (s) { msg(s.returnValue ? t('msg_started') : t('msg_reopen', { err: s.errorText || '' })); refresh(); });
          }, 1500);
        } else msg(t('msg_failed', { err: r.errorText || JSON.stringify(r) }));
      });
    },
    toggle: function () {
      var s = state.status || {};
      msg(t(s.enabled ? 'msg_turning_off' : 'msg_turning_on'));
      luna(SVC + (s.enabled ? 'stop' : 'start'), {}, function (r) { fail(r); refresh(); });
    },
    restart: function () {
      msg(t('msg_restarting'));
      luna(SVC + 'restart', {}, function (r) { msg(r.returnValue ? t('msg_restarted') : t('msg_error', { err: r.errorText || '' })); refresh(); });
    },
    toasts: function () {
      // cycle: all -> listening only -> off -> all
      var cur = state.status && state.status.settings ? state.status.settings.toasts : true;
      var next = cur === false ? true : cur === 'listen' ? false : 'listen';
      luna(SVC + 'setSettings', { toasts: next }, function (r) { fail(r); setTimeout(refresh, 1500); });
    },
    lang: function () {
      // cycle: auto (TV menu language) -> each language -> auto
      var s = state.status || NO_ROOT, order = ['auto'].concat(I18N.langs);
      var cur = s.root ? (s.settings || {}).lang : state.localLang;
      var next = order[(order.indexOf(I18N.strings.hasOwnProperty(cur) ? cur : 'auto') + 1) % order.length];
      if (!s.root) { state.localLang = next; render(s); return; }
      luna(SVC + 'setSettings', { lang: next }, function (r) {
        fail(r);
        if (r.returnValue && r.settings) { s.settings = r.settings; render(s); }
      });
    },
    enc: function () {
      var s = state.status || NO_ROOT, cur = (s.settings || {}).encryption === true;
      luna(SVC + 'setSettings', { encryption: !cur }, function (r) {
        msg(r.returnValue ? t(cur ? 'msg_enc_off' : 'msg_enc_on') : t('msg_error', { err: r.errorText || '' }));
        if (r.returnValue && r.settings) { s.settings = r.settings; render(s); }
      });
    },
    log: function () { openLog(); },
    detail: function () { openDetail(); },
    wscreen: function () {
      var cur = !(state.status && state.status.settings && state.status.settings.wake_screen === false);
      luna(SVC + 'setSettings', { wake_screen: !cur }, function (r) { fail(r); setTimeout(refresh, 4000); });
    },
    hands: function () {
      var cur = !(state.status && state.status.settings && state.status.settings.hands_free === false);
      msg(t(cur ? 'msg_hands_off' : 'msg_hands_on'));
      luna(SVC + 'setSettings', { hands_free: !cur }, function (r) { fail(r); setTimeout(refresh, 4000); });
    },
    nospy: function () {
      luna('luna://com.webos.applicationManager/launch', { id: 'ooo.lew.lifesgoodwithoutspying' }, function (r) {
        if (!r.returnValue) msg(t('msg_open_failed', { err: r.errorText || '' }));
      });
    }
  };

  // ---------------- remote navigation
  var focusIdx = 0;
  function visibleButtons() {
    return Array.prototype.filter.call(document.querySelectorAll('.btn'), function (b) { return b.className.indexOf('hidden') < 0; });
  }
  function fixFocus() {
    var bs = visibleButtons();
    if (focusIdx >= bs.length) focusIdx = bs.length - 1;
    if (focusIdx < 0) focusIdx = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.btn'), function (b) { b.className = b.className.replace(/\s*focus/g, ''); });
    if (bs[focusIdx]) bs[focusIdx].className += ' focus';
  }
  // ---------------- scrollable full-screen panel (last conversation / log)
  var panel = null, panelY = 0;   // panel: { kind: 'detail'|'log' }
  function showPanel(kind, title, text, toEnd) {
    panel = { kind: kind };
    $('detailTitle').textContent = title;
    $('detailFoot').textContent = t(kind === 'log' ? 'foot_log' : 'foot_detail');
    $('detailText').textContent = text || '—';
    $('detail').className = kind === 'log' ? 'log' : '';
    panelY = toEnd ? 1e9 : 0;
    scrollPanel(0);
  }
  function closePanel() { panel = null; $('detail').className = 'hidden'; }
  function scrollPanel(delta) {
    var box = $('detail').querySelector('.body'), inner = $('detailText');
    var max = Math.max(0, inner.offsetHeight - box.clientHeight);
    panelY = Math.max(0, Math.min(max, panelY + delta));
    inner.style.transform = 'translateY(' + (-panelY) + 'px)';
  }
  function openDetail() { showPanel('detail', t('card_last'), state.full, false); }
  function openLog() {
    luna(SVC + 'status', { log: 200 }, function (r) { showPanel('log', t('panel_log'), r.log || t('log_empty'), true); });
  }

  document.addEventListener('keydown', function (e) {
    if (panel) {
      var page = $('detail').querySelector('.body').clientHeight - 40;
      if (e.keyCode === 38) scrollPanel(-120);
      else if (e.keyCode === 40) scrollPanel(120);
      else if (e.keyCode === 33) scrollPanel(-page);            // channel up / page up
      else if (e.keyCode === 34) scrollPanel(page);             // channel down / page down
      else if (e.keyCode === 13 && panel.kind === 'log') openLog();
      else if (e.keyCode === 13 || e.keyCode === 461 || e.keyCode === 27) closePanel();
      e.preventDefault();
      return;
    }
    var bs = visibleButtons();
    switch (e.keyCode) {
      case 37: case 38: focusIdx = Math.max(0, focusIdx - 1); fixFocus(); break;          // left / up
      case 39: case 40: focusIdx = Math.min(bs.length - 1, focusIdx + 1); fixFocus(); break; // right / down
      case 13: if (bs[focusIdx]) actions[bs[focusIdx].getAttribute('data-act')](); break;    // OK
      case 461: case 27:                                                                     // Back
        if (window.PalmSystem && PalmSystem.platformBack) PalmSystem.platformBack(); else window.close();
        break;
      default: return;
    }
    e.preventDefault();
  });
  Array.prototype.forEach.call(document.querySelectorAll('.btn'), function (b, i) {
    b.addEventListener('click', function () { actions[b.getAttribute('data-act')](); });
    b.addEventListener('mouseover', function () { focusIdx = visibleButtons().indexOf(b); fixFocus(); });   // Magic Remote pointer
  });

  document.addEventListener('wheel', function (e) { if (panel) { scrollPanel(e.deltaY > 0 ? 120 : -120); e.preventDefault(); } });

  // first run: if we have root but the service was never started, start it
  luna(SVC + 'status', {}, function (r) {
    if (r.root && r.enabled && !r.running) luna(SVC + 'start', {}, function () { refresh(); });
    else render(r.returnValue === false ? NO_ROOT : r);
  });
  setInterval(refresh, 3000);

  // launch parameter {"panel":"log"|"detail"} opens a panel directly (handy for testing)
  try {
    var lp = window.PalmSystem && PalmSystem.launchParams ? JSON.parse(PalmSystem.launchParams || '{}') : {};
    if (lp.panel === 'log') setTimeout(openLog, 800);
    else if (lp.panel === 'detail') setTimeout(openDetail, 800);
  } catch (e) {}
})();
