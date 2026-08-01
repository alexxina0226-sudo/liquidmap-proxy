// bench_cvd_map.js — Banco ESTRUCTURAL de la Etapa 3a (FASE 3, s81).
// No hay DOM en Node, asi que se verifica el CABLEADO leyendo el HTML real:
// que el CVD por agresor se muestre en fl-cvdagg y que sea DISPLAY-ONLY
// (jamas toque cvd/buyV/sellV/cvdReal/score → el motor queda igual).
'use strict';
const fs = require('fs');
const H = fs.readFileSync(__dirname + '/LiquidityMap_BOLSA_v5.html', 'utf8');

let pass=0, fail=0;
function ok(n,c){ if(c){pass++;console.log('  ✓ '+n);}else{fail++;console.log('  ✗ '+n);} }

// aislar el cuerpo de updateAggressorCVD
const fn = (H.match(/function updateAggressorCVD[\s\S]*?\nwindow\.updateAggressorCVD/) || [''])[0];

console.log('\n=== 1. CABLEADO PRESENTE ===');
ok('CVD_URL apunta a /alpaca-cvd', /const CVD_URL\s*=\s*POLY_PROXY\.replace\('\/alpaca',\s*'\/alpaca-cvd'\)/.test(H));
ok('constante de ventana CVD_AGG_WINDOW_MIN definida', /const CVD_AGG_WINDOW_MIN\s*=\s*\d+/.test(H));
ok('funcion updateAggressorCVD definida', fn.length > 0);
ok('se llama con (sym, tf, candles) en el panel', /updateAggressorCVD\(sym,\s*tf,\s*candles\)/.test(H));
ok('escribe en el slot fl-cvdagg', /getElementById\('fl-cvdagg'\)/.test(fn));
ok('pide a CVD_URL con sym/start/end', /fetch\(`\$\{CVD_URL\}\?sym=/.test(fn) && /start=/.test(fn) && /end=/.test(fn));

console.log('\n=== 2. DISPLAY-ONLY: el motor/score NO se toca ===');
ok('updateAggressorCVD NO asigna cvd=',    !/\bcvd\s*=(?!=)/.test(fn.replace(/cvdReal|cvdM|_cvdAgg/g,'')));
ok('updateAggressorCVD NO asigna buyV=',   !/\bbuyV\s*=(?!=)/.test(fn));
ok('updateAggressorCVD NO asigna sellV=',  !/\bsellV\s*=(?!=)/.test(fn));
ok('updateAggressorCVD NO asigna cvdReal=',!/\bcvdReal\s*=(?!=)/.test(fn));
ok('updateAggressorCVD NO toca score',     !/\bscore\s*[+\-]?=/.test(fn));
ok('solo lee del JSON de la ruta (j.cvd/j.buyV/j.sellV/j.cvdReal), no variables globales', /j\.cvd\b/.test(fn) && /j\.cvdReal/.test(fn));

console.log('\n=== 3. EL MOTOR SIGUE EN EL CVD ESTIMADO (score intacto) ===');
// la CAPA 3 del score sigue leyendo la variable `cvd` (estimada), no la ruta
ok('CAPA 3 del score sigue leyendo cvd estimado', /else if\(cvd > 0\) \{ score \+= 1\.5;/.test(H));
ok('CAPA 5 (Presion) sigue leyendo buyV/sellV', /if\(buyV \+ sellV <= 0\)\{ addL\('Presión'/.test(H));
// el computo estimado en loadCandles sigue ahi (direccion de vela)
ok('loadCandles conserva el CVD estimado por direccion de vela', /cvd = cvdBars\.reduce\(\(a,b\) => a\+\(b\.c>=b\.o\?b\.v:-b\.v\), 0\)/.test(H));

console.log('\n=== 4. SOLO fl-cvdagg se destraba; prints/dpool siguen con candado ===');
ok('fl-prints sigue 🔒 Developer $79', /id="fl-prints"[^>]*>🔒 Developer \$79/.test(H));
ok('fl-dpool sigue 🔒 Developer $79',  /id="fl-dpool"[^>]*>🔒 Developer \$79/.test(H));
ok('fl-cvdagg YA NO tiene el candado estatico', !/id="fl-cvdagg"[^>]*>🔒 Developer \$79/.test(H));

console.log('\n=== 5. THROTTLE / ROBUSTEZ ===');
ok('throttle por simbolo (_cvdAgg)', /_cvdAgg\s*=\s*\{\s*key:null/.test(H));
ok('guarda de cambio de simbolo (key!==_cvdAgg.key)', /_cvdAgg\.key!==key/.test(fn));
ok('maneja error de la ruta (status!==OK)', /j\.status!=='OK'/.test(fn));
ok('honesto: sin trades reales -> "sin flujo"', /'sin flujo'/.test(fn));
ok('marca PARCIAL si la ruta trunca', /j\.partial/.test(fn));

console.log('\n=== 6. VENTANA MERCADO CERRADO: segundos→ms (anti-1970, fix s83) ===');
// Bug s83: lastBar.t está en SEGUNDOS (todo el mapa usa new Date(b.t*1000)).
// Sin *1000, la ventana con mercado cerrado caía en 1970 → 'sin flujo' siempre.
const endMsExpr = ((fn.match(/const endMs\s*=\s*open\s*\?\s*now\s*:\s*\(([^;]*)\)\s*;/) || [,''])[1] || '').trim();
ok('rama cerrada multiplica lastBar.t por 1000', /lastBar\.t\s*\*\s*1000/.test(endMsExpr));
ok('NO usa lastBar.t crudo sin *1000 (anti-regresión del bug 1970)', !/lastBar\.t\s*\+/.test(endMsExpr));
// chequeo NUMÉRICO sobre la EXPRESIÓN REAL del HTML: con un ts de viernes en
// segundos, la ventana debe caer en fecha reciente (>=2020), no en 1970.
let yearClosed = null;
try {
  const f = new Function('lastBar','tfMin','now','open', 'return (open ? now : (' + endMsExpr + '));');
  const endMs = f({ t: 1785600000 }, 60, Date.now(), false);   // 1785600000 s ≈ ago-2026
  yearClosed = new Date(endMs).getUTCFullYear();
} catch (e) { yearClosed = 'ERR:' + e.message; }
ok('ventana cerrada (expr real del HTML) cae en año >= 2020 (no 1970)', yearClosed >= 2020);
// y el camino abierto sigue usando `now` (ms) sin tocar
ok('rama abierta usa now (ms) directo', /open\s*\?\s*now\s*:/.test(fn));

console.log('\n──────────────────────────────');
console.log(`RESULTADO: ${pass}/${pass+fail} verde` + (fail? `  (${fail} en rojo)`:' — TODO VERDE'));
process.exit(fail ? 1 : 0);
