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

// ── PROXY BINANCE + FINNHUB (endurecido: ya no crashea con HTML/451) ──
app.get('/proxy', async (req, res) => {
  try {
    const apiPath = req.query.path;
    const futures = req.query.futures === '1';
    if (!apiPath) return res.status(400).json({ error: 'Missing path param' });
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

    // Guard: si el upstream no responde OK o no es JSON (ej. página 451/403 en HTML),
    // devolvemos un error LIMPIO en vez de crashear con un 500 genérico.
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

// ── DIAGNÓSTICO DE RED ────────────────────────────
// Abrí /diag en el navegador. Dice qué exchanges puede ALCANZAR este servidor.
// El que devuelva "ok":true y un sample con JSON real → ese es el que sirve.
// 451/403 = geobloqueo desde la región de Render.
app.get('/diag', async (req, res) => {
  const targets = [
    { name: 'binance_spot', url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT' },
    { name: 'binance_fut',  url: 'https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT' },
    { name: 'bybit',        url: 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT' },
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
