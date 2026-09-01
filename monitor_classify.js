// monitor_classify.js — ADAPTADOR de emisión: result del monitor → clase (scalp/day/swing).
// ---------------------------------------------------------------------------
// Esto es lo que el monitor va a `require` para poblar `horizon` con la clase REAL
// en vez del 'swing' fijo. Traduce los objetos que el monitor YA tiene en la emisión
// (result.struct4H / cvd4H / adx4H / direction, las barras candles4H, y los `layers`
// que buildGovSig ya arma) al contrato de features del clasificador, y clasifica.
//
// DISEÑO que sortea el gap del HTF (el monitor NO evalúa MTF-superior, honesto):
//   El monitor es un emisor 4H — su clase NATURAL es SWING. El clasificador solo
//   REFINA hacia abajo: a SCALP (compresión + RVOL en ascenso = anticipación) o a
//   DAY (expansión + a favor de estructura + volumen). Si el refino no dispara, la
//   señal se queda en SWING (su horizonte nativo). Como la rama swing del clasificador
//   exige htfAligned — que el monitor no tiene — swing SIEMPRE llega por fallback, no
//   por el clasificador. Neto: el clasificador SUBE algunas señales 4H a day/scalp
//   cuando hay evidencia de horizonte corto; el resto quedan swing. Honesto y shippeable.
'use strict';
const { computeSemaforoBolsa, semaphoreLevel, computeRvol, computeRegime } = require('./signal_features.js');
const { classifySignal, DIALS } = require('./signal_class.js');

function agrees(dir, sign){ // dir 'BUY'/'SELL' concuerda con sign (+1 alcista / -1 bajista)
  return (dir === 'BUY' && sign > 0) || (dir === 'SELL' && sign < 0);
}

// buildMonitorFeatures(result, bars, layers, state, opts) → features para classifySignal.
//   result : { direction, struct4H:{type}, cvd4H:{cvd}, adx4H:{bull,bear} }
//   bars   : candles4H  (≥22 para rvolPrev/ascenso)
//   layers : buildGovSig(result).layers  (forma {name,dir,abs})
//   state  : { lastStructSig }  → isNewStruct = struct fresca no repetida
//   opts   : { htfAligned? } — override honesto si algún día el monitor evalúa MTF
function buildMonitorFeatures(result, bars, layers, state, opts){
  const r = result || {}, st = state || {}, o = opts || {};
  const dir = r.direction;
  const type = r.struct4H && r.struct4H.type ? String(r.struct4H.type) : '';
  // Frescura: el monitor YA la computa bien (isNewStruct, antes de pisar lastStructSig).
  // Preferir ese valor explícito; si no viene, derivarlo del lastStructSig previo.
  const isNewStruct = (typeof st.isNewStruct === 'boolean')
    ? st.isNewStruct
    : (type !== '' && type !== st.lastStructSig);
  const cvdSign = r.cvd4H && typeof r.cvd4H.cvd === 'number' ? Math.sign(r.cvd4H.cvd) : 0;
  const adxSign = r.adx4H ? (r.adx4H.bull ? 1 : r.adx4H.bear ? -1 : 0) : 0;
  return {
    semaphore : semaphoreLevel(computeSemaforoBolsa(layers)),
    ...computeRvol(bars),                                  // rvol, rvolPrev
    regime    : computeRegime(bars).regime,
    chochFresh: /CHOCH/i.test(type) && isNewStruct,
    bosFresh  : /BOS/i.test(type)   && isNewStruct,
    cvdAgrees : agrees(dir, cvdSign),
    withTrend : agrees(dir, adxSign),                     // proxy honesto: ADX 4H a favor de la señal
    htfAligned: o.htfAligned === true                     // monitor NO evalúa MTF-superior → false honesto
  };
}

// classifyEmission(result, bars, layers, state, opts) → { clase, horizonBars, razon, raw, features }
//   clase: 'scalp'|'day'|'swing'. El 4H es day-to-swing NATIVO → el DEFAULT es DAY (1-3 días);
//          SWING queda para el upgrade con sello institucional (la rama por criterio). Así el
//          corte por clase discrimina de verdad (day = flujo normal 4H, swing = convicción).
//   horizonBars: swing → null (el monitor usa su LEDGER_HORIZON_BARS env, tuneable); scalp/day
//                → su dial; default (no calificó ninguna clase) → dial de day.
function classifyEmission(result, bars, layers, state, opts){
  const features = buildMonitorFeatures(result, bars, layers, state, opts);
  const cls = classifySignal(features);
  const byCriterio = (cls.clase === 'scalp' || cls.clase === 'day' || cls.clase === 'swing');
  const clase = byCriterio ? cls.clase : 'day';   // 'esperar'/'indefinido' → DAY (nativo 4H)
  const horizonBars = (cls.clase === 'swing') ? null
                    : (cls.horizonBars != null ? cls.horizonBars : DIALS.HORIZON_BARS.day);
  return { clase, horizonBars, razon: cls.razon, raw: cls.clase, features };
}

module.exports = { buildMonitorFeatures, classifyEmission };
