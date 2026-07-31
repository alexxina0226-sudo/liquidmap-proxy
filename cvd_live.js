// cvd_live.js — Capa de I/O del CVD por agresor (FASE 3, etapa 2).
// ---------------------------------------------------------------------------
// Trae TRADES + QUOTES de Alpaca (feed=sip, requiere Algo Trader Plus) y se los
// pasa al clasificador PURO cvd_agresor.js. Espeja la separacion de options:
//   options_metrics.js (puro) / options_live.js (I/O)  ==  cvd_agresor.js / cvd_live.js
//
// El mapa usa el NETO agregado de las ultimas ~30 velas (un cvd + un split
// buyV/sellV para la barra de presion), NO vela-por-vela. Por eso agregamos toda
// la ventana en UNA sola "vela" (candle unico que abarca [start,end]) — el modulo
// puro ya lo resuelve. Cero re-resample de grilla en el server.
//
// HONESTO: cvdReal=true SOLO si el feed real devolvio trades. Si la paginacion se
// corto por tope, partial=true (el dato es real pero incompleto — el mapa decide).
'use strict';
const { computeAggressorCVD } = require('./cvd_agresor.js');
let nodeFetch;
try { nodeFetch = require('node-fetch'); }            // produccion (Render lo tiene)
catch { nodeFetch = (typeof fetch !== 'undefined') ? fetch : null; }

const ALPACA_DATA = process.env.ALPACA_DATA_BASE || 'https://data.alpaca.markets';
const HEADERS = {
  'Accept': 'application/json',
  'Accept-Encoding': 'identity',
  'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID || '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '',
};
const MAX_PAGES = 20;         // 20 × 10000 = 200k items/lado como techo de seguridad
const PAGE_LIMIT = 10000;

// --- RTH: mantener solo trades/quotes de 9:30–16:00 ET (DST-correcto via Intl) ---
const _etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit'
});
function etMinutes(ms){
  const parts = _etFmt.formatToParts(new Date(ms));
  let h = 0, m = 0;
  for(const p of parts){ if(p.type==='hour') h = parseInt(p.value,10)%24; else if(p.type==='minute') m = parseInt(p.value,10); }
  return h*60 + m;
}
function inRTH(ms){ const mins = etMinutes(ms); return mins >= 570 && mins < 960; } // 9:30–16:00

// Paginador generico Alpaca (mismo patron que la ruta /alpaca del server).
async function fetchPaged(kind, sym, start, end, _fetch){
  const out = [];
  let pageToken = '';
  let partial = false;
  for(let page=0; page<MAX_PAGES; page++){
    const qs = new URLSearchParams({ start, end, feed:'sip', limit:String(PAGE_LIMIT), sort:'asc' });
    if(pageToken) qs.set('page_token', pageToken);
    const url = `${ALPACA_DATA}/v2/stocks/${encodeURIComponent(sym)}/${kind}?${qs.toString()}`;
    let r, text;
    for(let attempt=1; attempt<=2; attempt++){
      try { r = await _fetch(url, { headers: HEADERS }); text = await r.text(); break; }
      catch(e){ if(attempt===2) throw e; await new Promise(rs=>setTimeout(rs,400)); }
    }
    let data;
    try { data = JSON.parse(text); } catch(e){ throw new Error(kind+'_invalid_json: '+text.slice(0,120)); }
    if(!r.ok) throw new Error(kind+'_http_'+r.status+': '+(data && data.message || '').slice(0,120));
    const rows = Array.isArray(data[kind]) ? data[kind] : [];
    for(const x of rows) out.push(x);
    pageToken = data.next_page_token || '';
    if(!pageToken) break;
    if(page === MAX_PAGES-1 && pageToken) partial = true; // se corto por tope
  }
  return { rows: out, partial };
}

// trades Alpaca: {t (RFC3339), p (price), s (size), ...} -> {ts(ms), price, size}
function mapTrades(rows){ return rows.map(x => ({ ts:new Date(x.t).getTime(), price:x.p, size:x.s })); }
// quotes Alpaca: {t, bp (bid price), ap (ask price), ...} -> {ts(ms), bid, ask}
function mapQuotes(rows){ return rows.map(x => ({ ts:new Date(x.t).getTime(), bid:x.bp, ask:x.ap })); }

// Principal. Devuelve el agregado real de la ventana [start,end].
// opts: { rth=true, _fetch }.  _fetch inyectable para banco (default global fetch).
async function fetchAggressorCVD(sym, start, end, opts){
  opts = opts || {};
  const _fetch = opts._fetch || nodeFetch;
  const rth = opts.rth !== false;
  if(!process.env.ALPACA_KEY_ID && !opts._fetch) throw new Error('ALPACA_KEY_ID/SECRET no configuradas');

  const [tRes, qRes] = await Promise.all([
    fetchPaged('trades', sym, start, end, _fetch),
    fetchPaged('quotes', sym, start, end, _fetch),
  ]);
  let trades = mapTrades(tRes.rows);
  let quotes = mapQuotes(qRes.rows);
  if(rth){
    trades = trades.filter(t => inRTH(t.ts));
    quotes = quotes.filter(q => inRTH(q.ts));
  }
  // ordenar por ts asc (Alpaca ya devuelve asc, pero lo garantizamos por robustez)
  trades.sort((a,b)=>a.ts-b.ts);
  quotes.sort((a,b)=>a.ts-b.ts);

  // Ventana entera = una sola vela [startMs, endMs). El modulo puro agrega.
  const startMs = new Date(start).getTime(), endMs = new Date(end).getTime();
  const r = computeAggressorCVD(trades, quotes, [{t:startMs}], Math.max(1, endMs-startMs), {});
  const agg = r.perBar[0] || { buyV:0, sellV:0, cvd:0 };
  return {
    buyV: agg.buyV, sellV: agg.sellV, cvd: agg.cvd,
    cvdReal: r.hadData,                          // hubo trades reales clasificados
    partial: tRes.partial || qRes.partial,       // se corto por tope de paginacion
    nTrades: trades.length, nQuotes: quotes.length,
    window: { start, end, rth }
  };
}

module.exports = { fetchAggressorCVD, fetchPaged, mapTrades, mapQuotes, inRTH, etMinutes };
