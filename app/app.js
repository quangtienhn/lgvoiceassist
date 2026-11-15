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
    $('lastText').textContent = d.lastText || '—';
    $('lastReply').textContent = d.lastReply || (d.lastError ? '⚠ ' + d.lastError : '—');

    var hint;
    if (!s.root) hint = 'Usługa potrzebuje uprawnień roota, żeby przejąć przycisk mikrofonu pilota. Wybierz <b>Nadaj uprawnienia</b>, a potem uruchom aplikację ponownie.';
    else if (!connected) hint = 'W Home Assistant otwórz <b>Ustawienia → Urządzenia i usługi</b>. Telewizor pojawi się jako wykryte urządzenie ESPHome <b>„' +
      ((s.settings && s.settings.friendly_name) || 'LG TV') + '”</b> — kliknij <b>Dodaj</b>. Ręcznie: integracja ESPHome, host <b>' + (d.ip || '?') + '</b>, port <b>' + (d.port || 6053) + '</b>, bez klucza.';
    else hint = 'Przytrzymaj <b>przycisk mikrofonu</b> na pilocie, powiedz polecenie i puść. Odpowiedź pojawi się w dymku i zostanie odczytana. Komunikaty z Home Assistant (assist_satellite.announce) też są odtwarzane na telewizorze.';
    $('hint').innerHTML = hint;

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
    log: function () { state.showLog = !state.showLog; refresh(); }
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
  document.addEventListener('keydown', function (e) {
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
