// bench_semaforo_bolsa.js — banco del semáforo de evidencia bolsa (código real del HTML)
'use strict';
const fs = require('fs');
const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');
const a = html.indexOf('function computeSemaforoBolsa');
const b = html.indexOf('// ── CONFLUENCE METER PREMIUM');
if (a < 0 || b < 0 || b <= a) { console.log('✗ no pude extraer computeSemaforoBolsa'); process.exit(1); }
const computeSemaforoBolsa = new Function(html.slice(a, b) + '; return computeSemaforoBolsa;')();

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ FALLA: ' + n); } };
// constructor de capas: L(dir) normal, A() ausente, N() neutral
const L = d => ({ name: 'x', val: 1, dir: d, abs: false });
const A = () => ({ name: 'x', val: 0, dir: 0, abs: true });
const N = () => L(0);

console.log('BENCH SEMÁFORO BOLSA — 8 capas, reglas en orden (código real del HTML)');
// 1) 5✓·1✗·2◦ → ALTA ▲ (regla 4)
let r = computeSemaforoBolsa([L(1),L(1),L(1),L(1),L(1),L(-1),N(),N()]);
check('5✓·1✗·2◦ → ALTA ▲', r.label==='ALTA' && r.arrow==='▲' && r.cls==='sem-g' && r.counter==='5✓·1✗·2◦·0∅');
// 2) 4✓·0✗ unánime pero corto → MEDIA (la pregunta abierta de Gonzalo, mismo umbral que crypto)
r = computeSemaforoBolsa([L(-1),L(-1),L(-1),L(-1),N(),N(),N(),N()]);
check('4✓·0✗ unánime → MEDIA ▼ (umbral provisional)', r.label==='MEDIA' && r.arrow==='▼' && r.cls==='sem-y');
// 3) empate 3 vs 3 → BAJA · capas en pelea ◆ (regla 3)
r = computeSemaforoBolsa([L(1),L(1),L(1),L(-1),L(-1),L(-1),N(),N()]);
check('3 vs 3 empate → BAJA · en pelea ◆', r.label==='BAJA · capas en pelea' && r.arrow==='◆' && r.cls==='sem-r');
// 4) minoría contra mayoría 2✓·3✗... espera: 3 bajistas vs 2 alcistas → dominante ▼ conf=3 against=2 → MEDIA
r = computeSemaforoBolsa([L(-1),L(-1),L(-1),L(1),L(1),N(),N(),N()]);
check('3✓·2✗ → MEDIA ▼ (dirección con disenso)', r.label==='MEDIA' && r.arrow==='▼');
// 5) nadie con dirección → MEDIA · sin sesgo (regla 2)
r = computeSemaforoBolsa([N(),N(),N(),N(),N(),N(),N(),N()]);
check('todo plano → MEDIA · sin sesgo', r.label==='MEDIA · sin sesgo' && r.cls==='sem-y');
// 6) 3 ausentes → BAJA · ciego, gana a todo (regla 1 primera)
r = computeSemaforoBolsa([A(),A(),A(),L(1),L(1),L(1),L(1),L(1)]);
check('3∅ → BAJA · ciego aunque haya 5✓', r.label==='BAJA · ciego' && r.cls==='sem-r' && r.abs===3);
// 7) 5✓ con 2∅ → MEDIA (regla 4 exige máx 1∅)
r = computeSemaforoBolsa([A(),A(),L(1),L(1),L(1),L(1),L(1),N()]);
check('5✓ pero 2∅ → MEDIA (verde exige máx 1∅)', r.label==='MEDIA');
// 8) 5✓·1✗·1◦·1∅ → ALTA (borde exacto de la regla 4)
r = computeSemaforoBolsa([A(),L(1),L(1),L(1),L(1),L(1),L(-1),N()]);
check('5✓·1✗·1◦·1∅ → ALTA (borde exacto)', r.label==='ALTA' && r.counter==='5✓·1✗·1◦·1∅');
// 9) el ∅ NO cuenta como neutral en el contador
r = computeSemaforoBolsa([A(),N(),L(1),L(1),L(-1),N(),N(),N()]);
check('∅ y ◦ separados en el contador', r.abs===1 && r.neut===4 && r.counter==='2✓·1✗·4◦·1∅');
console.log(`\nRESULTADO: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
