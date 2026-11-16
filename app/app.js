/* LG TV Assist UI (webOS web app, ES5 for old Chromium). */
(function () {
  'use strict';
  var SVC = 'luna://io.github.xrogers.lgtvassist.service/';
  var bridges = [];
  var state = { status: null, showLog: false, busy: false };
  var $ = function (id) { return document.getElementById(id); };

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

  function msg(t) { $('msg').textContent = t || ''; }
  function setCard(id, cls) { var el = $(id); el.className = 'card ' + cls; }

  function render(s) {
    state.status = s;
    var d = s.daemon || {};
    $('ver').textContent = 'v' + (d.version || '?');
    if (!s.root) { $('service').textContent = 'brak uprawnień roota'; setCard('c-service', 'bad'); }
    else if (s.running) { $('service').textContent = 'działa'; setCard('c-service', 'ok'); }
    else if (!s.enabled) { $('service').textContent = 'wyłączona (przycisk mikrofonu obsługuje LG)'; setCard('c-service', 'warn'); }
    else { $('service').textContent = 'zatrzymana'; setCard('c-service', 'bad'); }

    var connected = s.running && d.ha;
    $('ha').textContent = connected ? 'połączony — ' + d.ha : 'czeka na połączenie';
    setCard('c-ha', connected ? 'ok' : 'warn');
    $('addr').textContent = (d.ip || '?') + ':' + (d.port || 6053) + '  (' + (d.name || 'lg-tv-assist') + ')';
    var handsOn = !s.settings || s.settings.hands_free !== false;
    var micName = d.usbMic ? d.usbMic.replace(/^alsa_input\.usb-/, '').replace(/\.analog-.*$/, '').replace(/-\d+$/, '').replace(/_/g, ' ') : null;
    $('usb').textContent = !micName ? 'brak — podłącz mikrofon USB do telewizora'
      : !handsOn ? micName + ' — tryb wyłączony'
      : (d.listening ? '● nasłuchuje „Okay Nabu” — ' : '') + micName;
    $('b-hands').textContent = 'Bez pilota: ' + (handsOn ? 'wł.' : 'wył.');
    $('b-wscreen').textContent = 'Ekran po słowie: ' + ((!s.settings || s.settings.wake_screen !== false) ? 'wł.' : 'wył.');
    $('b-wscreen').className = 'btn' + (d.usbMic && handsOn ? '' : ' hidden');
    var reply = d.lastReply || (d.lastError ? '⚠ ' + d.lastError : '');
    if (/problem getting a response|RESOURCE_EXHAUSTED|Unable to get response/.test(reply)) reply = 'Asystent AI chwilowo niedostępny — działają komendy lokalne';
    state.full = 'Ty: ' + (d.lastText || '—') + '\n\nAsystent: ' + (reply || '—') + (d.lastError ? '\n\nOstatni błąd: ' + d.lastError : '');
    $('lastText').textContent = d.lastText || '—';
    $('lastReply').textContent = reply || '—';

    var hint;
    if (!s.root) hint = 'Usługa potrzebuje uprawnień roota, żeby przejąć przycisk mikrofonu pilota. Wybierz <b>Nadaj uprawnienia</b>, a potem uruchom aplikację ponownie.';
    else if (!connected) hint = 'W Home Assistant otwórz <b>Ustawienia → Urządzenia i usługi</b>. Telewizor pojawi się jako wykryte urządzenie ESPHome <b>„' +
      ((s.settings && s.settings.friendly_name) || 'LG TV') + '”</b> — kliknij <b>Dodaj</b>. Ręcznie: integracja ESPHome, host <b>' + (d.ip || '?') + '</b>, port <b>' + (d.port || 6053) + '</b>, bez klucza.';
    else if (d.usbMic && (!s.settings || s.settings.hands_free !== false)) hint = 'Powiedz <b>„Okay Nabu”</b> i polecenie (mikrofon USB, słowo wykrywa Home Assistant) albo przytrzymaj <b>przycisk mikrofonu</b> na pilocie. Po usłyszeniu słowa telewizor się przycisza. Słowo aktywujące zmienisz w Home Assistant, w ustawieniach asystenta.';
    else hint = 'Przytrzymaj <b>przycisk mikrofonu</b> na pilocie, powiedz polecenie i puść. Odpowiedź pojawi się w dymku i zostanie odczytana. Komunikaty z Home Assistant (assist_satellite.announce) też są odtwarzane na telewizorze.';
    $('hint').innerHTML = hint;

    // Life's Good Without Spying: our exceptions must be on while it blocks voice services
    var ns = s.nospy || {}, nsHtml = '';
    if (ns.installed && ns.voiceBlocked && !ns.ok) {
      nsHtml = '<b>Life\'s Good Without Spying blokuje usługi głosowe</b>, a bez nich pilot nie przekaże dźwięku. ' +
        'Otwórz tę aplikację i w sekcji <b>Exceptions</b> włącz <b>„LG TV Assist: voiceinput”</b> oraz ' +
        '<b>„LG TV Assist: voiceconductor”</b>, a potem zatwierdź zmiany (Update protection).';
    } else if (ns.installed && !ns.voiceBlocked && !(ns.savedKeep && ns.savedClaim)) {
      nsHtml = 'Life\'s Good Without Spying: LG TV Assist zgłosił wyjątki (voiceinput, voiceconductor). ' +
        'Jeśli włączysz blokadę usług głosowych (Voice), włącz też te wyjątki w sekcji <b>Exceptions</b>, żeby aplikacje sobie nie przeszkadzały.';
    }
    $('nospy').innerHTML = nsHtml;
    $('nospy').className = 'card hint nospy' + (nsHtml ? '' : ' hidden');
    $('b-nospy').className = 'btn' + (ns.installed && nsHtml ? '' : ' hidden');

    $('b-elevate').className = 'btn' + (s.root ? ' hidden' : '');
    $('b-toggle').textContent = s.enabled ? 'Wyłącz' : 'Włącz';
    var toasts = !s.settings || s.settings.toasts !== false;
    $('b-toasts').textContent = 'Dymki: ' + (toasts ? 'wł.' : 'wył.');
    $('b-log').textContent = state.showLog ? 'Ukryj log' : 'Pokaż log';
    if (state.showLog) { $('log').style.display = 'block'; $('log').textContent = s.log || '(pusty)'; }
    else $('log').style.display = 'none';
    fixFocus();
  }

  function refresh() {
    luna(SVC + 'status', { log: state.showLog ? 18 : 0 }, function (r) {
      if (r.returnValue === false && !r.root) {
        render({ root: false, enabled: true, running: false, daemon: {}, settings: {} });
        if (r.errorText && !/root/.test(r.errorText)) msg('Usługa: ' + r.errorText);
        return;
      }
      render(r);
    });
  }

  var actions = {
    elevate: function () {
      msg('Proszę Homebrew Channel o uprawnienia…');
      luna('luna://org.webosbrew.hbchannel.service/elevateService', { id: 'io.github.xrogers.lgtvassist.service' }, function (r) {
        if (r.returnValue) {
          msg('Gotowe. Uruchamiam usługę…');
          setTimeout(function () { luna(SVC + 'start', {}, function (s) { msg(s.returnValue ? 'Usługa uruchomiona.' : 'Uruchom aplikację ponownie (' + (s.errorText || '') + ')'); refresh(); }); }, 1500);
        } else msg('Nie udało się: ' + (r.errorText || JSON.stringify(r)));
      });
    },
    toggle: function () {
      var s = state.status || {};
      msg(s.enabled ? 'Wyłączam — przycisk mikrofonu wraca do asystenta LG…' : 'Włączam…');
      luna(SVC + (s.enabled ? 'stop' : 'start'), {}, function (r) { msg(r.returnValue ? '' : 'Błąd: ' + (r.errorText || '')); refresh(); });
    },
    restart: function () {
      msg('Uruchamiam ponownie…');
      luna(SVC + 'restart', {}, function (r) { msg(r.returnValue ? 'Uruchomiono ponownie.' : 'Błąd: ' + (r.errorText || '')); refresh(); });
    },
    toasts: function () {
      var cur = !(state.status && state.status.settings && state.status.settings.toasts === false);
      luna(SVC + 'setSettings', { toasts: !cur }, function (r) { msg(r.returnValue ? '' : 'Błąd: ' + (r.errorText || '')); setTimeout(refresh, 3500); });
    },
    log: function () { state.showLog = !state.showLog; refresh(); },
    detail: function () { openDetail(); },
    wscreen: function () {
      var cur = !(state.status && state.status.settings && state.status.settings.wake_screen === false);
      luna(SVC + 'setSettings', { wake_screen: !cur }, function (r) { msg(r.returnValue ? '' : 'Błąd: ' + (r.errorText || '')); setTimeout(refresh, 4000); });
    },
    hands: function () {
      var cur = !(state.status && state.status.settings && state.status.settings.hands_free === false);
      msg(cur ? 'Wyłączam tryb bez pilota…' : 'Włączam tryb bez pilota…');
      luna(SVC + 'setSettings', { hands_free: !cur }, function (r) { msg(r.returnValue ? '' : 'Błąd: ' + (r.errorText || '')); setTimeout(refresh, 4000); });
    },
    nospy: function () {
      luna('luna://com.webos.applicationManager/launch', { id: 'ooo.lew.lifesgoodwithoutspying' }, function (r) {
        if (!r.returnValue) msg('Nie udało się otworzyć: ' + (r.errorText || ''));
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
  // ---------------- full-text panel (scrollable with up/down)
  var detailOpen = false, detailY = 0;
  function openDetail() {
    detailOpen = true; detailY = 0;
    $('detailText').textContent = state.full || '—';
    $('detailText').style.transform = 'translateY(0)';
    $('detail').className = '';
  }
  function closeDetail() { detailOpen = false; $('detail').className = 'hidden'; }
  function scrollDetail(dir) {
    var box = $('detail').querySelector('.body'), inner = $('detailText');
    var max = Math.max(0, inner.offsetHeight - box.clientHeight);
    detailY = Math.max(0, Math.min(max, detailY + dir * 120));
    inner.style.transform = 'translateY(' + (-detailY) + 'px)';
  }

  document.addEventListener('keydown', function (e) {
    if (detailOpen) {
      if (e.keyCode === 38) scrollDetail(-1);
      else if (e.keyCode === 40) scrollDetail(1);
      else if (e.keyCode === 13 || e.keyCode === 461 || e.keyCode === 27) closeDetail();
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

  // first run: if we have root but the service was never started, start it
  luna(SVC + 'status', {}, function (r) {
    if (r.root && r.enabled && !r.running) luna(SVC + 'start', {}, function () { refresh(); });
    else render(r.returnValue === false ? { root: false, enabled: true, running: false, daemon: {}, settings: {} } : r);
  });
  setInterval(refresh, 3000);
})();
