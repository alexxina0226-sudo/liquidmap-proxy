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

// ── PROXY BINANCE + FINNHUB ──────────────────────
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
    const r = await fetch(fullUrl, { headers: { 'Accept': 'application/json' } });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
} catch(e) {
  console.error('❌ Monitor crypto no pudo arrancar:', e.message);
}

// ── MONITOR BOLSA (solo sesión NY) ────────────────
try {
  require('./monitor_bolsa_v1');
  console.log('✅ Monitor BOLSA arrancado — @liquidmapbolsa_bot');
} catch(e) {
  console.error('❌ Monitor bolsa no pudo arrancar:', e.message);
}
