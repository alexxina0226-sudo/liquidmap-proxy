const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();

// ── CORS ─────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── MAPAS HTML ───────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'LiquidityMap_BOLSA_v5.html'));
});
app.get('/bolsa', (req, res) => {
  res.sendFile(path.join(__dirname, 'LiquidityMap_BOLSA_v5.html'));
});
app.get('/crypto', (req, res) => {
  res.sendFile(path.join(__dirname, 'LiquidityMap_CRYPTO_v6_2.html'));
});

// ── FAVICON (SVG embebido — mata el 404 en AMBOS mapas, cero archivo externo) ──
// Mini-chart con la identidad LiquidMap: velas neón (cyan/verde/rojo) + línea
// de tendencia amarilla sobre fondo oscuro. Cuando cualquier navegador pide
// /favicon.ico, el server lo sirve → se acaba el "Failed to load favicon.ico 404".
const FAVICON_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="6" fill="#02040c"/>' +
  '<rect x="5" y="18" width="3" height="9" rx="1" fill="#00e5ff"/>' +
  '<rect x="11" y="13" width="3" height="14" rx="1" fill="#00ff9d"/>' +
  '<rect x="17" y="8" width="3" height="19" rx="1" fill="#00ff9d"/>' +
  '<rect x="23" y="14" width="3" height="13" rx="1" fill="#ff2d6b"/>' +
  '<path d="M5 16 L13 11 L19 6 L27 12" fill="none" stroke="#ffe000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>'
);
function serveFavicon(req, res) {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_SVG);
}
app.get('/favicon.ico', serveFavicon);
app.get('/favicon.svg', serveFavicon);

// ═══════════════════════════════════════════════════════════
// ADAPTADOR BINANCE → BYBIT
// Binance devuelve 418 (IP baneado por exceso de peso) desde Render.
// Bybit responde ok:true desde la misma región (confirmado en /diag).
// El mapa crypto sigue pidiendo "en idioma Binance"; aquí traducimos
// la llamada a Bybit y devolvemos la respuesta con la FORMA que el
// mapa ya espera. Así el mapa HTML NO se toca (cero riesgo).
// ═══════════════════════════════════════════════════════════
const BYBIT = 'https://api.bybit.com';

// Binance interval → Bybit interval
const BYBIT_INTERVAL = {
  '1m':'1','3m':'3','5m':'5','15m':'15','30m':'30',
  '1h':'60','2h':'120','4h':'240','6h':'360','12h':'720',
  '1d':'D','3d':'D','1w':'W','1M':'M'
};
// duración de vela en ms (para reconstruir closeTime estilo Binance)
const KLINE_DUR_MS = {
  '1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,
  '1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,'12h':43200000,
  '1d':86400000,'3d':259200000,'1w':604800000
};

async function bybitGet(url){
  const r = await fetch(url, {
    headers: { 'Accept':'application/json', 'User-Agent':'Mozilla/5.0 (LiquidMap)' },
    timeout: 10000
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch (e) { return { ok:false, status:r.status, raw:text.slice(0,160) }; }
  return { ok: r.ok && j.retCode === 0, status:r.status, j };
}

// Devuelve { data } si traduce, { error, status } si el upstream falló,
// o null si el path NO es un endpoint crypto conocido (→ fallback Binance/Finnhub).
async function bybitAdapter(apiPath, q){
  const symbol = (q.symbol || '').toUpperCase();

  // ── SPOT · ticker 24h ──────────────────────────
  if (apiPath === '/api/v3/ticker/24hr'){
    const res = await bybitGet(`${BYBIT}/v5/market/tickers?category=spot&symbol=${symbol}`);
    const t = res.j && res.j.result && res.j.result.list && res.j.result.list[0];
    if (!res.ok || !t) return { error:true, status:res.status };
    const last = parseFloat(t.lastPrice), prev = parseFloat(t.prevPrice24h);
    return { data: {
      symbol:             t.symbol,
      lastPrice:          t.lastPrice,
      highPrice:          t.highPrice24h,
      lowPrice:           t.lowPrice24h,
      openPrice:          t.prevPrice24h,
      volume:             t.volume24h,      // base
      quoteVolume:        t.turnover24h,    // quote
      priceChangePercent: (parseFloat(t.price24hPcnt) * 100).toFixed(2),
      priceChange:        (last - prev).toFixed(8),
      count:              0                 // Bybit spot no expone nº de trades
    }};
  }

  // ── SPOT · último precio ───────────────────────
  if (apiPath === '/api/v3/ticker/price'){
    const res = await bybitGet(`${BYBIT}/v5/market/tickers?category=spot&symbol=${symbol}`);
    const t = res.j && res.j.result && res.j.result.list && res.j.result.list[0];
    if (!res.ok || !t) return { error:true, status:res.status };
    return { data: { symbol, price: t.lastPrice } };
  }

  // ── SPOT · klines ──────────────────────────────
  if (apiPath === '/api/v3/klines'){
    const interval = BYBIT_INTERVAL[q.interval] || '15';
    let limit = parseInt(q.limit) || 200; if (limit > 1000) limit = 1000;
    const res = await bybitGet(`${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`);
    const list = res.j && res.j.result && res.j.result.list;
    if (!res.ok || !Array.isArray(list)) return { error:true, status:res.status };
    const dur = KLINE_DUR_MS[q.interval] || 900000;
    // Bybit entrega newest-first → invertir a oldest-first (como Binance).
    // Formato Binance: [openTime, o, h, l, c, vol, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore]
    const rows = list.slice().reverse().map(k => {
      const start = parseInt(k[0]);
      return [ start, k[1], k[2], k[3], k[4], k[5], start + dur - 1, k[6], 0, "0", "0", "0" ];
    });
    return { data: rows };
  }

  // ── SPOT · aggTrades (recent-trade) ────────────
  if (apiPath === '/api/v3/aggTrades'){
    let limit = parseInt(q.limit) || 60; if (limit > 60) limit = 60; // Bybit spot máx 60
    const res = await bybitGet(`${BYBIT}/v5/market/recent-trade?category=spot&symbol=${symbol}&limit=${limit}`);
    const list = res.j && res.j.result && res.j.result.list;
    if (!res.ok || !Array.isArray(list)) return { error:true, status:res.status };
    // Binance aggTrade: { p, q, T, m }  (m = buyer es maker → agresor vendió)
    const rows = list.map(t => ({
      a: t.execId,
      p: t.price,
      q: t.size,
      T: parseInt(t.time),
      m: t.side === 'Sell'        // taker SELL ↔ Binance m=true
    }));
    return { data: rows };
  }

  // ── FUTUROS · funding + OI (Bybit linear tickers) ──
  if (apiPath === '/fapi/v1/premiumIndex' || apiPath === '/fapi/v1/openInterest'){
    const res = await bybitGet(`${BYBIT}/v5/market/tickers?category=linear&symbol=${symbol}`);
    const t = res.j && res.j.result && res.j.result.list && res.j.result.list[0];
    if (!res.ok || !t) return { error:true, status:res.status };
    if (apiPath === '/fapi/v1/premiumIndex'){
      return { data: {
        symbol,
        lastFundingRate: t.fundingRate     || "0",
        nextFundingTime: t.nextFundingTime || "0",
        markPrice:       t.markPrice       || t.lastPrice
      }};
    }
    return { data: { symbol, openInterest: t.openInterest || "0", time: Date.now() } };
  }

  // ── FUTUROS · historial de funding (Bybit funding/history) ──
  if (apiPath === '/fapi/v1/fundingRate'){
    let limit = parseInt(q.limit) || 3; if (limit > 200) limit = 200;
    const res = await bybitGet(`${BYBIT}/v5/market/funding/history?category=linear&symbol=${symbol}&limit=${limit}`);
    const list = res.j && res.j.result && res.j.result.list;
    if (!res.ok || !Array.isArray(list)) return { error:true, status:res.status };
    // Bybit entrega newest-first → Binance ascendente. Item Binance: {symbol, fundingRate, fundingTime}
    const rows = list.slice().reverse().map(x => ({
      symbol,
      fundingRate: x.fundingRate,
      fundingTime: parseInt(x.fundingRateTimestamp)
    }));
    return { data: rows };
  }

  // ── FUTUROS · historial de Open Interest (Bybit open-interest) ──
  if (apiPath === '/futures/data/openInterestHist'){
    const PERIOD = { '5m':'5min','15m':'15min','30m':'30min','1h':'1h','4h':'4h','1d':'1d' };
    const intervalTime = PERIOD[q.period] || '4h';
    let limit = parseInt(q.limit) || 10; if (limit > 200) limit = 200;
    const res = await bybitGet(`${BYBIT}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${intervalTime}&limit=${limit}`);
    const list = res.j && res.j.result && res.j.result.list;
    if (!res.ok || !Array.isArray(list)) return { error:true, status:res.status };
    // Bybit newest-first → Binance ascendente. Item Binance: {sumOpenInterest, sumOpenInterestValue, timestamp}
    const rows = list.slice().reverse().map(x => ({
      sumOpenInterest:      x.openInterest,
      sumOpenInterestValue: "0",
      timestamp:            parseInt(x.timestamp)
    }));
    return { data: rows };
  }

  // ── FUTUROS · long/short ratio (Bybit account-ratio) ──
  if (apiPath === '/futures/data/globalLongShortAccountRatio'){
    const PERIOD = { '5m':'5min','15m':'15min','30m':'30min','1h':'1h','4h':'4h','1d':'1d' };
    const period = PERIOD[q.period] || '4h';
    let limit = parseInt(q.limit) || 5; if (limit > 200) limit = 200;
    const res = await bybitGet(`${BYBIT}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=${period}&limit=${limit}`);
    const list = res.j && res.j.result && res.j.result.list;
    if (!res.ok || !Array.isArray(list)) return { error:true, status:res.status };
    // Bybit newest-first → Binance ascendente. Item Binance: {longAccount, shortAccount, longShortRatio, timestamp}
    const rows = list.slice().reverse().map(x => {
      const buy = parseFloat(x.buyRatio), sell = parseFloat(x.sellRatio);
      return {
        longAccount:    String(buy),
        shortAccount:   String(sell),
        longShortRatio: sell > 0 ? String(buy / sell) : "1",
        timestamp:      parseInt(x.timestamp)
      };
    });
    return { data: rows };
  }

  return null; // no es endpoint crypto conocido → fallback
}

// ── PROXY (adaptador Bybit + fallback Binance/Finnhub endurecido) ──
app.get('/proxy', async (req, res) => {
  try {
    const apiPath = req.query.path;
    if (!apiPath) return res.status(400).json({ error: 'Missing path param' });

    // 0) KLINES: preferir Binance — trae taker buy volume REAL en el campo [9]
    //    → CVD/delta reales por vela. Frankfurt no está geobloqueado (fapi ya llega).
    //    Si Binance falla, cae al adaptador Bybit de abajo (peor caso = comportamiento previo).
    if (apiPath === '/api/v3/klines') {
      try {
        const p = new URLSearchParams();
        if (req.query.symbol)   p.set('symbol', String(req.query.symbol).toUpperCase());
        if (req.query.interval) p.set('interval', req.query.interval);
        if (req.query.limit)    p.set('limit', req.query.limit);
        const bUrl = `https://api.binance.com/api/v3/klines?${p.toString()}`;
        const br = await fetch(bUrl, { headers: { 'Accept':'application/json', 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 10000 });
        if (br.ok) {
          const bd = await br.json();
          if (Array.isArray(bd) && bd.length) return res.json(bd);   // [9]=takerBuyBase real
        }
      } catch (e) { /* sigue al adaptador Bybit */ }
    }

    // 1) Intentar el adaptador Bybit para endpoints crypto conocidos
    try {
      const adapted = await bybitAdapter(apiPath, req.query);
      if (adapted){
        if (adapted.error) return res.status(502).json({ error:'bybit_unavailable', upstream_status: adapted.status });
        return res.json(adapted.data);
      }
    } catch (e) {
      return res.status(502).json({ error:'bybit_adapter_error', message: e.message });
    }

    // 2) Fallback: comportamiento original (Binance / Finnhub) — intacto
    const futures = req.query.futures === '1';
    const params = Object.entries(req.query)
      .filter(([k]) => k !== 'path' && k !== 'futures')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    let baseUrl;
    if (futures)                              baseUrl = `https://fapi.binance.com${apiPath}`;
    else if (apiPath.startsWith('/fapi'))     baseUrl = `https://fapi.binance.com${apiPath}`;
    else if (apiPath.startsWith('/api'))      baseUrl = `https://api.binance.com${apiPath}`;
    else if (apiPath.startsWith('/finnhub') || req.query.token)
                                              baseUrl = `https://finnhub.io${apiPath}`;
    else                                      baseUrl = `https://api.binance.com${apiPath}`;
    const fullUrl = params ? `${baseUrl}?${params}` : baseUrl;

    const r    = await fetch(fullUrl, { headers: { 'Accept': 'application/json' }, timeout: 10000 });
    const ct   = r.headers.get('content-type') || '';
    const text = await r.text();
    if (!r.ok || !ct.includes('json')) {
      return res.status(502).json({
        error:           'upstream_unavailable',
        upstream_status: r.status,
        upstream_ct:     ct,
        sample:          text.slice(0, 160)
      });
    }
    let data;
    try { data = JSON.parse(text); }
    catch (e) { return res.status(502).json({ error: 'invalid_json', sample: text.slice(0, 160) }); }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PROXY POLYGON (key del lado servidor — la API key NUNCA viaja al navegador) ──
// El mapa de bolsa pide /polygon?path=/v2/aggs/...&adjusted=...  (SIN apiKey).
// Acá adjuntamos la key desde process.env.POLYGON_KEY y llamamos a Polygon.
// Resultado: la key queda oculta (no en URL ni en HTML) y se acaban los errores
// de consola CORS/502 (la llamada pasa a ser server-to-server).
// Restringido a /v2/aggs/ (solo lectura de agregados) para acotar el uso del proxy.
const POLYGON_KEY = process.env.POLYGON_KEY || '';
// Polygon.io se renombró a Massive.com (30-oct-2025). El endpoint viejo api.polygon.io
// se está apagando en 2026 (da "Premature close"). Base nueva: api.massive.com (misma API/key).
// Override con POLYGON_BASE si alguna vez cambia de nuevo.
const POLYGON_BASE = process.env.POLYGON_BASE || 'https://api.massive.com';
// Massive manda respuestas comprimidas que node-fetch no digiere → "Premature close".
// Fix probado: pedir SIN compresión (Accept-Encoding: identity) + User-Agent de navegador.
const POLYGON_HEADERS = {
  'Accept': 'application/json',
  'Accept-Encoding': 'identity',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};
// ── PROXY ALPACA (SIP real-time — reemplaza el delay 15min de Polygon/Massive) ──
// El mapa de bolsa pide /alpaca?path=/v2/aggs/ticker/{SYM}/range/{MULT}/{SPAN}/{FROM}/{TO}
// (MISMO formato que /polygon). Acá traducimos a la API de Alpaca y devolvemos las barras
// con la MISMA forma que Polygon ({status:'OK', results:[{t(ms),o,h,l,c,v,vw,n}]}) para que
// el mapa cambie UNA sola línea (POLY_PROXY → /alpaca) y todo su motor siga igual.
// Las keys viven server-side (NUNCA viajan al navegador). feed=sip (requiere Algo Trader Plus).
const ALPACA_KEY_ID  = process.env.ALPACA_KEY_ID  || '';
const ALPACA_SECRET  = process.env.ALPACA_SECRET_KEY || '';
const ALPACA_DATA    = process.env.ALPACA_DATA_BASE || 'https://data.alpaca.markets';
const ALPACA_TRADE   = process.env.ALPACA_TRADE_BASE || 'https://api.alpaca.markets'; // contracts/open-interest (trading API)
const ALPACA_HEADERS = {
  'Accept': 'application/json',
  'Accept-Encoding': 'identity',
  'APCA-API-KEY-ID': ALPACA_KEY_ID,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
};
// mult+span (estilo Polygon) → timeframe de Alpaca: 4/hour→4Hour · 15/minute→15Min · 1/day→1Day
function alpacaTF(mult, span) {
  const unit = { minute: 'Min', hour: 'Hour', day: 'Day', week: 'Week', month: 'Month' }[String(span).toLowerCase()];
  if (!unit) return null;
  return `${mult}${unit}`;
}
// adjusted=true (Polygon) ≈ adjustment=split (Alpaca: ajusta precio/volumen por splits)
app.get('/alpaca', async (req, res) => {
  try {
    if (!ALPACA_KEY_ID || !ALPACA_SECRET) {
      return res.status(500).json({ status: 'ERROR', error: 'ALPACA_KEY_ID/ALPACA_SECRET_KEY no configuradas en el servidor (Render → Environment)' });
    }
    const apiPath = req.query.path || '';
    // Parsear el path estilo Polygon: /v2/aggs/ticker/SYM/range/MULT/SPAN/FROM/TO
    const m = apiPath.match(/^\/v2\/aggs\/ticker\/([^/]+)\/range\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (!m) return res.status(400).json({ status: 'ERROR', error: 'path inválido (esperado /v2/aggs/ticker/SYM/range/MULT/SPAN/FROM/TO)' });
    const sym  = decodeURIComponent(m[1]).toUpperCase();
    const mult = m[2], span = m[3], from = m[4], to = m[5];
    const timeframe = alpacaTF(mult, span);
    if (!timeframe) return res.status(400).json({ status: 'ERROR', error: `span no soportado: ${span}` });
    const sort       = (req.query.sort === 'desc') ? 'desc' : 'asc';
    const adjustment = (String(req.query.adjusted) === 'true') ? 'split' : 'raw';
    const wantLimit  = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50000, 50000));

    // Alpaca pagina (máx 10000/página) → acumulamos siguiendo next_page_token.
    const out = [];
    let pageToken = '';
    for (let page = 0; page < 8; page++) {
      const qs = new URLSearchParams({
        timeframe, start: from, end: to, adjustment, feed: 'sip', sort,
        limit: String(Math.min(10000, wantLimit - out.length)),
      });
      if (pageToken) qs.set('page_token', pageToken);
      const url = `${ALPACA_DATA}/v2/stocks/${encodeURIComponent(sym)}/bars?${qs.toString()}`;
      let r, text;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { r = await fetch(url, { headers: ALPACA_HEADERS, timeout: 12000 }); text = await r.text(); break; }
        catch (e) { if (attempt === 2) throw e; await new Promise(rs => setTimeout(rs, 400)); }
      }
      let data;
      try { data = JSON.parse(text); }
      catch (e) { return res.status(502).json({ status: 'ERROR', error: 'alpaca_invalid_json', upstream_status: r.status, sample: text.slice(0, 160) }); }
      if (!r.ok) return res.status(r.status).json({ status: 'ERROR', error: data.message || 'alpaca_error', upstream_status: r.status });
      const bars = Array.isArray(data.bars) ? data.bars : [];
      for (const b of bars) {
        // Alpaca: t = RFC-3339 string → ms (Polygon entrega ms). Resto de campos idénticos.
        out.push({ t: new Date(b.t).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, vw: b.vw, n: b.n });
      }
      pageToken = data.next_page_token || '';
      if (!pageToken || out.length >= wantLimit) break;
    }
    return res.json({ status: 'OK', ticker: sym, resultsCount: out.length, results: out });
  } catch (e) {
    res.status(500).json({ status: 'ERROR', error: e.message });
  }
});

app.get('/polygon', async (req, res) => {
  try {
    if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY no configurada en el servidor (Render → Environment)' });
    const apiPath = req.query.path;
    if (!apiPath || !apiPath.startsWith('/v2/aggs/')) return res.status(400).json({ error: 'path inválido (solo /v2/aggs/)' });
    const params = Object.entries(req.query)
      .filter(([k]) => k !== 'path')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `${POLYGON_BASE}${apiPath}?${params ? params + '&' : ''}apiKey=${POLYGON_KEY}`;
    // 2 intentos: bajo carga (instancia free + NY abierto) la conexión a Polygon puede
    // cortarse ("Premature close"). Un reintento corto suele resolver el corte transitorio.
    let r, text;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        r    = await fetch(url, { headers: POLYGON_HEADERS, timeout: 10000 });
        text = await r.text();
        break;
      } catch (e) {
        if (attempt === 2) throw e;                       // tras 2 intentos, propaga al catch (→ 500, como antes)
        await new Promise(res => setTimeout(res, 400));    // backoff corto antes del reintento
      }
    }
    let data;
    try { data = JSON.parse(text); }
    catch (e) { return res.status(502).json({ error: 'polygon_invalid_json', upstream_status: r.status, sample: text.slice(0, 160) }); }
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DIAGNÓSTICO DE RED ────────────────────────────
app.get('/diag', async (req, res) => {
  const targets = [
    { name: 'binance_spot', url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT' },
    { name: 'binance_fut',  url: 'https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT' },
    { name: 'bybit',        url: 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT' },
    { name: 'bybit_linear', url: 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT' },
    { name: 'okx',          url: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT' },
    { name: 'coinbase',     url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker' },
    { name: 'kraken',       url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSDT' },
    { name: 'coingecko',    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd' },
  ];
  const results = [];
  for (const t of targets) {
    const started = Date.now();
    try {
      const r    = await fetch(t.url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (LiquidMapDiag)' },
        timeout: 8000
      });
      const ct   = r.headers.get('content-type') || '';
      const text = await r.text();
      results.push({ name: t.name, ok: r.ok, status: r.status, ct, ms: Date.now() - started, sample: text.slice(0, 110) });
    } catch (e) {
      results.push({ name: t.name, ok: false, error: e.message, ms: Date.now() - started });
    }
  }
  res.json({
    time:  new Date().toISOString(),
    nota:  'El exchange con ok:true y sample JSON real es el que tu servidor SI puede usar.',
    region_render: process.env.RENDER_REGION || 'desconocida (ver dashboard)',
    results
  });
});

// ── DIAGNÓSTICO POLYGON ───────────────────────────
// Abrí /polygon-diag y leé el JSON: nos dice EXACTAMENTE qué responde Polygon al server.
//   ok:true  + status:200            → la key y la conexión andan (el problema sería otro)
//   ok:false + status:401/403        → la KEY no sirve (vencida / plan equivocado)
//   ok:false + status:429            → LÍMITE de Polygon (plan / cuota)
//   ok:false + error:'Premature...'  → la conexión se corta (egress de Render o Polygon dropea)
app.get('/polygon-diag', async (req, res) => {
  if (!POLYGON_KEY) return res.json({ ok: false, error: 'POLYGON_KEY no configurada en el servidor' });
  const path = `/v2/aggs/ticker/SPY/range/1/day/2026-06-08/2026-06-13?adjusted=true&sort=asc&limit=10&apiKey=${POLYGON_KEY}`;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const nativeFetch = (typeof globalThis.fetch === 'function') ? globalThis.fetch : null;

  // Cada estrategia: distinto host / headers / cliente → vemos cuál logra traer data
  const strategies = [
    { name: 'massive + Accept (actual)',        host: 'https://api.massive.com', client: 'node-fetch', headers: { 'Accept': 'application/json' } },
    { name: 'massive + User-Agent navegador',   host: 'https://api.massive.com', client: 'node-fetch', headers: { 'Accept': 'application/json', 'User-Agent': UA } },
    { name: 'massive + UA + sin compresión',    host: 'https://api.massive.com', client: 'node-fetch', headers: { 'Accept': 'application/json', 'User-Agent': UA, 'Accept-Encoding': 'identity' } },
    { name: 'polygon + UA',                     host: 'https://api.polygon.io', client: 'node-fetch', headers: { 'Accept': 'application/json', 'User-Agent': UA } },
    { name: 'massive + fetch nativo + UA',      host: 'https://api.massive.com', client: 'native', headers: { 'Accept': 'application/json', 'User-Agent': UA } },
  ];

  const results = [];
  for (const s of strategies) {
    const started = Date.now();
    try {
      const doFetch = (s.client === 'native' && nativeFetch) ? nativeFetch : fetch;
      if (s.client === 'native' && !nativeFetch) { results.push({ name: s.name, skip: 'fetch nativo no disponible (Node viejo)' }); continue; }
      const r    = await doFetch(s.host + path, { headers: s.headers, timeout: 10000 });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = null; }
      results.push({ name: s.name, ok: r.ok, status: r.status, ms: Date.now() - started,
        resultsCount: body && body.resultsCount, sample: text.slice(0, 120) });
    } catch (e) {
      results.push({ name: s.name, ok: false, error: e.message, ms: Date.now() - started });
    }
  }
  const winner = results.find(x => x.ok);
  res.json({ veredicto: winner ? `✅ FUNCIONA: ${winner.name}` : '❌ ninguna estrategia trajo data', node: process.version, results });
});

// ── DIAGNÓSTICO ALPACA ────────────────────────────
// Abrí /alpaca-diag y leé el JSON: confirma que las keys + el SIP andan (sirve con mercado cerrado).
//   ok:true  + bars>0          → keys + SIP OK (data histórica trae barras)
//   ok:false + status:401/403  → keys mal / cuenta sin Algo Trader Plus
//   ok:false + msg 'subscription' → falta el plan SIP en la cuenta de esas keys
app.get('/alpaca-diag', async (req, res) => {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET) return res.json({ ok: false, error: 'ALPACA_KEY_ID/ALPACA_SECRET_KEY no configuradas' });
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const url  = `${ALPACA_DATA}/v2/stocks/SPY/bars?timeframe=1Day&start=${from}&end=${to}&feed=sip&adjustment=split&limit=10`;
  const started = Date.now();
  try {
    const r    = await fetch(url, { headers: ALPACA_HEADERS, timeout: 12000 });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    const bars = body && Array.isArray(body.bars) ? body.bars.length : 0;
    res.json({
      veredicto: r.ok && bars > 0 ? `✅ FUNCIONA — SIP trae ${bars} barras de SPY` : '❌ revisar (ver status/sample)',
      ok: r.ok && bars > 0, status: r.status, ms: Date.now() - started,
      key: ALPACA_KEY_ID.slice(0, 4) + '…', bars,
      last: bars ? body.bars[bars - 1] : null,
      sample: text.slice(0, 200),
    });
  } catch (e) { res.json({ ok: false, error: e.message, ms: Date.now() - started }); }
});

// ── DIAGNÓSTICO OPCIONES ALPACA (¿revive GEX / Max Pain REAL?) ──────
// GEX = gamma × open interest por strike · Max Pain = open interest por strike.
// Mide si TU plan trae las DOS piezas crudas (sin inventar nada):
//   1) GREEKS+IV  → market data : /v1beta1/options/snapshots/{SYM}  (feed indicative|opra)
//   2) OPEN INT.  → trading API : /v2/options/contracts?underlying_symbols={SYM}
// Probá:  /alpaca-options-diag             (feed indicative, base live)
//         /alpaca-options-diag?feed=opra   (real-time; requiere entitlement OPRA)
//         /alpaca-options-diag?paper=1     (si tus keys son de paper trading)
app.get('/alpaca-options-diag', async (req, res) => {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET) return res.json({ ok: false, error: 'ALPACA_KEY_ID/ALPACA_SECRET_KEY no configuradas' });
  const sym       = String(req.query.sym  || 'SPY').toUpperCase();
  const feed      = String(req.query.feed || 'indicative');
  const tradeBase = req.query.paper ? 'https://paper-api.alpaca.markets' : ALPACA_TRADE;
  const started   = Date.now();
  const out = { sym, feed, greeks: {}, openInterest: {} };

  // 1) GREEKS + IV → gamma para el GEX
  try {
    const url = `${ALPACA_DATA}/v1beta1/options/snapshots/${encodeURIComponent(sym)}?feed=${encodeURIComponent(feed)}&limit=100`;
    const r = await fetch(url, { headers: ALPACA_HEADERS, timeout: 12000 });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    const snaps = body && body.snapshots ? Object.entries(body.snapshots) : [];
    const withGamma = snaps.filter(([, v]) => v && v.greeks && typeof v.greeks.gamma === 'number');
    const ej = withGamma[0];
    out.greeks = {
      status: r.status, contratos: snaps.length, con_gamma: withGamma.length,
      tiene_gamma: withGamma.length > 0,
      ejemplo: ej ? { symbol: ej[0], gamma: ej[1].greeks.gamma, iv: ej[1].impliedVolatility } : null,
      sample: text.slice(0, 180),
    };
  } catch (e) { out.greeks = { error: e.message }; }

  // 2) OPEN INTEREST → Max Pain + ponderación del GEX
  try {
    const url = `${tradeBase}/v2/options/contracts?underlying_symbols=${encodeURIComponent(sym)}&limit=100`;
    const r = await fetch(url, { headers: ALPACA_HEADERS, timeout: 12000 });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    const cs = body && Array.isArray(body.option_contracts) ? body.option_contracts : [];
    const withOI = cs.filter(c => c && c.open_interest != null && c.open_interest !== '');
    const ej = withOI[0];
    out.openInterest = {
      status: r.status, base: tradeBase.includes('paper') ? 'paper' : 'live',
      contratos: cs.length, con_oi: withOI.length, tiene_oi: withOI.length > 0,
      ejemplo: ej ? { symbol: ej.symbol, strike: ej.strike_price, open_interest: ej.open_interest, fecha: ej.open_interest_date } : null,
      sample: text.slice(0, 180),
    };
  } catch (e) { out.openInterest = { error: e.message }; }

  out.ms = Date.now() - started;
  const g = out.greeks.tiene_gamma, oi = out.openInterest.tiene_oi;
  out.veredicto = (g && oi) ? '✅ GEX/Max Pain CONSTRUIBLE — gamma + open interest reales disponibles'
    : g  ? '🟡 PARCIAL — hay gamma pero falta open interest (probá ?paper=1 o revisá la cuenta)'
    : oi ? '🟡 PARCIAL — hay open interest pero falta gamma (probá ?feed=opra)'
    :      '❌ sin gamma ni open interest con este feed/plan (probá ?feed=opra y/o ?paper=1)';
  out.ok = !!(g && oi);
  res.json(out);
});

// ── HEALTH CHECK ─────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), service: 'LiquidMap PRO v2' });
});

// ══════════════════════════════════════════════════════════════════
// LIQUIDACIONES REALES — Binance Futures forceOrder (websocket, gratis)
// ──────────────────────────────────────────────────────────────────
// El navegador (US) tiene Binance futuros geobloqueado → el WS lo sostiene
// ESTE proxy (Render Frankfurt), agrega en ventana rodante y lo expone por REST.
// El stream manda solo la liquidación más grande por símbolo cada 1000ms (snapshot,
// no cada evento) → es flujo REAL pero muestreado. Mejor que cualquier estimación.
// forceOrder side: SELL = un LONG fue liquidado · BUY = un SHORT fue liquidado.
// ══════════════════════════════════════════════════════════════════
const LIQ_WINDOW_SEC = 3600;                 // 1h de memoria rodante
const LIQ_MAX_EVENTS = 6000;                 // tope duro por símbolo (anti-leak)
// Endpoints candidatos. Post 23-abr-2026 las URLs legacy quedaron desmanteladas y las
// conexiones sin ruta solo reciben /public → forceOrder (market) no empuja. Probamos
// rutas hasta que una entregue. Si se setea LIQ_WS_URL por env, se usa solo esa.
const LIQ_WS_CANDIDATES = process.env.LIQ_WS_URL
  ? [process.env.LIQ_WS_URL]
  : [
      'wss://fstream.binance.com/market/stream?streams=!forceOrder@arr',
      'wss://fstream.binance.com/public/stream?streams=!forceOrder@arr',
      'wss://fstream.binance.com/stream?streams=!forceOrder@arr',
    ];
const LIQ_WS_OFF = /^(1|true|yes|on)$/i.test(process.env.LIQ_WS_OFF || '');

const liqWindow = new Map();                 // symbol -> [{t, side:'long'|'short', usd}]
let liqWsConnected = false;
let liqLastEventTs = 0;
let liqWsBackoff = 3000;
let liqCandIdx = 0;                           // candidato actual
let liqEventsSinceOpen = 0;                   // eventos recibidos en la conexión actual
let liqProbeTimer = null;                     // watchdog "sin datos → rotar"
function liqCurrentUrl(){ return LIQ_WS_CANDIDATES[liqCandIdx % LIQ_WS_CANDIDATES.length]; }

function liqPrune(arr){
  const cutoff = Date.now() - LIQ_WINDOW_SEC * 1000;
  let i = 0; while (i < arr.length && arr[i].t < cutoff) i++;
  if (i > 0) arr.splice(0, i);
  if (arr.length > LIQ_MAX_EVENTS) arr.splice(0, arr.length - LIQ_MAX_EVENTS);
}

function liqHandleOrder(o){
  if (!o || !o.s) return;
  const sym = o.s;
  const qty = parseFloat(o.q);
  const px  = parseFloat(o.ap || o.p);       // precio promedio si está, sino precio
  if (!isFinite(qty) || !isFinite(px)) return;
  const usd = qty * px;
  const side = o.S === 'SELL' ? 'long' : 'short';   // SELL liquida un LONG
  const t = parseInt(o.T) || Date.now();
  if (!liqWindow.has(sym)) liqWindow.set(sym, []);
  const arr = liqWindow.get(sym);
  arr.push({ t, side, usd });
  liqPrune(arr);
  liqLastEventTs = Date.now();
}

function connectLiqWS(){
  if (LIQ_WS_OFF) { console.log('⚙️  LIQ_WS_OFF=1 — liquidaciones WS apagado.'); return; }
  if (typeof WebSocket === 'undefined'){
    console.error('❌ Liquidaciones: WebSocket global no disponible (Node <21). Endpoint dará ok:false honesto.');
    return;
  }
  const url = liqCurrentUrl();
  let ws;
  try { ws = new WebSocket(url); }
  catch (e){ console.error('❌ Liq WS no abrió:', e.message); liqCandIdx++; scheduleLiqReconnect(); return; }

  liqEventsSinceOpen = 0;
  ws.addEventListener('open', () => {
    liqWsConnected = true; liqWsBackoff = 3000;
    console.log('✅ Liquidaciones WS conectado →', url);
    // Watchdog: si conecta pero en 90s no llega NINGÚN forceOrder, el endpoint no es el
    // que empuja liquidaciones → rotar al siguiente candidato. (Solo si hay >1 candidato.)
    if (LIQ_WS_CANDIDATES.length > 1){
      clearTimeout(liqProbeTimer);
      liqProbeTimer = setTimeout(() => {
        if (liqEventsSinceOpen === 0){
          console.warn('⚠️  Liq WS sin eventos en 90s →', url, '— rotando endpoint');
          liqCandIdx++;
          try { ws.close(); } catch(e){}   // close dispara reconnect con el siguiente
        }
      }, 90000);
    }
  });
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      // Combined stream: {stream, data:{e:'forceOrder', o:{...}}}  ·  raw: {e:'forceOrder', o:{...}}
      const payload = msg.data || msg;
      if (payload && payload.e === 'forceOrder' && payload.o){ liqEventsSinceOpen++; liqHandleOrder(payload.o); }
    } catch (e) { /* ignora frames no-JSON */ }
  });
  ws.addEventListener('close', () => { liqWsConnected = false; clearTimeout(liqProbeTimer); console.warn('⚠️  Liq WS cerrado — reconectando…'); scheduleLiqReconnect(); });
  ws.addEventListener('error', (e) => { liqWsConnected = false; console.warn('⚠️  Liq WS error:', e && e.message ? e.message : 'unknown'); });
}
function scheduleLiqReconnect(){
  setTimeout(connectLiqWS, liqWsBackoff);
  liqWsBackoff = Math.min(liqWsBackoff * 1.6, 60000);   // backoff hasta 60s
}

// ── ENDPOINT: liquidaciones agregadas por símbolo ─────────────────
app.get('/liquidations', (req, res) => {
  const sym = (req.query.symbol || '').toUpperCase();
  let win = parseInt(req.query.window) || LIQ_WINDOW_SEC;
  win = Math.max(60, Math.min(win, LIQ_WINDOW_SEC));
  if (!sym) return res.status(400).json({ ok:false, error:'missing symbol' });
  const arr = liqWindow.get(sym) || [];
  const cutoff = Date.now() - win * 1000;
  let longUSD = 0, shortUSD = 0, count = 0, lastTs = 0;
  for (const e of arr){
    if (e.t < cutoff) continue;
    if (e.side === 'long') longUSD += e.usd; else shortUSD += e.usd;
    count++; if (e.t > lastTs) lastTs = e.t;
  }
  const totalUSD = longUSD + shortUSD;
  res.json({
    ok: true,
    symbol: sym,
    windowSec: win,
    longUSD, shortUSD, totalUSD,
    ratio: shortUSD > 0 ? +(longUSD / shortUSD).toFixed(2) : null,
    count,
    lastEventTs: lastTs || null,
    wsConnected: liqWsConnected,
    wsUrl: liqCurrentUrl(),
    feedLastEventTs: liqLastEventTs || null,   // último evento de CUALQUIER símbolo (salud del feed)
    serverTime: Date.now()
  });
});

// ── PROXY DERIBIT (opciones reales — para GEX/MaxPain de BTC y ETH) ──
// Deribit JSON-RPC REST público (sin auth para market data). El mapa pide
// /deribit?path=/api/v2/public/get_book_summary_by_currency&currency=BTC&kind=option
app.get('/deribit', async (req, res) => {
  try {
    const apiPath = req.query.path;
    if (!apiPath || !apiPath.startsWith('/api/v2/public/'))
      return res.status(400).json({ error: 'path inválido (solo /api/v2/public/)' });
    const params = Object.entries(req.query)
      .filter(([k]) => k !== 'path')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const url = params ? `https://www.deribit.com${apiPath}?${params}` : `https://www.deribit.com${apiPath}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 12000 });
    const text = await r.text();
    if (!r.ok) return res.status(502).json({ error:'deribit_unavailable', upstream_status:r.status, sample:text.slice(0,160) });
    let data; try { data = JSON.parse(text); } catch(e){ return res.status(502).json({ error:'invalid_json', sample:text.slice(0,160) }); }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LiquidMap PRO running on port ${PORT}`);
  connectLiqWS();   // arranca el feed de liquidaciones (independiente de los bots)
});

// ── MONITORES (bots) ──────────────────────────────
// Los bots (crypto + bolsa) comparten ESTE proceso con los mapas y el proxy.
// En instancia free de 1 solo proceso, con NY abierto compiten por el event loop y
// las conexiones salientes → los pedidos a Polygon del mapa se cortan ("Premature close").
// Interruptor: poné MAPS_ONLY=1 en Render → Environment para correr SOLO mapas/proxy
// (bots apagados) y darle aire al mapa. Es el paso para confirmar la causa y el puente
// hasta separar los bots a su propio servicio.
const MAPS_ONLY = /^(1|true|yes|on)$/i.test(process.env.MAPS_ONLY || '');
if (MAPS_ONLY) {
  console.log('⚙️  MAPS_ONLY=1 — bots APAGADOS en este servicio (solo mapas + proxy).');
} else {
  // ── MONITOR CRYPTO 24/7 ───────────────────────────
  try {
    require('./monitor_v4');
    console.log('✅ Monitor CRYPTO arrancado — @liquidmappro_bot');
  } catch (e) {
    console.error('❌ Monitor crypto no pudo arrancar:', e.message);
  }

  // ── MONITOR BOLSA (solo sesión NY) ────────────────
  try {
    require('./monitor_bolsa_v1');
    console.log('✅ Monitor BOLSA arrancado — @liquidmapbolsa_bot');
  } catch (e) {
    console.error('❌ Monitor bolsa no pudo arrancar:', e.message);
  }
}
