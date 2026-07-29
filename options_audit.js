// ════════════════════════════════════════════════════════════════════
//  options_audit.js (s77) — AUDITORIA de la SALIDA. PURO, sin I/O.
//  Enfrenta la PROYECCION de la joya (delta+gamma−theta, projPremiumAt)
//  contra lo que el precio y la PRIMA REALMENTE hicieron despues.
//  Responde: ¿la señal llegó a TP o murió en el SL? ¿la prima proyectada
//  le pegó a la real? ¿cuál fue el R/R REAL en prima? ¿el hold cruzó un
//  earning (donde el IV crush rompe la proyeccion)?
//  El motor de proyeccion es el MISMO que usa el mapa (projPremiumAt) —
//  una sola verdad. Este archivo recibe las barras ya traidas (de Alpaca);
//  no hace fetch (eso va en la ruta /alpaca-audit, aparte).
// ════════════════════════════════════════════════════════════════════
'use strict';
const M = require('./options_metrics.js');

const toMs = t => (t == null ? NaN : (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t)));

// prima real en (o mas cercana a) un instante, desde las barras de la opcion
function premAt(optionBars, tMs) {
  if (!Array.isArray(optionBars) || !optionBars.length || !Number.isFinite(tMs)) return null;
  let best = null, bestD = Infinity;
  for (const b of optionBars) {
    const bt = toMs(b.t), c = Number(b.c);
    if (!Number.isFinite(bt) || !(c > 0)) continue;
    const d = Math.abs(bt - tMs);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// primer indice de barra donde se cumple pred (o -1)
function firstHit(bars, pred) {
  for (let i = 0; i < bars.length; i++) if (pred(bars[i])) return i;
  return -1;
}

// ── auditSignal — la unidad: una señal auditada contra la realidad ──
function auditSignal(input) {
  const { side, spot0, elegido, horizon, targets, underlyingBars, optionBars } = input || {};
  const earningsDates = input && input.earningsDates || [];
  if (!elegido || !(spot0 > 0) || !Array.isArray(underlyingBars) || !underlyingBars.length || !targets || !Array.isArray(targets.tps)) {
    return { ok: false, error: 'input incompleto (elegido/spot0/underlyingBars/targets)' };
  }
  const isCall = (side || elegido.type) === 'call';
  const proj = M.projectExit(elegido, spot0, horizon);
  const thetaDragAbs = proj ? proj.thetaDragAbs : 0;
  const daysHeld = proj ? proj.daysHeld : null;
  const mid = elegido.mid;

  // extremos favorable/adverso de una barra segun el lado
  const favReach = (bar, price) => isCall ? (bar.h >= price) : (bar.l <= price);   // toca el TP
  const advReach = (bar, price) => isCall ? (bar.l <= price) : (bar.h >= price);   // toca el SL

  // evalua un nivel objetivo (TP): ¿lo toco? ¿prima real vs proyectada?
  const evalTarget = (price, label) => {
    const pr = M.projPremiumAt(mid, elegido.delta, elegido.gamma, thetaDragAbs, spot0, price);
    const projPremium = pr ? pr.projPremium : null;
    const idx = firstHit(underlyingBars, b => favReach(b, price));
    const hit = idx >= 0;
    let hitT = null, realPremium = null, realPctGain = null, errAbs = null, errPct = null, barsToHit = null;
    if (hit) {
      hitT = underlyingBars[idx].t; barsToHit = idx;
      realPremium = premAt(optionBars, toMs(hitT));
      if (realPremium != null) {
        realPctGain = mid > 0 ? +(((realPremium - mid) / mid) * 100).toFixed(0) : null;
        errAbs = +(realPremium - projPremium).toFixed(2);
        errPct = projPremium > 0 ? +(((realPremium - projPremium) / projPremium) * 100).toFixed(1) : null;
      }
    }
    return { label, price: +(+price).toFixed(2), projPremium, projPctGain: pr ? pr.pctGain : null,
             hit, barsToHit, hitT, realPremium, realPctGain, errAbs, errPct };
  };

  const tps = targets.tps.map((tp, i) => evalTarget(tp.price, tp.label || ('TP' + (i + 1))));

  // SL: primer toque adverso
  let sl = null;
  if (targets.sl && targets.sl.price != null) {
    const idx = firstHit(underlyingBars, b => advReach(b, targets.sl.price));
    const pr = M.projPremiumAt(mid, elegido.delta, elegido.gamma, thetaDragAbs, spot0, targets.sl.price);
    sl = { label: targets.sl.label || 'SL', price: +(+targets.sl.price).toFixed(2),
           projPremium: pr ? pr.projPremium : null, hit: idx >= 0, barsToHit: idx >= 0 ? idx : null,
           hitT: idx >= 0 ? underlyingBars[idx].t : null };
  }

  // desenlace: ¿TP1 antes que SL?
  const tp1i = tps[0] && tps[0].hit ? tps[0].barsToHit : -1;
  const sli = sl && sl.hit ? sl.barsToHit : -1;
  let outcome;
  if (tp1i === -1 && sli === -1) outcome = 'sin_resolver';           // no toco TP1 ni SL en la ventana
  else if (tp1i >= 0 && (sli === -1 || tp1i < sli)) outcome = 'gano'; // llego a TP1 primero
  else if (sli >= 0 && (tp1i === -1 || sli < tp1i)) outcome = 'stop'; // freno en SL primero
  else outcome = 'ambiguo';                                          // TP1 y SL en la misma barra (sin ticks no se sabe)

  // R/R REAL en prima (recorrido de la prima en la ventana)
  const prems = optionBars ? optionBars.map(b => Number(b.c)).filter(c => c > 0) : [];
  const maxFav = prems.length ? Math.max(...prems) : null;
  const maxAdv = prems.length ? Math.min(...prems) : null;
  const realRR = {
    maxFavPct: (maxFav != null && mid > 0) ? +(((maxFav - mid) / mid) * 100).toFixed(0) : null,
    maxAdvPct: (maxAdv != null && mid > 0) ? +(((maxAdv - mid) / mid) * 100).toFixed(0) : null,
  };

  // earning dentro de la ventana → IV crush → la proyeccion no es confiable ahi
  const startMs = toMs(underlyingBars[0].t), endMs = toMs(underlyingBars[underlyingBars.length - 1].t);
  const eHit = (earningsDates || []).map(toMs).filter(e => Number.isFinite(e) && e >= startMs && e <= endMs);
  const earnings = { enVentana: eHit.length > 0, fechas: eHit,
                     nota: eHit.length ? 'earning en el hold → IV crush; la proyeccion (ignora IV) sobreestima la prima' : null };

  return { ok: true, side: isCall ? 'call' : 'put', outcome, daysHeld, mid, spot0, tps, sl, realRR, earnings };
}

// ── auditBatch — agrega muchas señales auditadas ──
function auditBatch(cards) {
  const ok = (cards || []).filter(c => c && c.ok);
  const resueltas = ok.filter(c => c.outcome === 'gano' || c.outcome === 'stop');
  const ganadas = ok.filter(c => c.outcome === 'gano');
  const tp1Hit = ok.filter(c => c.tps[0] && c.tps[0].hit);
  // error medio de proyeccion por nivel (solo donde hubo prima real)
  const errByLevel = [0, 1, 2].map(i => {
    const errs = ok.map(c => c.tps[i] && c.tps[i].errPct).filter(e => e != null && Number.isFinite(e));
    return errs.length ? +(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1) : null;
  });
  const conEarning = ok.filter(c => c.earnings && c.earnings.enVentana).length;
  return {
    n: ok.length,
    winRate: resueltas.length ? +((ganadas.length / resueltas.length) * 100).toFixed(1) : null,
    tp1HitRate: ok.length ? +((tp1Hit.length / ok.length) * 100).toFixed(1) : null,
    errMedioProyeccionPctPorNivel: errByLevel,   // + = la real supero a la proyectada; − = la proyeccion sobreestimo
    señalesConEarningEnHold: conEarning,
  };
}

module.exports = { auditSignal, auditBatch, premAt, firstHit, toMs };
