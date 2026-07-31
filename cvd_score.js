// cvd_score.js — ¿Qué CVD usa el SCORE? (real por agresor vs estimado). FASE 3, etapa 3b.
// ---------------------------------------------------------------------------
// PURO y testeable. El score de bolsa (capas 3 CVD y 5 Presión) lee cvd/buyV/sellV.
// Hoy son ESTIMADOS (dirección de vela + close-location-value). Este resolutor decide
// si el score debe usar el CVD REAL por agresor (Lee-Ready, de /alpaca-cvd) EN SU LUGAR.
//
// REGLA (honesta y conservadora): usar el real SÓLO si viene LIMPIO:
//   - agg existe y es del símbolo actual
//   - agg.cvdReal === true            (clasificó sobre trades reales)
//   - agg.partial !== true            (no se truncó por el tope de datos)
//   - agg.nTrades >= minTrades        (muestra suficiente, no 3 trades sueltos)
//   - cache fresco (edad <= maxAgeMs)
// Si CUALQUIERA falla → se usa el ESTIMADO (comportamiento actual, sin sorpresas).
//
// NOTA DE HORIZONTE (declararla, no esconderla): el real viene de una ventana RECIENTE
// acotada (por el tope de datos en híper-líquidos), mientras el estimado cubre ~30 velas.
// Al usar el real, la capa CVD del score pasa a significar "flujo real reciente" en vez de
// "proxy por dirección de vela de 30 velas". Es un cambio deliberado y OBSERVABLE (badge 📡).
'use strict';

const DEFAULTS = { minTrades: 20, maxAgeMs: 300000 }; // ≥20 trades, cache < 5 min

// est: {cvd,buyV,sellV}         (lo que ya calculó el mapa, estimado)
// agg: {sym,cvd,buyV,sellV,cvdReal,partial,nTrades,ts} | null   (cache de /alpaca-cvd)
// curSym: símbolo actual (para descartar cache de otro símbolo). opcional.
// opts: {minTrades,maxAgeMs,now}
// Devuelve {cvd,buyV,sellV,cvdReal,source:'real'|'est',reason}
function resolveScoreCVD(est, agg, curSym, opts){
  opts = Object.assign({}, DEFAULTS, opts || {});
  const now = (opts.now != null) ? opts.now : Date.now();
  const estOut = {
    cvd: (est && est.cvd) || 0, buyV: (est && est.buyV) || 0, sellV: (est && est.sellV) || 0,
    cvdReal: false, source: 'est'
  };
  if(!agg) return Object.assign(estOut, { reason: 'sin dato real' });
  if(curSym != null && agg.sym != null && agg.sym !== curSym) return Object.assign(estOut, { reason: 'cache de otro símbolo' });
  if(agg.cvdReal !== true) return Object.assign(estOut, { reason: 'agg no real' });
  if(agg.partial === true) return Object.assign(estOut, { reason: 'agg parcial (tope de datos)' });
  if((agg.nTrades || 0) < opts.minTrades) return Object.assign(estOut, { reason: 'pocos trades (' + (agg.nTrades || 0) + '<' + opts.minTrades + ')' });
  if(agg.ts != null && (now - agg.ts) > opts.maxAgeMs) return Object.assign(estOut, { reason: 'cache viejo' });
  return { cvd: agg.cvd, buyV: agg.buyV, sellV: agg.sellV, cvdReal: true, source: 'real', reason: 'ok' };
}

module.exports = { resolveScoreCVD, DEFAULTS };
