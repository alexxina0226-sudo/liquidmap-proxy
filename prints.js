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
// Condiciones CONTINGENTES (validado en vivo SPY 11/08): '7' = Qualified Contingent
// Trade (activo desde 2015), 'V' = Contingent Trade. Son patas de un paquete (típico
// hedge con opciones) y SE VALÚAN CONTRA EL PAQUETE, no contra el mercado lit → el
// precio puede estar MUY fuera de mercado (SPY: print a $829 con precio real ~$773,
// $273.5M, cond 7/V). NO es dark pool direccional: es ruido de hedge. Se EXCLUYE del
// read igual que la subasta. Configurable.
const CONTINGENT_CONDITIONS = new Set(['7', 'V']);
// Tolerancia de sanidad de precio: un print cuyo precio se aleja > esto de la mediana
// de la ventana se marca outlier y sale del read (default 10%, CONSERVADOR — solo pesca
// fat-fingers groseros; los contingentes ya salen por su condition code, esto es la red).
const PRICE_OUTLIER_TOL = 0.10;

function isOffExchange(exchange){
  return exchange != null && OFF_EXCHANGE_CODES.has(String(exchange));
}
function isAuction(conditions){
  return Array.isArray(conditions) && conditions.some(c => AUCTION_CONDITIONS.has(String(c).trim()));
}
function isContingent(conditions){
  return Array.isArray(conditions) && conditions.some(c => CONTINGENT_CONDITIONS.has(String(c).trim()));
}
function _median(nums){
  const a = nums.filter(x => typeof x === 'number' && isFinite(x)).sort((x, y)=> x - y);
  if(!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
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
      auction: isAuction(conditions),         // subasta (open/close cross), no flujo continuo
      contingent: isContingent(conditions)    // trade contingente (7/V): hedge, precio off-market
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

  // Referencia de precio: mediana de prints LIMPIOS candidatos (ni subasta ni contingente)
  // para pescar ticks aberrantes SIN que el propio outlier ensucie la referencia. Si hay
  // menos de 3, no hay base confiable → la red de outlier queda dormida (no excluye nada).
  const refPrices = [];
  for(const p of arr){
    if(p && !p.auction && !p.contingent){ const pr = num(p.price); if(pr != null) refPrices.push(pr); }
  }
  const med = refPrices.length >= 3 ? _median(refPrices) : null;
  const isPriceOutlier = (p)=>{
    if(med == null || med <= 0) return false;
    const pr = num(p && p.price);
    return pr != null && Math.abs(pr - med) / med > PRICE_OUTLIER_TOL;
  };

  let total = 0, max = 0, count = 0, offCount = 0, offNotional = 0, auctionCount = 0, auctionNotional = 0;
  let excludedCount = 0, excludedNotional = 0, contingentCount = 0, contingentNotional = 0, outlierCount = 0, outlierNotional = 0;
  const clean = [];
  for(const p of arr){
    const v = num(p && p.notional);
    if(v == null) continue;
    const cont = !!(p && p.contingent);
    const out  = isPriceOutlier(p);
    if(cont || out){
      // FUERA del read del dark pool: el precio no representa flujo continuo real.
      excludedCount++; excludedNotional += v;
      if(cont){ contingentCount++; contingentNotional += v; }
      if(out){  outlierCount++;   outlierNotional  += v; }
      continue;
    }
    // Print LIMPIO: cuenta para el read.
    clean.push(p);
    count++; total += v;
    if(v > max) max = v;
    if(p && p.offExchange){ offCount++; offNotional += v; }
    if(p && p.auction){ auctionCount++; auctionNotional += v; }
  }
  return {
    count,                                               // prints LIMPIOS (excluye contingentes/outliers)
    totalNotional: total,
    maxNotional: max,
    offExchangeCount: offCount,
    offExchangeNotional: offNotional,                    // $ off-exchange LIMPIO = proxy dark pool honesto
    offExchangePct: total > 0 ? offNotional / total : 0, // fraccion del flujo grande LIMPIO que fue oculto
    auctionCount,
    auctionNotional,
    excludedCount, excludedNotional,                     // sacados del read (contingentes + outliers de precio)
    contingentCount, contingentNotional,                 // trades contingentes (cond 7/V): hedge, precio off-market
    priceOutlierCount: outlierCount, priceOutlierNotional: outlierNotional,
    top: clean.slice(0, n)                               // top de prints LIMPIOS (sin ruido)
  };
}

module.exports = {
  filterLargePrints, summarizePrints, dedupTrades,
  isOffExchange, isAuction, isContingent,
  OFF_EXCHANGE_CODES, AUCTION_CONDITIONS, CONTINGENT_CONDITIONS
};
