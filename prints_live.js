// prints_live.js — Capa de I/O de los PRINTS grandes (paso 1 dark pool).
// ---------------------------------------------------------------------------
// REUSA fetchPaged de cvd_live.js (misma tuberia de trades SIP que el CVD real,
// ya probada en produccion desde 03/08) → NO duplica fetch/paginacion/auth y no
// puede divergir del stream del CVD. NO toca cvd_live.js (solo lo importa).
//
// Diferencia con cvd_live.mapTrades: ese recorta a {ts,price,size}; aca mapeamos
// los rows CRUDOS quedandonos ademas con `x` (exchange) y `c` (conditions) para
// tener el dato del venue listo para el paso 2 (tag off-exchange).
'use strict';
const { fetchPaged, inRTH } = require('./cvd_live.js');
const { filterLargePrints, summarizePrints } = require('./prints.js');

let nodeFetch;
try { nodeFetch = require('node-fetch'); }
catch { nodeFetch = (typeof fetch !== 'undefined') ? fetch : null; }

// trade Alpaca SIP crudo: { t (RFC3339), p (price), s (size), x (exchange), c (conditions[]), ... }
// -> { ts(ms), price, size, exchange, conditions }
function mapTradesFull(rows){
  if(!Array.isArray(rows)) return [];
  return rows.map(x => ({
    ts: new Date(x.t).getTime(),
    price: x.p,
    size: x.s,
    exchange: (x.x != null) ? String(x.x) : null,
    conditions: Array.isArray(x.c) ? x.c : null
  }));
}

// Principal. Devuelve los prints grandes de la ventana [start,end].
// opts: { rth=true, minNotional=1e6, topN=20, _fetch }.  _fetch inyectable para banco.
async function fetchLargePrints(sym, start, end, opts){
  opts = opts || {};
  const _fetch = opts._fetch || nodeFetch;
  const rth = opts.rth !== false;
  const minNotional = (typeof opts.minNotional === 'number' && opts.minNotional > 0) ? opts.minNotional : 1e6;
  const topN = (typeof opts.topN === 'number' && opts.topN > 0) ? opts.topN : 20;
  if(!process.env.ALPACA_KEY_ID && !opts._fetch) throw new Error('ALPACA_KEY_ID/SECRET no configuradas');

  const tRes = await fetchPaged('trades', sym, start, end, _fetch);
  let trades = mapTradesFull(tRes.rows);
  if(rth) trades = trades.filter(t => inRTH(t.ts));

  const large = filterLargePrints(trades, minNotional);
  const summary = summarizePrints(large, topN);
  return {
    ...summary,                 // count, totalNotional, maxNotional, top[]
    minNotional,
    partial: tRes.partial,      // se corto la paginacion por tope (dato real pero incompleto)
    nTrades: trades.length,     // trades vistos en ventana (post-RTH)
    hadData: trades.length > 0,
    window: { start, end, rth }
  };
}

module.exports = { fetchLargePrints, mapTradesFull };
