// bench_preaviso.js — banco del PASO C.2 sobre el CÓDIGO REAL extraído del HTML
'use strict';
const fs = require('fs');
const html = fs.readFileSync('./LiquidityMap_CRYPTO_v6_2.html', 'utf8');
const a = html.indexOf('function detectSwings');
const b = html.indexOf('function buildZones');
if (a < 0 || b < 0 || b <= a) { console.log('✗ no pude extraer el bloque'); process.exit(1); }
const fmt = (v, d) => { if (v == null) return '—'; const dd = v < 1 ? 4 : v < 100 ? 2 : v < 10000 ? 2 : 0; return '$' + v.toFixed(d !== undefined ? d : dd); };
const _mod = new Function('fmt', html.slice(a, b) +
  '; return { detectSwings, cryptoLiquidityPools, detectLiquiditySweepCrypto, detectSweepProximityCrypto };')(fmt);
const { detectSwings, cryptoLiquidityPools, detectLiquiditySweepCrypto, detectSweepProximityCrypto } = _mod;

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ FALLA: ' + n); } };
// swings sintéticos directos (formato {price,kind})
const SW = (hs, ls) => [...hs.map(p => ({ price: p, kind: 'high' })), ...ls.map(p => ({ price: p, kind: 'low' }))];
const ATR = 100;

console.log('BENCH PASO C.2 — pre-aviso de proximidad (código real del HTML)');
// 1) pool real de máximos (2 equal) a 0.3×ATR → pre-aviso res
let r = detectSweepProximityCrypto(SW([64030, 64032], [63000, 62500]), 64000, ATR);
check('pool real de máximos cerca → pre-aviso ▲', r && r.side === 'res' && r.count === 2 && r.label.includes('máximos'));
// 2) swing SUELTO de máximos cerca (count 1) → NO (gate A1 de pool real)
r = detectSweepProximityCrypto(SW([64030], [63000, 62500]), 64000, ATR);
check('swing suelto cerca → silencio (gate pool real)', r === null || r.side === 'sup' && false || r === null);
// 3) pool real pero LEJOS (2×ATR) → NO
r = detectSweepProximityCrypto(SW([64200, 64202], [63000, 62980]), 64000, ATR);
check('pool a 2×ATR → silencio', r === null);
// 4) pool real de mínimos a 0.4×ATR → pre-aviso sup
r = detectSweepProximityCrypto(SW([65000, 66000], [63960, 63962]), 64000, ATR);
check('pool real de mínimos cerca → pre-aviso ▼', r && r.side === 'sup' && r.label.includes('mínimos'));
// 5) ambos pools cerca → gana el MÁS cercano (mínimos a 0.2 vs máximos a 0.4)
r = detectSweepProximityCrypto(SW([64040, 64042], [63980, 63982]), 64000, ATR);
check('ambos cerca → elige el más cercano', r && r.side === 'sup');
// 6) borde exacto del umbral (0.5×ATR) → SÍ avisa (<=)
r = detectSweepProximityCrypto(SW([64050, 64050], [62000, 61900]), 64000, ATR);
check('borde exacto 0.5×ATR → avisa', r && r.side === 'res');
// 7) sin ATR → fallback 0.4% del precio sigue funcionando
r = detectSweepProximityCrypto(SW([64200, 64202], [62000, 61900]), 64000, null);
check('sin ATR → fallback 0.4% (pool a 0.31% avisa)', r && r.side === 'res');
// 8) el label lleva precio formateado y conteo del pool
r = detectSweepProximityCrypto(SW([64030, 64032], [62000, 61900]), 64000, ATR);
check('label con fmt() y conteo', r && r.label.includes('$') && r.label.includes('(2×)'));
// 9) el detector de barrido consumado sigue intacto (regresión A1)
const sweep = detectLiquiditySweepCrypto({ h: 64070, l: 63700, c: 63850 }, SW([64030, 64032], [62000]), 63850, ATR);
check('regresión: sweep+reclaim del PASO C sigue detectando', sweep && sweep.type === 'SWEEP_BEAR');

console.log(`\nRESULTADO: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
