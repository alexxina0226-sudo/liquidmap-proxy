// bench_arc_v2.js — banco sintético del port fiel (checks por PROPIEDAD del mecanismo)
'use strict';
const { createArcVwapSupertrend } = require('./arc_boswaves_v2.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FALLA: ' + name); }
}

const H = 3600000;
const T0 = Date.UTC(2026, 0, 5); // lunes 00:00 UTC
function candle(i, o, h, l, c, v = 100) { return { time: T0 + i * H, open: o, high: h, low: l, close: c, volume: v }; }

// Escenario realista para un arco acelerado (tipo SAR):
//  0–119   plano (semilla ATR + init)
//  120–179 subida suave (+0.4/vela)
//  180–299 meseta — el arco acelera, alcanza al precio y FUERZA el flip bajista
//  después bajada (-0.5/vela) y meseta — el arco vuelve a alcanzar → flip alcista
const candles = [];
let px = 100;
for (let i = 0; i < 120; i++) candles.push(candle(i, px, px + 0.5, px - 0.5, px + (i % 2 ? 0.1 : -0.1)));
for (let i = 120; i < 180; i++) { px += 0.4; candles.push(candle(i, px - 0.4, px + 0.5, px - 0.6, px)); }
for (let i = 180; i < 300; i++) { const w = (i % 2 ? 0.3 : -0.3); candles.push(candle(i, px, px + 0.5 + w, px - 0.5 + w, px + w)); }
for (let i = 300; i < 360; i++) { px -= 0.5; candles.push(candle(i, px + 0.5, px + 0.6, px - 0.6, px)); }
for (let i = 360; i < 480; i++) { const w = (i % 2 ? 0.3 : -0.3); candles.push(candle(i, px, px + 0.5 + w, px - 0.5 + w, px + w)); }

const arc = createArcVwapSupertrend({});
const outs = candles.map(c => arc.update(c));

console.log('BENCH arc_boswaves_v2 — port fiel BOSWaves (propiedades del mecanismo)');

// 1) sin arco hasta bar>100 (fiel al original)
check('no existe arco hasta bar>100 (init fiel)', outs[100].ready === false && outs[101].ready === true);

// 2) init alcista y lejos (≈startMult × atrSlow)
const init = outs[101];
check('init alcista con distancia startMult', init.trend === true && init.arc < candles[101].low - init.atrSlow * 1.5);

// 3) en la meseta el arco acelera y ACHICA el gap (persecución parabólica)
const bearFlipIdx = outs.findIndex(o => o.rawFlipped && o.trend === false);
check('existe flip bajista (el arco alcanza al precio)', bearFlipIdx > 180);
const gapStart = candles[185].close - outs[185].arc;
const gapLate  = candles[bearFlipIdx - 2].close - outs[bearFlipIdx - 2].arc;
check('el gap se achica antes del flip (aceleración real)', gapLate < gapStart && gapStart > 0);

// 4) velocidad acumulada creciente mientras no hay flip
check('velocidad acumulada creciente', outs[bearFlipIdx - 2].velocity > outs[130].velocity && outs[130].velocity > 0);

// 5) mecánica del flip: en la vela del flip, el cierre quedó DEBAJO del arco previo
check('flip bajista disparado por close < arco previo', candles[bearFlipIdx].close < outs[bearFlipIdx - 1].arc);

// 6) reset: arco arriba del high, velocidad reiniciada
const fb = outs[bearFlipIdx];
check('reset bajista lejos del precio y velocidad reiniciada', fb.arc > candles[bearFlipIdx].high && fb.velocity <= fb.effectiveAccel + 1e-9);

// 7) nivel de flip = high de la vela del flip bajista
check('flip level bajista en el high de la vela', Math.abs(fb.flipPrice - candles[bearFlipIdx].high) < 1e-9);

// 8) más tarde, flip alcista con close > arco previo
const bullFlipIdx = outs.findIndex((o, i) => i > bearFlipIdx && o.rawFlipped && o.trend === true);
check('flip alcista posterior por close > arco previo',
  bullFlipIdx > bearFlipIdx && candles[bullFlipIdx].close > outs[bullFlipIdx - 1].arc);

// 9) filtro VWAP coherente en ambos flips (confirmado XOR filtrado, según VWAP de sesión)
const fu = outs[bullFlipIdx];
const bearExp = candles[bearFlipIdx].close <= fb.vwapSession;
const bullExp = candles[bullFlipIdx].close >= fu.vwapSession;
check('filtro VWAP clasifica bien los dos flips',
  fb.flipConfirmed === bearExp && (fb.flipConfirmed !== fb.flipFiltered) &&
  fu.flipConfirmed === bullExp && (fu.flipConfirmed !== fu.flipFiltered));

// 10) cadencia: el arco solo se mueve cada `smooth` velas (rango sin flip)
let cadenceOk = true;
for (let i = 130; i < 142; i++) {
  const moved = Math.abs(outs[i].arc - outs[i - 1].arc) > 1e-12;
  if (moved !== (i % 3 === 0)) { cadenceOk = false; break; }
}
check('cadencia de avance cada `smooth` velas (bar_index % 3)', cadenceOk);

console.log(`\nRESULTADO: ${pass}/${pass + fail} checks · flip bajista en vela ${bearFlipIdx}, alcista en ${bullFlipIdx}`);
process.exit(fail ? 1 : 0);
