// ledger_core.js — CEREBRO PURO del LEDGER de señales. Palanca madre de la rentabilidad.
// ---------------------------------------------------------------------------
// "Lo que no se mide no se mejora." Registra cada señal emitida y resuelve su
// DESENLACE contra las barras posteriores, y agrega hit-rate + expectativa por setup.
// PURO y testeable (sin red, sin DOM, sin storage). La persistencia (server/localStorage)
// y la captura de emisiones son CABLEADO aparte — este módulo solo razona sobre datos.
//
// Ciclo de vida: ACTIVA → CUMPLIDA (TP) | FALLIDA (SL) | INVALIDADA (estructura/evento)
//                        | EXPIRADA (venció el horizonte) | AMBIGUO (TP y SL en la misma barra)
//
// Mide en R (riesgo): R = |entry - SL|. Un TP a 3×ATR con SL a ~1×ATR ≈ +3R; un SL = −1R.
// Así se puede DEMOSTRAR si la geometría TP/SL (3/4.5/7.5 ATR) da expectativa positiva
// — esto es también la palanca "auditar la salida" de la autocrítica.
'use strict';

function num(x){ return (typeof x==='number' && isFinite(x)) ? x : null; }

// Normaliza una señal emitida a un registro de ledger (status ACTIVA).
// signal: { id?, ts, sym, tf, type:'BUY'|'SELL', score?, grade?, entry, tp1?,tp2?,tp3? | tp:[], sl,
//           horizonBars?, setup?, horizon?(scalp/swing/day), contract?, cvdSource? }
function makeRecord(signal){
  const s = signal || {};
  const tp = Array.isArray(s.tp) ? s.tp.slice(0,3) : [s.tp1, s.tp2, s.tp3];
  return {
    id: s.id != null ? s.id : (s.sym+'|'+s.tf+'|'+s.ts),
    ts: s.ts, sym: s.sym, tf: s.tf, type: s.type,
    score: s.score != null ? s.score : null,
    grade: s.grade != null ? s.grade : null,           // semáforo del Governor (SNIPER/FUERTE/...)
    horizon: s.horizon != null ? s.horizon : null,      // scalp/swing/day (etiqueta derivada)
    setup: s.setup != null ? s.setup : null,            // huella del gatillo (BOS/CHoCH/...)
    contract: s.contract != null ? s.contract : null,   // contrato sugerido (opcional)
    cvdSource: s.cvdSource != null ? s.cvdSource : null, // real/est (trazabilidad)
    entry: num(s.entry), tp: tp.map(num), sl: num(s.sl),
    horizonBars: s.horizonBars != null ? s.horizonBars : null,
    status: 'ACTIVA'
  };
}

// Resuelve el desenlace de un registro contra las barras POSTERIORES al emit.
// bars: [{t,h,l,c}] en orden. opts.invalidatedAtIdx: índice de barra donde una condición
//   externa (CHoCH contrario, ruptura del gatillo, evento) invalida la señal (opcional).
// Devuelve { status, hitTP, exitPrice, rMultiple, barsToResolve, reason }.
function resolveOutcome(rec, bars, opts){
  opts = opts || {};
  bars = Array.isArray(bars) ? bars : [];
  const isBuy = rec.type === 'BUY';
  const entry = num(rec.entry), sl = num(rec.sl);
  if(entry == null || sl == null) return { status:'ACTIVA', hitTP:0, exitPrice:null, rMultiple:null, barsToResolve:null, reason:'sin entry/sl' };
  const R = Math.abs(entry - sl) || null;
  const horizon = (rec.horizonBars != null && rec.horizonBars > 0) ? rec.horizonBars : bars.length;
  const invIdx = (opts.invalidatedAtIdx != null) ? opts.invalidatedAtIdx : (rec.invalidatedAtIdx != null ? rec.invalidatedAtIdx : null);

  // R realizado dado un precio de salida y la dirección
  const rMul = (px) => (R == null || px == null) ? null : (isBuy ? (px - entry) / R : (entry - px) / R);
  const mk = (status, exitPrice, idx, hitTP) => ({
    status, hitTP: hitTP || 0, exitPrice,
    rMultiple: status === 'AMBIGUO' ? null : rMul(exitPrice),
    barsToResolve: idx != null ? idx + 1 : null, reason: 'ok'
  });

  const n = Math.min(bars.length, horizon);
  let hitTP = 0, winIdx = null;
  for(let i = 0; i < n; i++){
    const b = bars[i];
    // invalidación externa (solo mientras NO hayamos ganado aún)
    if(invIdx != null && i >= invIdx && hitTP === 0){
      return mk('INVALIDADA', num(b.c), i, 0);
    }
    const slHit = isBuy ? (num(b.l) != null && b.l <= sl) : (num(b.h) != null && b.h >= sl);
    // TP más alto tocado en ESTA barra
    let tpThis = 0;
    for(let k = rec.tp.length; k >= 1; k--){
      const tp = rec.tp[k-1]; if(tp == null) continue;
      const hit = isBuy ? (num(b.h) != null && b.h >= tp) : (num(b.l) != null && b.l <= tp);
      if(hit){ tpThis = k; break; }
    }
    if(hitTP === 0){
      if(slHit && tpThis >= 1) return mk('AMBIGUO', null, i, tpThis);   // TP y SL en la misma barra, sin ganar antes
      if(slHit)               return mk('FALLIDA', sl, i, 0);
      if(tpThis >= 1){ hitTP = tpThis; winIdx = i; }                     // ganamos TP1+ → seguimos para ver el máximo
    } else {
      if(tpThis > hitTP) hitTP = tpThis;
      if(slHit) return mk('CUMPLIDA', rec.tp[hitTP-1], winIdx, hitTP);   // ya habíamos ganado; el SL posterior no invalida
    }
  }
  if(hitTP >= 1) return mk('CUMPLIDA', rec.tp[hitTP-1], winIdx, hitTP);
  const lastClose = n > 0 ? num(bars[n-1].c) : entry;
  return mk('EXPIRADA', lastClose, null, 0);
}

// Agrega un conjunto de registros RESUELTOS en estadísticas por grupo.
// keyFn: rec => clave de grupo (default 'ALL'). Solo cuenta status != ACTIVA.
// Devuelve { [clave]: {n, wins, losses, invalid, expired, ambiguo, hitRate, avgR, expectancyR, byTP} }.
function aggregate(records, keyFn){
  keyFn = keyFn || (() => 'ALL');
  const out = {};
  for(const r of (records || [])){
    if(!r || r.status === 'ACTIVA') continue;
    const k = keyFn(r);
    const g = out[k] || (out[k] = { n:0, wins:0, losses:0, invalid:0, expired:0, ambiguo:0,
                                    hitRate:null, avgR:null, expectancyR:null, byTP:{1:0,2:0,3:0}, _rs:[] });
    g.n++;
    if(r.status === 'CUMPLIDA'){ g.wins++; if(r.hitTP>=1 && r.hitTP<=3) g.byTP[r.hitTP]++; }
    else if(r.status === 'FALLIDA') g.losses++;
    else if(r.status === 'INVALIDADA') g.invalid++;
    else if(r.status === 'EXPIRADA') g.expired++;
    else if(r.status === 'AMBIGUO') g.ambiguo++;
    if(typeof r.rMultiple === 'number' && isFinite(r.rMultiple)) g._rs.push(r.rMultiple);
  }
  for(const k in out){
    const g = out[k];
    const decided = g.wins + g.losses;                 // hit-rate solo sobre TP vs SL
    g.hitRate = decided > 0 ? g.wins / decided : null;
    g.avgR = g._rs.length ? g._rs.reduce((a,v)=>a+v,0) / g._rs.length : null;
    g.expectancyR = g.avgR;                             // expectativa en R = media del R realizado
    delete g._rs;
  }
  return out;
}

module.exports = { makeRecord, resolveOutcome, aggregate };
