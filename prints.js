// prints.js — PRINTS GRANDES (bloques >$1M). PURO y testeable (sin red, sin DOM).
// ---------------------------------------------------------------------------
// Paso 1 del frente DARK POOL. Un "print" es un trade individual; nos interesan
// los GRANDES (notional = precio × size por encima de un umbral, default $1M) —
// huella de flujo institucional / bloques. Espeja la separacion de cvd_agresor.js:
// este modulo NO trae datos (eso es prints_live.js), solo filtra y resume.
//
// El campo `exchange` (x del trade SIP) se ARRASTRA crudo, sin interpretar: el paso 2
// (tag dark pool / off-exchange) lo usara. Aca no se clasifica venue todavia — se
// deja el dato listo para no re-trabajar, pero el codigo off-exchange se valida
// contra el feed vivo, no al ojo.
//
// HONESTIDAD: sin trades, no se inventa nada (count 0). Trades basura (price/size
// no numerico o <=0) se descartan, no se cuentan.
'use strict';

function num(x){ return (typeof x === 'number' && isFinite(x)) ? x : null; }

// Filtra los trades cuyo notional (price × size) >= minNotional.
// trades: [{ts, price, size, exchange?, conditions?}]  (ts en ms; exchange/conditions opcionales)
// minNotional: umbral en $ (default 1e6 = $1M). Valores no validos caen al default.
// Devuelve [{ts, price, size, notional, exchange, conditions}] ORDENADO por notional DESC.
function filterLargePrints(trades, minNotional){
  const m = num(minNotional);
  const thr = (m != null && m > 0) ? m : 1e6;
  const out = [];
  if(!Array.isArray(trades)) return out;
  for(const t of trades){
    const price = num(t && t.price), size = num(t && t.size);
    if(price == null || size == null || price <= 0 || size <= 0) continue; // basura: no cuenta
    const notional = price * size;
    if(notional < thr) continue;
    out.push({
      ts: (t && t.ts != null) ? t.ts : null,
      price, size, notional,
      exchange: (t && t.exchange != null) ? String(t.exchange) : null,   // crudo, sin interpretar (paso 2)
      conditions: (t && Array.isArray(t.conditions)) ? t.conditions : null
    });
  }
  out.sort((a,b)=> b.notional - a.notional);
  return out;
}

// Resume una lista de prints (ya con .notional; tipicamente la salida de filterLargePrints).
// topN: cuantos de los mas grandes devolver en `top` (default 20).
// Devuelve { count, totalNotional, maxNotional, top:[...] }.
function summarizePrints(prints, topN){
  const n = (typeof topN === 'number' && topN > 0) ? Math.floor(topN) : 20;
  const arr = Array.isArray(prints) ? prints.slice() : [];
  arr.sort((a,b)=> (num(b && b.notional)||0) - (num(a && a.notional)||0));
  let total = 0, max = 0;
  for(const p of arr){
    const v = num(p && p.notional);
    if(v == null) continue;
    total += v;
    if(v > max) max = v;
  }
  return {
    count: arr.length,
    totalNotional: total,
    maxNotional: max,
    top: arr.slice(0, n)
  };
}

module.exports = { filterLargePrints, summarizePrints };
