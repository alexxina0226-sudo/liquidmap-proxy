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

console.log('\n=== 6. VENTANA MERCADO CERRADO: segundos→ms + tope RTH 16:00 (fix s83) ===');
// Bug s83: (1) lastBar.t está en SEGUNDOS (todo el mapa usa new Date(b.t*1000)) → sin
// *1000 la ventana caía en 1970. (2) la última vela intradía está TRUNCADA al cierre
// (1H ancla 9:30 → último slot 15:30–16:00); sumar el TF entero se iba a after-hours
// (16:20–16:30) donde no hay trades → 'sin flujo' falso. Fix: ×1000 + tope a 16:00 ET.
const winBlock = (fn.match(/const barOpenMs = lastBar\.t\*1000;[\s\S]*?const endISO = new Date\(endMs\)\.toISOString\(\);/) || [''])[0];
ok('usa lastBar.t*1000 (segundos→ms)', /lastBar\.t\s*\*\s*1000/.test(winBlock));
ok('topa la ventana al cierre RTH (Math.min ... 960)', /Math\.min\(/.test(winBlock) && /\b960\b/.test(winBlock));
ok('NO usa lastBar.t crudo sin *1000 (anti-1970)', !/[^*]\blastBar\.t\s*\+/.test(winBlock));
ok('rama abierta usa now (ms) directo', /if\(open\)\{\s*endMs\s*=\s*now/.test(winBlock));

// harness NUMÉRICO sobre el BLOQUE REAL extraído del HTML
const _rthFmt = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'});
const etMin = ms => { const p=_rthFmt.formatToParts(new Date(ms)); let h=+p.find(x=>x.type==='hour').value; if(h===24)h=0; return h*60 + (+p.find(x=>x.type==='minute').value); };
const secAt = iso => Math.floor(Date.parse(iso)/1000);   // ISO UTC → epoch segundos (como el mapa)
let runWin=null;
try { runWin = new Function('lastBar','tfMin','now','open','_rthFmt','CVD_AGG_WINDOW_MIN', winBlock + '\n return { startMs: Date.parse(startISO), endMs };'); }
catch(e){ console.log('  (no compiló el bloque: '+e.message+')'); }
if(runWin && winBlock.length>40){
  // 2026-07-31 es EDT (UTC-4): 15:30 ET = 19:30Z, 16:00 ET = 20:00Z
  const r1h  = runWin({t:secAt('2026-07-31T19:30:00Z')}, 60, Date.now(), false, _rthFmt, 10); // última vela 1H (15:30–16:00)
  ok('1H (vela 15:30): fin de ventana = 16:00 ET (topado, no 16:30)', etMin(r1h.endMs)===960);
  ok('1H: inicio de ventana = 15:50 ET (dentro de RTH)', etMin(r1h.startMs)===950);
  ok('1H: ventana cae en año >= 2020 (no 1970)', new Date(r1h.endMs).getUTCFullYear()>=2020);
  const r5   = runWin({t:secAt('2026-07-31T19:55:00Z')}, 5,  Date.now(), false, _rthFmt, 10); // vela 5m 15:55
  ok('5m (vela 15:55): fin de ventana = 16:00 ET', etMin(r5.endMs)===960);
  const rMid = runWin({t:secAt('2026-07-31T18:30:00Z')}, 60, Date.now(), false, _rthFmt, 10); // vela 14:30 (no es la de cierre)
  ok('1H (vela 14:30, no cierre): fin = 15:30 ET (fin real, no forzado a 16:00)', etMin(rMid.endMs)===930);
  ok('ninguna ventana cerrada termina después de 16:00 ET', etMin(r1h.endMs)<=960 && etMin(r5.endMs)<=960 && etMin(rMid.endMs)<=960);
}

console.log('\n──────────────────────────────');
console.log(`RESULTADO: ${pass}/${pass+fail} verde` + (fail? `  (${fail} en rojo)`:' — TODO VERDE'));
process.exit(fail ? 1 : 0);
