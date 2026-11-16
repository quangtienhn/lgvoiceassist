#!/usr/bin/env node
// Checks app/i18n.js: every language has the same keys, the same {placeholders} and the same HTML tags
// as English; every key the code asks for exists; no key is left unused. Exit code 1 on any problem.
'use strict';
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var I18N = require(path.join(ROOT, 'app', 'i18n.js'));
var S = I18N.strings, en = S.en, problems = [];

function sorted(re, s) { return (s.match(re) || []).slice().sort().join(' '); }

I18N.langs.forEach(function (l) {
  if (!S[l]) return problems.push(l + ': listed in LANGS but has no strings');
  if (!I18N.names[l]) problems.push(l + ': no entry in NAMES');
  Object.keys(en).forEach(function (k) {
    var v = S[l][k];
    if (typeof v !== 'string' || !v) return problems.push(l + '.' + k + ': missing');
    if (sorted(/\{\w+\}/g, v) !== sorted(/\{\w+\}/g, en[k])) problems.push(l + '.' + k + ': placeholders differ from en');
    if (sorted(/<\/?\w+>/g, v) !== sorted(/<\/?\w+>/g, en[k])) problems.push(l + '.' + k + ': HTML tags differ from en');
    if (/^(hint_|nospy_)/.test(k) ? /&(?!amp;|lt;|gt;)/.test(v) : /[<>]/.test(v)) problems.push(l + '.' + k + ': unescaped markup');
  });
  Object.keys(S[l]).forEach(function (k) { if (!(k in en)) problems.push(l + '.' + k + ': not in en'); });
});
Object.keys(S).forEach(function (l) { if (I18N.langs.indexOf(l) < 0) problems.push(l + ': has strings but is not in LANGS'); });

// keys the code uses
var files = ['app/app.js', 'app/index.html', 'app/daemon/satellite.js'];
var src = files.map(function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }).join('\n');
var m, asked = /(?:\b[tT]\(\s*|data-i18n=)['"]([a-z0-9_]+)['"]/g;
while ((m = asked.exec(src))) if (!(m[1] in en)) problems.push('code uses unknown key "' + m[1] + '"');
Object.keys(en).forEach(function (k) {
  if (src.indexOf("'" + k + "'") < 0 && src.indexOf('"' + k + '"') < 0) problems.push('en.' + k + ': not used anywhere');
});

// no translatable text left in the code: non-ASCII letters outside comments are a sign of it
files.forEach(function (f) {
  fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach(function (line, i) {
    var code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (/[À-ɏ]/.test(code)) problems.push(f + ':' + (i + 1) + ': untranslated text? ' + line.trim().slice(0, 60));
  });
});

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('i18n ok: ' + I18N.langs.join(', ') + ' x ' + Object.keys(en).length + ' keys');
