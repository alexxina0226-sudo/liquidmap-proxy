'use strict';
/**
 * obs_resolver.js — resuelve las OBSERVACIONES open contra barras FORWARD (PURO).
 *
 * Análogo al ledger_resolver de trades, pero usa resolveObservation (forward
 * return direccional) en vez de resolveOutcome (R de trade). fetchBars es
 * INYECTABLE (= getUnderlyingBars o mock). Reusa el mapeo tf→Alpaca del resolver
 * de trades para consistencia total. FAIL-OPEN: un fetch que tira cuenta error y
 * sigue; ya-resueltas se saltean sin pegarle a la red.
 */

const { resolveObservation } = require('./obs_ledger');

// Mapeo tf→Alpaca (estándar estable; autocontenido para no acoplar con el ledger de trades)
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

// resolveObsPending(store, fetchBars, opts) → { resolved, open, errors, details }
//   fetchBars(sym, startISO, endISO, alpacaTf) -> Promise<[{t,o,h,l,c,v}]>
//   opts: { now?, defHorizonBars?, neutralBandPct?, tfToAlpaca?, barMs?, onError?(rec,err) }
async function resolveObsPending(store, fetchBars, opts){
  opts = opts || {};
  const now = opts.now != null ? opts.now : Date.now();
  const tfToAlpaca = opts.tfToAlpaca || tfToAlpacaDefault;
  const barMs = opts.barMs || barMsDefault;
  const defH  = opts.defHorizonBars || 8;

  const all = store.load();
  let resolved = 0, open = 0, errors = 0;
  const details = [];

  for(const rec of all){
    if(!rec || rec.status !== 'open') continue;
    if(rec.ts == null || !rec.sym){ open++; details.push({ id: rec && rec.id, status:'open' }); continue; }

    const atf = tfToAlpaca(rec.tf);
    const H   = (rec.horizonBars != null && rec.horizonBars > 0) ? rec.horizonBars : defH;

    // Ventana: desde el evento hasta ahora, acotada por el horizonte (+1 barra de colchón).
    const startMs = rec.ts;
    let endMs = now;
    const capMs = rec.ts + (H + 1) * barMs(atf);
    if(capMs < endMs) endMs = capMs;

    let bars;
    try {
      bars = await fetchBars(rec.sym, toISO(startMs), toISO(endMs), atf);
    } catch(e){
      errors++;
      if(typeof opts.onError === 'function') opts.onError(rec, e);
      details.push({ id: rec.id, status:'ERROR' });
      continue;
    }

    // Solo barras POSTERIORES al evento (excluye la barra del gatillo).
    const post = (bars || []).filter(b => b && b.t != null && Date.parse(b.t) > rec.ts);

    // Sella si el horizonte se alcanzó de verdad (H barras) o si el reloj ya lo venció.
    const horizonReached = post.length >= H || now >= rec.ts + H * barMs(atf);
    const out = resolveObservation(rec, post, {
      force: horizonReached,
      defHorizonBars: defH,
      neutralBandPct: opts.neutralBandPct
    });

    if(out.status !== 'resolved'){                       // horizonte no cumplido → sigue open
      open++; details.push({ id: rec.id, status:'open' }); continue;
    }
    store.update(rec.id, {
      status: out.status, fwdRetPct: out.fwdRetPct, signedRetPct: out.signedRetPct,
      dirHit: out.dirHit, mfePct: out.mfePct, barsForward: out.barsForward,
      full: out.full, resolvedTs: out.resolvedTs
    });
    resolved++; details.push({ id: rec.id, status:'resolved', dirHit: out.dirHit });
  }

  return { resolved, open, errors, details };
}

module.exports = { resolveObsPending, toISO };
