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
app.get('/polygon', async (req, res) => {
  try {
    if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY no configurada en el servidor (Render → Environment)' });
    const apiPath = req.query.path;
    if (!apiPath || !apiPath.startsWith('/v2/aggs/')) return res.status(400).json({ error: 'path inválido (solo /v2/aggs/)' });
    const params = Object.entries(req.query)
      .filter(([k]) => k !== 'path')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `https://api.polygon.io${apiPath}?${params ? params + '&' : ''}apiKey=${POLYGON_KEY}`;
    const r    = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 10000 });
    const text = await r.text();
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

// ── HEALTH CHECK ─────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), service: 'LiquidMap PRO v2' });
});

// ── START ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LiquidMap PRO running on port ${PORT}`));

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
