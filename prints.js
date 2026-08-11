// prints.js — PRINTS GRANDES (bloques >$1M) + tag OFF-EXCHANGE. PURO y testeable.
// ---------------------------------------------------------------------------
// Frente DARK POOL. Un "print" es un trade individual; nos interesan los GRANDES
// (notional = precio × size sobre un umbral, default $1M) — huella de bloques /
// flujo institucional. Espeja la separacion de cvd_agresor.js: este modulo NO
// trae datos (eso es prints_live.js), solo dedup + filtra + tag + resume.
//
// TAG OFF-EXCHANGE (paso 2, validado en vivo SPY 11/08): el campo `exchange` (x del
// SIP) marca el venue. 'D' = FINRA TRF/ADF = OFF-EXCHANGE (dark pools + ATS +
// internalizadores). Es un PROXY honesto del flujo oculto, NO dark-pool puro (no
// distingue una dark pool de un internalizador de retail). Configurable.
//
// DEDUP (bug cazado en vivo): el SIP reporta a veces el MISMO trade fisico dos veces
// con condition codes distintos — el opening cross de SPY vino con 'O' y 'Q',
// mismo ts+price+size+exchange, inflando el total ~$87M. Se colapsa antes de contar.
//
// HONESTIDAD: sin trades, no se inventa nada. Basura (price/size no numerico o <=0)
// se descarta. Los prints de SUBASTA (open/close cross) se MARCAN (auction:true) pero
// NO se excluyen: mostrarlos/filtrarlos es decision de producto del llamador.
'use strict';

function num(x){ return (typeof x === 'number' && isFinite(x)) ? x : null; }

// Codigos de exchange (x del SIP) que representan flujo OFF-EXCHANGE.
// 'D' = FINRA TRF/ADF (dark pools + ATS + internalizadores). Exportado para ajustar.
const OFF_EXCHANGE_CODES = new Set(['D']);
// Condiciones de SUBASTA (no flujo continuo): 'O'/'Q' opening, 'M'/'6' closing.
const AUCTION_CONDITIONS = new Set(['O', 'Q', 'M', '6']);

function isOffExchange(exchange){
  return exchange != null && OFF_EXCHANGE_CODES.has(String(exchange));
}
function isAuction(conditions){
  return Array.isArray(conditions) && conditions.some(c => AUCTION_CONDITIONS.has(String(c).trim()));
}

// Colapsa reportes REDUNDANTES del mismo trade fisico (mismo ts+price+size+exchange,
// distinto conditions). Mantiene el primero y une las conditions de los redundantes.
// Solo deduplica cuando la identidad fisica esta COMPLETA (los 4 campos validos);
// si falta alguno, el trade pasa sin arriesgar un colapso indebido.
function dedupTrades(trades){
  if(!Array.isArray(trades)) return [];
  const byKey = new Map();
  const out = [];
  for(const t of trades){
    const price = num(t && t.price), size = num(t && t.size);
    const ts = (t && typeof t.ts === 'number' && isFinite(t.ts)) ? t.ts : null;
    const ex = (t && t.exchange != null) ? String(t.exchange) : null;
    if(ts != null && price != null && size != null && ex != null){
      const k = ts + '|' + price + '|' + size + '|' + ex;
      if(byKey.has(k)){
        const prev = byKey.get(k);
        const merged = new Set([ ...(prev.conditions || []), ...((t && Array.isArray(t.conditions)) ? t.conditions : []) ]);
        prev.conditions = [...merged];
        continue;
      }
      const copy = Object.assign({}, t);
      byKey.set(k, copy);
      out.push(copy);
    } else {
      out.push(t); // identidad incompleta: no arriesgo dedup
    }
  }
  return out;
}

// Deduplica, filtra los trades con notional (price × size) >= minNotional (default 1e6),
// y taggea cada print con offExchange + auction. Devuelve orden por notional DESC.
function filterLargePrints(trades, minNotional){
  const m = num(minNotional);
  const thr = (m != null && m > 0) ? m : 1e6;
  const deduped = dedupTrades(trades);
  const out = [];
  for(const t of deduped){
    const price = num(t && t.price), size = num(t && t.size);
    if(price == null || size == null || price <= 0 || size <= 0) continue; // basura: no cuenta
    const notional = price * size;
    if(notional < thr) continue;
    const exchange = (t && t.exchange != null) ? String(t.exchange) : null;
    const conditions = (t && Array.isArray(t.conditions)) ? t.conditions : null;
    out.push({
      ts: (t && t.ts != null) ? t.ts : null,
      price, size, notional, exchange, conditions,
      offExchange: isOffExchange(exchange),   // paso 2: tag dark pool (proxy 'D')
      auction: isAuction(conditions)          // subasta (open/close cross), no flujo continuo
    });
  }
  out.sort((a, b)=> b.notional - a.notional);
  return out;
}

// Resume una lista de prints (tipicamente salida de filterLargePrints).
// topN: cuantos de los mas grandes en `top` (default 20).
function summarizePrints(prints, topN){
  const n = (typeof topN === 'number' && topN > 0) ? Math.floor(topN) : 20;
  const arr = Array.isArray(prints) ? prints.slice() : [];
  arr.sort((a, b)=> (num(b && b.notional) || 0) - (num(a && a.notional) || 0));
  let total = 0, max = 0, offCount = 0, offNotional = 0, auctionCount = 0, auctionNotional = 0;
  for(const p of arr){
    const v = num(p && p.notional);
    if(v == null) continue;
    total += v;
    if(v > max) max = v;
    if(p && p.offExchange){ offCount++; offNotional += v; }
    if(p && p.auction){ auctionCount++; auctionNotional += v; }
  }
  return {
    count: arr.length,
    totalNotional: total,
    maxNotional: max,
    offExchangeCount: offCount,
    offExchangeNotional: offNotional,                    // $ off-exchange = proxy dark pool
    offExchangePct: total > 0 ? offNotional / total : 0, // fraccion del flujo grande que fue oculto
    auctionCount,
    auctionNotional,
    top: arr.slice(0, n)
  };
}

module.exports = {
  filterLargePrints, summarizePrints, dedupTrades,
  isOffExchange, isAuction, OFF_EXCHANGE_CODES, AUCTION_CONDITIONS
};
