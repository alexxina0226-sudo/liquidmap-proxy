// ════════════════════════════════════════════════════════════════════
//  bench_audit.js (s77) — banco de la AUDITORIA de la salida.
//   A) auditSignal CALL: detecta TP1/TP2, error proyeccion↔real, R/R real,
//      bandera de earning en la ventana.
//   B) auditSignal PUT: direccion invertida (favorable = el precio baja).
//   C) auditSignal STOP: el SL se toca antes que el TP1 → outcome 'stop'.
//   D) projPremiumAt (server) == projPremAt (mapa, extraida del HTML) — paridad.
//   E) auditBatch: agrega winRate / tp1HitRate / error medio / earnings.
//  Datos SINTETICOS (fixtures) — prueba la matematica del scoring sin Alpaca.
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const A = require('./options_audit.js');
const M = require('./options_metrics.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

const greeksC = { type: 'call', mid: 5, delta: 0.4, gamma: 0.03, theta: 0.3, breakevenMov: 12.5 };
// CALL: sube, toca TP1(108) en idx2, TP2(112) en idx4, nunca TP3(118) ni SL(96)
const callInput = {
  side: 'call', spot0: 100, elegido: greeksC, horizon: 'swing',
  targets: { tps: [{ price: 108, label: 'TP1' }, { price: 112, label: 'TP2' }, { price: 118, label: 'TP3' }], sl: { price: 96, label: 'SL' } },
  underlyingBars: [
    { t: '2026-07-28', h: 103, l: 99, c: 102 },
    { t: '2026-07-29', h: 106, l: 101, c: 105 },
    { t: '2026-07-30', h: 109, l: 104, c: 108 },
    { t: '2026-07-31', h: 110, l: 107, c: 109 },
    { t: '2026-08-03', h: 113, l: 108, c: 112 },
    { t: '2026-08-04', h: 114, l: 110, c: 113 },
  ],
  optionBars: [
    { t: '2026-07-28', c: 5.5 }, { t: '2026-07-29', c: 6.8 }, { t: '2026-07-30', c: 8.0 },
    { t: '2026-07-31', c: 8.6 }, { t: '2026-08-03', c: 10.5 }, { t: '2026-08-04', c: 11.0 },
  ],
  earningsDates: ['2026-07-30'],
};

console.log('── A) auditSignal CALL ──');
const cc = A.auditSignal(callInput);
ok('A1 ok', cc.ok === true, JSON.stringify(cc.error));
ok('A2 outcome = gano (TP1 antes que SL)', cc.outcome === 'gano', cc.outcome);
ok('A3 TP1 tocado en la barra 2', cc.tps[0].hit && cc.tps[0].barsToHit === 2, JSON.stringify(cc.tps[0]));
ok('A4 TP1 prima proyectada = 8.26', cc.tps[0].projPremium === 8.26, cc.tps[0].projPremium);
ok('A5 TP1 prima real = 8.0 (de las barras de la opcion)', cc.tps[0].realPremium === 8.0, cc.tps[0].realPremium);
ok('A6 TP1 error real−proyectada = -0.26', cc.tps[0].errAbs === -0.26, cc.tps[0].errAbs);
ok('A7 TP2 tocado en la barra 4', cc.tps[1].hit && cc.tps[1].barsToHit === 4, JSON.stringify(cc.tps[1]));
ok('A8 TP3 NO tocado', cc.tps[2].hit === false, JSON.stringify(cc.tps[2]));
ok('A9 SL NO tocado', cc.sl.hit === false, JSON.stringify(cc.sl));
ok('A10 R/R real: maxFav +120% / maxAdv +10%', cc.realRR.maxFavPct === 120 && cc.realRR.maxAdvPct === 10, JSON.stringify(cc.realRR));
ok('A11 earning EN la ventana → flag + nota', cc.earnings.enVentana === true && !!cc.earnings.nota, JSON.stringify(cc.earnings));

console.log('\n── B) auditSignal PUT (favorable = baja) ──');
const putInput = {
  side: 'put', spot0: 100, elegido: { type: 'put', mid: 5, delta: -0.4, gamma: 0.03, theta: 0.3, breakevenMov: 12.5 }, horizon: 'swing',
  targets: { tps: [{ price: 92, label: 'TP1' }, { price: 88, label: 'TP2' }, { price: 82, label: 'TP3' }], sl: { price: 104, label: 'SL' } },
  underlyingBars: [
    { t: '2026-07-28', h: 101, l: 98, c: 99 }, { t: '2026-07-29', h: 100, l: 95, c: 96 },
    { t: '2026-07-30', h: 97, l: 91, c: 92 }, { t: '2026-07-31', h: 95, l: 89, c: 90 },
    { t: '2026-08-03', h: 92, l: 87, c: 88 }, { t: '2026-08-04', h: 90, l: 86, c: 87 },
  ],
  optionBars: [{ t: '2026-07-28', c: 5.5 }, { t: '2026-07-29', c: 6.8 }, { t: '2026-07-30', c: 8.0 }, { t: '2026-07-31', c: 8.6 }, { t: '2026-08-03', c: 10.5 }, { t: '2026-08-04', c: 11.0 }],
};
const pc = A.auditSignal(putInput);
ok('B1 PUT outcome = gano', pc.outcome === 'gano', pc.outcome);
ok('B2 PUT TP1(92) tocado por el MIN (l<=92) en barra 2', pc.tps[0].hit && pc.tps[0].barsToHit === 2, JSON.stringify(pc.tps[0]));
ok('B3 PUT proyeccion simetrica a la call (8.26 a 8 puntos)', pc.tps[0].projPremium === 8.26, pc.tps[0].projPremium);
ok('B4 PUT SL(104) NO tocado', pc.sl.hit === false, JSON.stringify(pc.sl));

console.log('\n── C) auditSignal STOP (SL antes que TP1) ──');
const stopInput = {
  side: 'call', spot0: 100, elegido: greeksC, horizon: 'swing',
  targets: { tps: [{ price: 108, label: 'TP1' }], sl: { price: 96, label: 'SL' } },
  underlyingBars: [
    { t: '2026-07-28', h: 102, l: 99, c: 100 },
    { t: '2026-07-29', h: 101, l: 95, c: 96 },   // SL (l=95<=96) en barra 1
    { t: '2026-07-30', h: 109, l: 97, c: 108 },  // TP1 recien en barra 2
  ],
  optionBars: [{ t: '2026-07-28', c: 5.0 }, { t: '2026-07-29', c: 3.1 }, { t: '2026-07-30', c: 8.2 }],
};
const sc = A.auditSignal(stopInput);
ok('C1 outcome = stop', sc.outcome === 'stop', sc.outcome);
ok('C2 SL tocado en barra 1', sc.sl.hit && sc.sl.barsToHit === 1, JSON.stringify(sc.sl));
ok('C3 TP1 igual se tocó despues (barra 2) pero NO cuenta como gano', sc.tps[0].hit && sc.tps[0].barsToHit === 2 && sc.outcome === 'stop', sc.outcome);

console.log('\n── D) paridad projPremiumAt (server) == projPremAt (mapa) ──');
const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');
const src = html.match(/function projPremAt\(mid, delta, gamma, thetaDragAbs, spot, target\)\{[\s\S]*?\n\}/)[0];
const projPremAtMapa = new Function('return (' + src.replace('function projPremAt', 'function') + ')')();
let parId = true, det = '';
[[5, 0.4, 0.03, 0.9, 100, 108], [5, -0.4, 0.03, 0.9, 100, 92], [2, 0.5, 0.05, 0, 100, 130], [9, 0.3, undefined, 1.5, 300, 330]].forEach(a => {
  const s = M.projPremiumAt(...a), m = projPremAtMapa(...a);
  if (JSON.stringify(s) !== JSON.stringify(m)) { parId = false; det += ` ${JSON.stringify(a)}: srv ${JSON.stringify(s)} vs mapa ${JSON.stringify(m)}`; }
});
ok('D1 server y mapa dan IDENTICO (call, put, clamp, sin gamma)', parId, det);

console.log('\n── E) auditBatch ──');
const batch = A.auditBatch([cc, pc, sc]);
ok('E1 n = 3', batch.n === 3, batch.n);
ok('E2 winRate = 66.7 (2 gano / 3 resueltas)', batch.winRate === 66.7, batch.winRate);
ok('E3 tp1HitRate = 100 (las 3 tocaron TP1 en algun momento)', batch.tp1HitRate === 100, batch.tp1HitRate);
ok('E4 señales con earning en el hold = 1', batch.señalesConEarningEnHold === 1, batch.señalesConEarningEnHold);
ok('E5 error medio de proyeccion por nivel es un array de 3', Array.isArray(batch.errMedioProyeccionPctPorNivel) && batch.errMedioProyeccionPctPorNivel.length === 3, JSON.stringify(batch.errMedioProyeccionPctPorNivel));

console.log(`\n${fail === 0 ? '✅' : '❌'} bench_audit: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
