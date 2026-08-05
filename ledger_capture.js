// ledger_capture.js — CAPTURA de señales emitidas → registro en el store (etapa 2c).
// ---------------------------------------------------------------------------
// Puente fino y FAIL-OPEN entre el emisor (monitor_bolsa_v1) y el ledger: arma el
// registro desde el contexto de emisión y lo persiste con upsert IDEMPOTENTE.
// NUNCA tira (envuelve todo en try/catch) → la captura jamás puede romper el
// envío de una señal. Si el ledger falla, la señal salió igual y se loguea el skip.
'use strict';
const { makeRecord } = require('./ledger_core.js');

// captureSignal(store, ctx, opts) → registro guardado | null
// ctx: { ts, sym, tf, direction, score, grade, setup, horizon,
//        entry, tp1, tp2, tp3, sl, horizonBars, cvdSource }
// opts: { horizonBars?(default si el ctx no lo trae), onError?(err) }
function captureSignal(store, ctx, opts){
  opts = opts || {};
  try {
    if(!store || !ctx) return null;
    if(ctx.entry == null || ctx.sl == null) return null;   // sin riesgo medible (R) → no se registra
    const rec = makeRecord({
      ts: ctx.ts, sym: ctx.sym, tf: ctx.tf, type: ctx.direction,
      score: ctx.score, grade: ctx.grade, setup: ctx.setup, horizon: ctx.horizon,
      entry: ctx.entry, tp1: ctx.tp1, tp2: ctx.tp2, tp3: ctx.tp3, sl: ctx.sl,
      horizonBars: ctx.horizonBars != null ? ctx.horizonBars
                 : (opts.horizonBars != null ? opts.horizonBars : null),
      cvdSource: ctx.cvdSource != null ? ctx.cvdSource : null
    });
    return store.upsert(rec);            // idempotente por id (sym|tf|ts) → no duplica
  } catch(e){
    if(typeof opts.onError === 'function') opts.onError(e);
    return null;                          // fail-open: la señal ya salió, el ledger no la estorba
  }
}

module.exports = { captureSignal };
