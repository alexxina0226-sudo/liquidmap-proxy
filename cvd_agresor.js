// cvd_agresor.js — CVD por AGRESOR (Lee-Ready) para BOLSA. FASE 3.
// ---------------------------------------------------------------------------
// PURO y testeable (sin red, sin DOM). Convierte trades + quotes de Alpaca en
// buyV / sellV / cvd REALES por vela. Es el equivalente para ACCIONES del CVD
// real que el crypto obtiene gratis (la kline trae taker buy volume); el bar de
// Alpaca NO trae ese split, asi que hay que clasificar cada trade por agresor.
//
// Lee & Ready (1991) + tick rule:
//   1) QUOTE RULE — precio del trade vs midpoint del quote VIGENTE:
//        price > mid  -> BUY   (agresor comprador; pega contra el ask)
//        price < mid  -> SELL  (agresor vendedor;  pega contra el bid)
//        price == mid -> indeterminado por quote -> TICK RULE
//   2) TICK RULE — para trades al midpoint o sin quote previo:
//        price > prevPrice (uptick)   -> BUY
//        price < prevPrice (downtick) -> SELL
//        price == prevPrice (zero tick) -> arrastra la ultima direccion resuelta
//
// Quote VIGENTE = ultimo quote con q.ts <= trade.ts. Los timestamps de Alpaca son
// de alta resolucion (ns), asi que NO se usa el lag de 5s del paper original de 1991
// (ese lag corregia el retraso de reporte de las cintas de esa epoca).
//
// HONESTIDAD: si no hay trades, no se inventa nada (hadData=false). El flag cvdReal
// lo pone el llamador (la ruta) segun si el feed real respondio; este modulo solo
// reporta si CLASIFICO sobre trades verdaderos.
'use strict';

// --- helpers de guarda ---
function num(x){ return (typeof x === 'number' && isFinite(x)) ? x : null; }

// Empareja cada trade con el quote vigente (merge de dos punteros; AMBOS deben venir
// ordenados asc por ts). Devuelve un array paralelo a trades con {bid,ask,mid} o null
// si no hubo quote previo a ese trade.
// trades: [{ts, price, size}]  quotes: [{ts, bid, ask}]   ts en ms (o cualquier unidad monotona).
function matchPrevailingQuotes(trades, quotes){
  const out = new Array(trades.length);
  let qi = -1; // indice del ultimo quote con ts <= trade.ts
  for(let i=0;i<trades.length;i++){
    const t = trades[i];
    // avanzar qi mientras el SIGUIENTE quote siga siendo <= ts del trade
    while(qi+1 < quotes.length && quotes[qi+1].ts <= t.ts) qi++;
    if(qi < 0){ out[i] = null; continue; }
    const q = quotes[qi];
    const bid = num(q.bid), ask = num(q.ask);
    if(bid == null || ask == null){ out[i] = null; continue; }
    out[i] = { bid, ask, mid: (bid + ask) / 2 };
  }
  return out;
}

// Clasifica una secuencia de trades (ordenados asc por ts) contra sus quotes.
// Devuelve [{ts, price, size, side:'buy'|'sell', rule:'quote'|'tick'|'carry'|'seed'}].
// opts.seedSide: direccion por defecto para el primer trade totalmente indeterminado
//   (sin quote y sin prevPrice). Default 'buy'. Es un caso de borde marginal (<<1%).
function classifyTrades(trades, quotes, opts){
  opts = opts || {};
  const seedSide = opts.seedSide === 'sell' ? 'sell' : 'buy';
  const prev = matchPrevailingQuotes(trades, quotes);
  const out = [];
  let prevPrice = null;   // precio del trade anterior (para tick rule)
  let lastSide = null;    // ultima direccion resuelta (para zero-tick carry)
  for(let i=0;i<trades.length;i++){
    const t = trades[i];
    const price = num(t.price), size = num(t.size);
    if(price == null || size == null || size <= 0){ // trade basura: no cuenta
      continue;
    }
    const q = prev[i];
    let side = null, rule = null;
    // 1) QUOTE RULE
    if(q != null){
      if(price > q.mid){ side = 'buy';  rule = 'quote'; }
      else if(price < q.mid){ side = 'sell'; rule = 'quote'; }
    }
    // 2) TICK RULE (si el quote no decidio: al midpoint o sin quote)
    if(side == null){
      if(prevPrice != null && price > prevPrice){ side = 'buy';  rule = 'tick'; }
      else if(prevPrice != null && price < prevPrice){ side = 'sell'; rule = 'tick'; }
      else if(lastSide != null){ side = lastSide; rule = 'carry'; } // zero-tick: arrastra
      else { side = seedSide; rule = 'seed'; }                       // borde: primer trade sin nada
    }
    out.push({ ts: t.ts, price, size, side, rule });
    prevPrice = price;
    lastSide = side;
  }
  return out;
}

// Agrega los trades clasificados en las velas provistas.
// candles: [{t}] con t = INICIO de vela en ms (asc). tfMs = ancho de vela en ms.
// Un trade con ts en [c.t, c.t+tfMs) cae en esa vela. Trades fuera de todo rango se ignoran.
// Devuelve [{t, buyV, sellV, cvd}] alineado 1:1 con candles.
function aggregateByCandle(classified, candles, tfMs){
  const per = candles.map(c => ({ t: c.t, buyV: 0, sellV: 0, cvd: 0 }));
  if(!candles.length || !(tfMs > 0)) return per;
  let ci = 0;
  for(const c of classified){
    // avanzar ci hasta la vela que contiene c.ts (candles asc; classified asc)
    while(ci < candles.length && c.ts >= candles[ci].t + tfMs) ci++;
    if(ci >= candles.length) break;                 // trade posterior a la ultima vela
    if(c.ts < candles[ci].t) continue;              // trade anterior al inicio de esta vela (hueco)
    if(c.side === 'buy') per[ci].buyV += c.size;
    else                 per[ci].sellV += c.size;
  }
  for(const p of per) p.cvd = p.buyV - p.sellV;
  return per;
}

// End-to-end: trades + quotes + candles -> CVD real por vela.
// Devuelve { perBar:[{t,buyV,sellV,cvd}], hadData:bool, nTrades, nClassified }.
function computeAggressorCVD(trades, quotes, candles, tfMs, opts){
  trades = Array.isArray(trades) ? trades : [];
  quotes = Array.isArray(quotes) ? quotes : [];
  candles = Array.isArray(candles) ? candles : [];
  const classified = classifyTrades(trades, quotes, opts);
  const perBar = aggregateByCandle(classified, candles, tfMs);
  return {
    perBar,
    hadData: classified.length > 0,
    nTrades: trades.length,
    nClassified: classified.length
  };
}

module.exports = { matchPrevailingQuotes, classifyTrades, aggregateByCandle, computeAggressorCVD };
