// ledger_resolver.js — RESOLVEDOR de desenlaces del LEDGER (etapa 2b).
// ---------------------------------------------------------------------------
// Recorre las señales ACTIVA, trae las barras POSTERIORES al emit (vía un
// fetcher inyectable = getUnderlyingBars de options_live, o un mock en tests),
// resuelve con resolveOutcome (cerebro puro etapa 1) y SELLA el registro si
// dejó de estar ACTIVA. PURO respecto de la red: el fetch se inyecta.
//
// Guarda clave: NO se fuerza EXPIRADA a una señal joven. resolveOutcome con
// pocas barras devuelve EXPIRADA (se le acabaron las barras), pero eso NO es lo
// mismo que "venció el horizonte". Solo sellamos EXPIRADA cuando el horizonte
// se alcanzó de verdad (por nº de barras o por reloj). Si no, queda ACTIVA.
'use strict';
const { resolveOutcome } = require('./ledger_core.js');

// tf del mapa → timeframe de Alpaca (/v2/stocks/bars). Overridable vía opts.tfToAlpaca.
const TF_ALPACA = {
  '1':'1Min','1m':'1Min','5':'5Min','5m':'5Min','15':'15Min','15m':'15Min',
  '30':'30Min','30m':'30Min','60':'1Hour','1H':'1Hour','1h':'1Hour',
  '4H':'4Hour','4h':'4Hour','1D':'1Day','1d':'1Day','D':'1Day'
};
const TF_MS = {
  '1Min':60000,'5Min':300000,'15Min':900000,'30Min':1800000,
  '1Hour':3600000,'4Hour':14400000,'1Day':86400000
};
function tfToAlpacaDefault(tf){ return TF_ALPACA[String(tf)] || '1Hour'; }
function barMsDefault(atf){ return TF_MS[atf] || 3600000; }
function toISO(ms){ return new Date(ms).toISOString(); }

// computeExcursion(rec, bars) → { mfeR, maeR } — máxima excursión FAVORABLE / ADVERSA en R.
// R = |entry - sl|. BUY: fav = high-entry, adv = low-entry. SELL: fav = entry-low, adv = entry-high.
// mfeR ≥ 0 (lo más lejos que fue a favor), maeR ≤ 0 (lo más lejos en contra). Ambos clampeados.
// Mide "cuánto se movió a favor ANTES de resolverse" — clave para juzgar opciones/scalp, no solo TP/SL binario.
// null si falta entry/sl, R=0, o no hay barras. Nunca tira (fail-open).
function computeExcursion(rec, bars){
  if(!rec || rec.entry == null || rec.sl == null) return { mfeR: null, maeR: null };
  const R = Math.abs(rec.entry - rec.sl);
  if(!(R > 0) || !Array.isArray(bars) || !bars.length) return { mfeR: null, maeR: null };
  const isBuy = /BUY|LONG|COMPRA/i.test(String(rec.type || 'BUY'));
  let mfe = 0, mae = 0;
  for(const b of bars){
    if(!b) continue;
    const hi = Number(b.h), lo = Number(b.l);
    if(!isFinite(hi) || !isFinite(lo)) continue;
    const fav = isBuy ? (hi - rec.entry) : (rec.entry - lo);   // mejor a favor
    const adv = isBuy ? (lo - rec.entry) : (rec.entry - hi);   // peor en contra (≤0)
    if(fav > mfe) mfe = fav;
    if(adv < mae) mae = adv;
  }
  return { mfeR: +(mfe / R).toFixed(3), maeR: +(mae / R).toFixed(3) };
}

// resolvePending(store, fetchBars, opts)
//   fetchBars(sym, startISO, endISO, alpacaTf) -> Promise<[{t,o,h,l,c,v}]>  (inyectable)
//   opts: { now?, tfToAlpaca?, barMs?, maxHorizonBars?, onError?(rec,err) }
//   -> { resolved, active, errors, details:[{id,status}] }
async function resolvePending(store, fetchBars, opts){
  opts = opts || {};
  const now = opts.now != null ? opts.now : Date.now();
  const tfToAlpaca = opts.tfToAlpaca || tfToAlpacaDefault;
  const barMs = opts.barMs || barMsDefault;

  const all = store.load();
  let resolved = 0, active = 0, errors = 0;
  const details = [];

  for(const rec of all){
    if(!rec || rec.status !== 'ACTIVA') continue;
    if(rec.entry == null || rec.sl == null || rec.ts == null){
      active++; details.push({ id: rec && rec.id, status:'ACTIVA' }); continue;   // sin datos para medir
    }
    const atf = tfToAlpaca(rec.tf);

    // Ventana: desde el emit hasta ahora, acotada por el horizonte (+1 barra de colchón).
    const startMs = rec.ts;
    let endMs = now;
    if(rec.horizonBars != null && rec.horizonBars > 0){
      const capMs = rec.ts + (rec.horizonBars + 1) * barMs(atf);
      if(capMs < endMs) endMs = capMs;
    }

    let bars;
    try {
      bars = await fetchBars(rec.sym, toISO(startMs), toISO(endMs), atf);
    } catch(e){
      errors++;
      if(typeof opts.onError === 'function') opts.onError(rec, e);
      details.push({ id: rec.id, status:'ERROR' });
      continue;
    }

    // Solo barras POSTERIORES al emit (excluye la barra del gatillo).
    const post = (bars || []).filter(b => b && b.t != null && Date.parse(b.t) > rec.ts);
    const out = resolveOutcome(rec, post, {});

    // Guarda EXPIRADA prematura: no sellar si el horizonte no se alcanzó de verdad.
    if(out.status === 'ACTIVA' || out.status === 'EXPIRADA'){
      const horizonReached =
        (rec.horizonBars != null && rec.horizonBars > 0)
          ? (post.length >= rec.horizonBars || now >= rec.ts + rec.horizonBars * barMs(atf))
          : (opts.maxHorizonBars != null ? post.length >= opts.maxHorizonBars : false);
      if(out.status === 'ACTIVA' || !horizonReached){
        active++; details.push({ id: rec.id, status:'ACTIVA' }); continue;
      }
    }

    const lifeBars = post.slice(0, out.barsToResolve || post.length);
    const exc = computeExcursion(rec, lifeBars);
    store.update(rec.id, {
      status: out.status, hitTP: out.hitTP, exitPrice: out.exitPrice,
      rMultiple: out.rMultiple, barsToResolve: out.barsToResolve,
      mfeR: exc.mfeR, maeR: exc.maeR,
      resolvedTs: now, resolveReason: out.reason
    });
    resolved++; details.push({ id: rec.id, status: out.status });
  }

  return { resolved, active, errors, details };
}

module.exports = { resolvePending, computeExcursion, tfToAlpacaDefault, barMsDefault, TF_ALPACA, TF_MS };
