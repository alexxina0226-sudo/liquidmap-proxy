// bench_cvd_score_map.js — Banco ESTRUCTURAL del cableado 3b (FASE 3, s81).
// Verifica que el CVD real por agresor pueda alimentar el SCORE, gated por flag,
// con override de globales y fallback honesto. La lógica pura ya la prueba
// bench_cvd_score.js (28/28); esto asegura que el HTML la cablea igual.
'use strict';
const fs = require('fs');
const H = fs.readFileSync(__dirname + '/LiquidityMap_BOLSA_v5.html', 'utf8');
const fn = (H.match(/function applyCvdSource\(\)\{[\s\S]*?\n\}/) || [''])[0];

let pass=0, fail=0;
function ok(n,c){ if(c){pass++;console.log('  ✓ '+n);}else{fail++;console.log('  ✗ '+n);} }

console.log('\n=== 1. FLAG (arranca OFF = comportamiento actual) ===');
ok('CVD_TO_SCORE definido y en false', /const CVD_TO_SCORE = false;/.test(H));
ok('applyCvdSource existe', fn.length>0);
ok('primera guarda = si el flag está OFF, return (no toca nada)', /if\(!CVD_TO_SCORE\) return;/.test(fn));

console.log('\n=== 2. MISMA TABLA DE DECISIÓN que el resolutor puro (cvd_score.js) ===');
ok('descarta cache de otro símbolo (a.sym!==sym)', /a\.sym!==sym/.test(fn));
ok('exige cvdReal===true', /a\.cvdReal!==true/.test(fn));
ok('descarta parcial', /a\.partial===true/.test(fn));
ok('exige mínimo de trades', /a\.nTrades\|\|0\)\s*<\s*CVD_SCORE_MIN_TRADES/.test(fn));
ok('descarta cache viejo (edad > max)', /Date\.now\(\)-a\.ts\)\s*>\s*CVD_SCORE_MAX_AGE_MS/.test(fn));

console.log('\n=== 3. OVERRIDE de globales (score + panel coherentes) ===');
ok('pisa cvd', /\bcvd\s*=\s*a\.cvd/.test(fn));
ok('pisa buyV', /\bbuyV\s*=\s*a\.buyV/.test(fn));
ok('pisa sellV', /\bsellV\s*=\s*a\.sellV/.test(fn));
ok('marca cvdReal=true (badge del panel flipea a 📡)', /cvdReal\s*=\s*true/.test(fn));

console.log('\n=== 4. SE LLAMA AL TOPE DEL SCORE ===');
const csn = (H.match(/function computeNeuralScore\(p\)\{[\s\S]*?const conf = \[\];/) || [''])[0];
ok('applyCvdSource() al inicio de computeNeuralScore', /applyCvdSource\(\);/.test(csn));
ok('después del guard !p||!vp (no antes)', csn.indexOf('if(!p || !vp)') < csn.indexOf('applyCvdSource()'));

console.log('\n=== 5. EL CACHE lo llena updateAggressorCVD ===');
ok('_cvdAgg tiene campo data', /_cvdAgg = \{ key:null, ts:0, err:false, data:null \}/.test(H));
ok('cachea sym+cvd+buyV+sellV+cvdReal+partial+nTrades+ts', /_cvdAgg\.data = \{ sym:symArg, cvd:\(j\.cvd\|\|0\), buyV:.*cvdReal:.*partial:.*nTrades:.*ts:Date\.now\(\)/.test(H));
ok('limpia el cache en error (data=null)', /_cvdAgg\.data=null/.test(H));

console.log('\n=== 6. SEGURIDAD: con el flag OFF, el score NO cambia ===');
// la única forma de que applyCvdSource toque globales es pasar la guarda del flag;
// con CVD_TO_SCORE=false esa guarda retorna antes de tocar nada.
ok('el override vive DESPUÉS de la guarda del flag', fn.indexOf('if(!CVD_TO_SCORE) return;') < fn.indexOf('cvd = a.cvd'));
// las capas del score siguen leyendo cvd/buyV/sellV (los globales que applyCvdSource pisa cuando corresponde)
ok('CAPA 3 sigue leyendo cvd', /else if\(cvd > 0\) \{ score \+= 1\.5;/.test(H));
ok('CAPA 5 sigue leyendo buyV/sellV', /const tot = buyV \+ sellV;/.test(H));

console.log('\n──────────────────────────────');
console.log(`RESULTADO: ${pass}/${pass+fail} verde` + (fail? `  (${fail} en rojo)`:' — TODO VERDE'));
process.exit(fail ? 1 : 0);
