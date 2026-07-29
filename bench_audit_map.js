// ════════════════════════════════════════════════════════════════════
//  bench_audit_map.js (s77) — banco ESTRUCTURAL del comando /audit del mapa.
//  Verifica sobre el HTML real que el comando está cableado: URL de la ruta,
//  captura del snapshot (con griegas), persistencia en localStorage, y que
//  auditRun arma la llamada a /alpaca-audit con todos los params del snapshot.
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

ok('1 AUDIT_URL apunta a /alpaca-audit', /AUDIT_URL = POLY_PROXY\.replace\('\/alpaca', '\/alpaca-audit'\)/.test(html), 'url');
ok('2 despacho /AUDIT en la casilla TICKER (antes del guard de longitud)',
   /if\(s\.startsWith\('\/AUDIT'\)\)\{/.test(html) && html.indexOf("startsWith('/AUDIT')") < html.indexOf('guard de alta de ticker'), 'dispatch');
ok('3 /audit save → auditCapture(earnings opcional)', /if\(arg==='SAVE'\|\|arg==='CAP'\) auditCapture\(toks\[2\]\|\|null\)/.test(html), 'save');
ok('4 /audit clear y list', /localStorage\.removeItem\('lm_audit'\)/.test(html) && /arg==='LIST'/.test(html), 'clear/list');
ok('5 captura el SNAPSHOT con griegas (mid/delta/gamma/theta/be del elegido)',
   /mid:e\.mid, delta:e\.delta, gamma:e\.gamma, theta:e\.theta, be:e\.breakevenMov/.test(html), 'greeks');
ok('6 captura spot0 y entry (ISO de ahora)', /entry:new Date\(\)\.toISOString\(\), spot0:j\.spot/.test(html), 'entry/spot0');
ok('7 TP/SL del snapshot vienen de getTargets (fuente única del panel)',
   /getTargets\(j\.spot, sig\.type, tf, sym\)/.test(html), 'getTargets');
ok('8 persiste en localStorage bajo lm_audit', /localStorage\.setItem\('lm_audit'/.test(html), 'persist');
ok('9 auditRun arma la llamada a /alpaca-audit con contract+entry+griegas+tp+sl',
   /URLSearchParams\(\{ contract:rec\.contract[\s\S]*?tp1:rec\.tp1[\s\S]*?sl:rec\.sl/.test(html) && /\$\{AUDIT_URL\}\?\$\{qs\.toString\(\)\}/.test(html), 'run');
ok('10 pasa earnings al backend si el snapshot lo tiene', /if\(rec\.earnings\) qs\.set\('earnings',rec\.earnings\)/.test(html), 'earnings');
ok('11 muestra outcome + prima real vs proyectada + R/R real',
   /real '\+t\.realPremium\+' vs proy '\+t\.projPremium/.test(html) && /R\/R real en prima/.test(html), 'render');
ok('12 expone window.auditCapture / window.auditRun', /window\.auditCapture=auditCapture; window\.auditRun=auditRun/.test(html), 'expose');

console.log(`\n${fail === 0 ? '✅' : '❌'} bench_audit_map: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
