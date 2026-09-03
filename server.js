const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const optLive    = require('./options_live');    // capa I/O reusable (server + bot): GEX (BS) + Max Pain reales
const cvdLive    = require('./cvd_live');         // FASE 3: CVD por agresor real (Lee-Ready sobre trades+quotes SIP)
let printsLive;                                   // DARK POOL paso 1: prints grandes (>$1M) reusando la tubería de trades SIP
try { printsLive = require('./prints_live'); }    // defensivo (mismo patrón que health_state): si falta el archivo, NO tumba el server
catch (e) { console.error('⚠️  prints_live.js no cargado — /alpaca-prints degradado:', e.message); printsLive = null; }
const app     = express();

// ── LATIDO DE MONITORES (health_state) — defensivo: si falta el archivo, NO tumba el server ──
let health;
try {
  health = require('./health_state');
} catch (e) {
  console.error('⚠️  health_state.js no cargado — /status degradado:', e.message);
  health = { beat(){}, signal(){}, error(){}, snapshot(){ return { error: 'health_state.js no está en el repo todavía', components: {} }; } };
}

// ── CORS ─────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ════════════════════════════════════════════════════════════════════
//  SEGURIDAD (s78) — sesión por cookie server-side. La contraseña vive en
//  el env LM_PASSWORD (NO en el HTML). Un extraño que pegue la URL recibe
//  /login, no el mapa; las rutas de datos exigen sesión válida.
// ════════════════════════════════════════════════════════════════════
const AUTH = require('./auth');
const LM_PASSWORD = process.env.LM_PASSWORD || 'trader2026';   // ⚠ CAMBIAR en Render. Default = clave vieja para no quedar afuera.
const AUTH_TOKEN  = AUTH.makeToken(LM_PASSWORD);
function requirePage(req, res, next) { if (AUTH.isAuthed(req.headers.cookie, AUTH_TOKEN)) return next(); return res.redirect('/login'); }
function requireApi(req, res, next)  { if (AUTH.isAuthed(req.headers.cookie, AUTH_TOKEN)) return next(); return res.status(401).json({ ok: false, error: 'sesión requerida' }); }

// guard de las rutas de DATOS por prefijo (health/status/login/favicon quedan abiertas)
// Se suman a la lista original: /asistente (gasta la API key de Anthropic = costo real, era
// PÚBLICA), /darkpool-log (quema cuota Alpaca), /obs-log · /dp-sample · /dp-bands (escriben/
// leen los gists del ledger). El mapa las llama mismo-origen con la cookie → sigue andando;
// un extraño sin sesión ahora recibe 401.
const API_PROTECT = ['/proxy', '/alpaca', '/diag', '/liquidations', '/deribit',
                     '/asistente', '/darkpool-log', '/obs-log', '/dp-sample', '/dp-bands', '/ledger-log'];
app.use((req, res, next) => {
  if (API_PROTECT.some(p => req.path === p || req.path.startsWith(p))) return requireApi(req, res, next);
  next();
});

// ── LOGIN (público) ──
const LOGIN_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LiquidMap · acceso</title>
<style>*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#02040c;font-family:'Space Mono',ui-monospace,monospace;color:#e8eefc}
.box{width:320px;max-width:90vw;text-align:center;padding:32px;border:1px solid #16233f;border-radius:12px;background:#060a16}
.logo{font-size:22px;font-weight:700;letter-spacing:3px;color:#00ff9d}.sub{font-size:11px;color:#5a6a86;margin:6px 0 22px}
input{width:100%;background:#0a1020;border:1px solid #16233f;border-radius:6px;padding:12px 16px;color:#e8eefc;font-family:inherit;font-size:14px;text-align:center;letter-spacing:4px;outline:none;margin-bottom:12px}
input:focus{border-color:#00ff9d}button{width:100%;background:#00ff9d;border:0;border-radius:6px;padding:12px;color:#02040c;font-family:inherit;font-weight:700;letter-spacing:2px;cursor:pointer}
.err{color:#ff2d6b;font-size:12px;min-height:16px;margin-top:10px}</style></head>
<body><div class="box"><div class="logo">LIQUIDMAP</div><div class="sub">PRO v7 · acceso institucional</div>
<input id="p" type="password" placeholder="clave" autocomplete="off" autofocus>
<button id="b">ACCEDER</button><div class="err" id="e"></div></div>
<script>
const p=document.getElementById('p'),b=document.getElementById('b'),e=document.getElementById('e');
async function go(){b.disabled=true;e.textContent='';try{const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pass:p.value})});const j=await r.json();if(j.ok){location.href='/bolsa';}else{e.textContent='clave incorrecta';p.value='';b.disabled=false;}}catch(_){e.textContent='error de red';b.disabled=false;}}
b.onclick=go;p.addEventListener('keydown',ev=>{if(ev.key==='Enter')go();});
</script></body></html>`;
app.get('/login', (req, res) => {
  if (AUTH.isAuthed(req.headers.cookie, AUTH_TOKEN)) return res.redirect('/bolsa');
  res.set('Content-Type', 'text/html; charset=utf-8').send(LOGIN_HTML);
});
app.post('/login', (req, res) => {
  const pass = (req.body && req.body.pass) || '';
  if (AUTH.checkPassword(pass, LM_PASSWORD)) {
    res.setHeader('Set-Cookie', AUTH.sessionCookie(AUTH_TOKEN));
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'clave incorrecta' });
});
app.get('/logout', (req, res) => { res.setHeader('Set-Cookie', AUTH.clearCookie()); res.redirect('/login'); });

// ── MAPAS HTML ───────────────────────────────────
app.get('/', (req, res) => res.redirect('/bolsa'));
app.get('/bolsa', requirePage, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'LiquidityMap_BOLSA_v5.html'));
});
app.get('/crypto', requirePage, (req, res) => {
  res.sendFile(path.join(__dirname, 'LiquidityMap_CRYPTO_v6_2.html'));
});
app.get('/salud', requirePage, (req, res) => {
  res.sendFile(path.join(__dirname, 'salud.html'));
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

// ── GEX + MAX PAIN REALES (griegas OPRA nativas · Algo Trader Plus) ──
// Junta dato REAL de Alpaca con el motor (vía la capa options_live.js que también usa el bot).
//   · subyacente S → SIP (trades/latest)
//   · open interest → contracts (T+1, igual que todo proveedor de GEX)
//   · gamma e IV → NATIVAS del snapshot OPRA (Black-Scholes queda solo como fallback medido)
// Probá:  /alpaca-options-metrics?sym=SPY            (mensual por defecto)
//         ?mode=nearest (0DTE)  ·  ?exp=2026-07-17 (exp puntual)  ·  ?band=0.12
//         ?live=1 (si las keys son live)  ·  ?fresh=1 (saltea la caché de 10min)
app.get('/alpaca-options-metrics', async (req, res) => {
  const out = await optLive.getOptionsMetrics(req.query.sym, {
    mode: req.query.mode, exp: req.query.exp, band: req.query.band,
    days: req.query.days, r: req.query.r, live: req.query.live,
    ttl: req.query.fresh ? 0 : undefined,
  });
  res.json(out);
});

// ── SELECTOR DE CONTRATO (Fase 3 · griegas OPRA nativas) ──────────
// Traduce "quiero ir largo/corto en X" al CONTRATO concreto. NO decide si operar
// (eso es del score/Governor) — sólo qué comprar para la dirección pedida.
// Filtros duros de liquidez (quote vivo · OI · spread) + puntaje: el delta manda,
// el spread desempata. Devuelve el elegido, alternativas y POR QUÉ se descartó el resto.
// Probá:  /alpaca-contrato?sym=SPY&side=call                (horizonte swing por defecto)
//         ?horizon=scalp | swing | position
//         ?targetDelta=0.35 ?dteMin=5 ?dteMax=14 ?maxSpreadPct=6 ?minOI=200  (ajustes finos)
//         ?band=0.15 ?top=5 ?live=1 ?fresh=1 (saltea la caché de 3min)
app.get('/alpaca-contrato', async (req, res) => {
  const out = await optLive.getContractPick(req.query.sym, {
    side: req.query.side, horizon: req.query.horizon,
    targetDelta: req.query.targetDelta, dteMin: req.query.dteMin, dteMax: req.query.dteMax,
    maxSpreadPct: req.query.maxSpreadPct, minOI: req.query.minOI,
    band: req.query.band, r: req.query.r, top: req.query.top, live: req.query.live,
    ttl: req.query.fresh ? 0 : undefined,
  });
  res.json(out);
});

// ── /alpaca-audit (s77): audita una señal/contrato contra la REALIDAD ──
// Trae de Alpaca las barras del subyacente + las barras de PRIMA de la opción
// en la ventana [entry, end] y llama al cerebro (options_audit). Las griegas de
// entrada = snapshot del /contrato. Params: ?contract= &sym= &side= &entry= &end=
// &horizon= &tf= &spot0= &mid= &delta= &gamma= &theta= &be= &tp1= &tp2= &tp3= &sl= &earnings=
app.get('/alpaca-audit', async (req, res) => {
  try { res.json(await optLive.auditContract(req.query)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── /alpaca-cvd (FASE 3): CVD REAL por AGRESOR (Lee-Ready) de una ventana ──
// Trae trades+quotes SIP de [start,end], clasifica cada trade por agresor y
// devuelve el NETO agregado {buyV,sellV,cvd,cvdReal,partial}. El mapa lo usa
// para reemplazar el CVD ESTIMADO (direccion de vela) del panel y del score.
// Params: ?sym= &start=RFC3339 &end=RFC3339 [&rth=0 para incluir extended hours]
app.get('/alpaca-cvd', async (req, res) => {
  try {
    if (!ALPACA_KEY_ID || !ALPACA_SECRET) {
      return res.status(500).json({ status: 'ERROR', error: 'ALPACA keys no configuradas' });
    }
    const sym = String(req.query.sym || '').toUpperCase();
    const start = req.query.start, end = req.query.end;
    if (!sym || !start || !end) {
      return res.status(400).json({ status: 'ERROR', error: 'faltan params (sym, start, end)' });
    }
    const rth = String(req.query.rth) !== '0';
    const r = await cvdLive.fetchAggressorCVD(sym, start, end, { rth });
    return res.json({ status: 'OK', ticker: sym, ...r });
  } catch (e) {
    res.status(500).json({ status: 'ERROR', error: e.message });
  }
});

// ── /alpaca-prints (DARK POOL paso 1): PRINTS grandes (>$1M) de una ventana ──
// Reusa la MISMA tubería de trades SIP que /alpaca-cvd (fetchPaged de cvd_live) para
// filtrar los trades cuyo notional (precio×size) supera un umbral (default $1M) —
// huella de bloques/flujo institucional. AISLADA: no toca el CVD real.
// Params: ?sym= &start=RFC3339 &end=RFC3339 [&rth=0] [&min=1000000] [&top=20]
app.get('/alpaca-prints', async (req, res) => {
  try {
    if (!printsLive) {
      return res.status(503).json({ status: 'ERROR', error: 'prints_live.js no está en el repo todavía' });
    }
    if (!ALPACA_KEY_ID || !ALPACA_SECRET) {
      return res.status(500).json({ status: 'ERROR', error: 'ALPACA keys no configuradas' });
    }
    const sym = String(req.query.sym || '').toUpperCase();
    const start = req.query.start, end = req.query.end;
    if (!sym || !start || !end) {
      return res.status(400).json({ status: 'ERROR', error: 'faltan params (sym, start, end)' });
    }
    const rth = String(req.query.rth) !== '0';
    const minNotional = Number(req.query.min) > 0 ? Number(req.query.min) : 1e6;
    const topN = Number(req.query.top) > 0 ? Number(req.query.top) : 20;
    const r = await printsLive.fetchLargePrints(sym, start, end, { rth, minNotional, topN });
    return res.json({ status: 'OK', ticker: sym, ...r });
  } catch (e) {
    res.status(500).json({ status: 'ERROR', error: e.message });
  }
});

// ── /darkpool-log : el LOGGER de dark pool como LINK (sin terminal) ──────────
// Muestrea % off-exchange REAL por ticker × días hábiles × slots (open/mid/close)
// reusando fetchLargePrints y computando el % IGUAL que el mapa (updatePrints).
// Devuelve un CSV descargable en STREAMING (para no cortar por timeout) con la
// data cruda + un resumen por ticker (mediana/p80/p95/max). AISLADO: solo LEE
// prints, no toca emisor/ledger/backtest. Ventana histórica → sin mercado abierto.
// Uso:  /darkpool-log
//       /darkpool-log?tickers=SPY,QQQ,NVDA&days=8&min=1000000
app.get('/darkpool-log', async (req, res) => {
  if (!printsLive) return res.status(503).send('prints_live.js no está en el repo todavía');
  if (!ALPACA_KEY_ID || !ALPACA_SECRET) return res.status(500).send('ALPACA keys no configuradas');
  const DEF = 'SPY,QQQ,NVDA,AMD,AAPL,MSFT,META,AMZN,TSLA,AVGO';
  const tickers = String(req.query.tickers || DEF).toUpperCase().split(',').map(s=>s.trim()).filter(Boolean).slice(0,40);
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 6));
  const minNotional = Number(req.query.min) > 0 ? Number(req.query.min) : 1e6;
  // Ventanas: default = 3 slots de 2h (open/mid/close). Con ?win=45 → ventanas cortas
  // que barren toda la RTH → para tickers PESADOS (NVDA/AAPL/TSLA...) donde 2h satura
  // el tope de prints y trunca (partial). Menos prints por ventana = data limpia.
  const winMin = Number(req.query.win) || 0;
  let SLOTS;
  if (winMin >= 15 && winMin <= 120) {
    SLOTS = []; const pad=n=>String(n).padStart(2,'0');
    for (let t = 13*60+30; t + winMin <= 20*60; t += winMin) {
      const a=pad(Math.floor(t/60))+':'+pad(t%60), b=pad(Math.floor((t+winMin)/60))+':'+pad((t+winMin)%60);
      SLOTS.push({ label:a.replace(':',''), s:a, e:b });
    }
  } else {
    SLOTS = [
      { label:'open',  s:'13:30', e:'15:30' },
      { label:'mid',   s:'16:00', e:'18:00' },
      { label:'close', s:'18:00', e:'20:00' },
    ];
  }
  const lastWeekdays = (n) => { const out=[]; const d=new Date(); while(out.length<n){ d.setUTCDate(d.getUTCDate()-1); const wd=d.getUTCDay(); if(wd!==0&&wd!==6) out.push(d.toISOString().slice(0,10)); } return out.reverse(); };
  const computeDP = (j) => {
    const auc=(j.auctionCount||0), aucN=(j.auctionNotional||0);
    const nCont=Math.max(0,(j.count||0)-auc), contNotional=Math.max(0,(j.totalNotional||0)-aucN);
    const offN=(j.offExchangeNotional||0), offC=(j.offExchangeCount||0);
    const pct=contNotional>0?Math.round(offN/contNotional*100):0;
    const top=Array.isArray(j.top)?j.top:[]; const big=top.find(p=>p&&!p.auction);
    return { nCont, contNotional, offN, offC, pct, biggestN:(big?big.notional:0), partial:!!j.partial };
  };
  const pctile = (a,p)=>{ if(!a.length) return ''; const b=[...a].sort((x,y)=>x-y); return b[Math.min(b.length-1,Math.floor(p/100*b.length))]; };
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  let aborted=false; req.on('close', ()=>{ aborted=true; });

  const dias = lastWeekdays(days);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="darkpool_${tickers.join('-').slice(0,40)}_${new Date().toISOString().slice(0,10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.write('sym,date,slot,startISO,endISO,offExchPct,offExchNotional,offExchCount,contCount,contNotional,biggestContNotional,partial\n');
  const bySym = {};
  for (const sym of tickers) {
    if (aborted) break;
    bySym[sym] = [];
    for (const day of dias) {
      if (aborted) break;
      for (const slot of SLOTS) {
        if (aborted) break;
        const startISO = `${day}T${slot.s}:00Z`, endISO = `${day}T${slot.e}:00Z`;
        try {
          const r = await printsLive.fetchLargePrints(sym, startISO, endISO, { rth:true, minNotional, topN:20 });
          const d = computeDP(r || {});
          res.write(`${sym},${day},${slot.label},${startISO},${endISO},${d.pct},${Math.round(d.offN)},${d.offC},${d.nCont},${Math.round(d.contNotional)},${Math.round(d.biggestN)},${d.partial?1:0}\n`);
          if (d.nCont > 0) bySym[sym].push(d.pct);
        } catch (e) {
          res.write(`${sym},${day},${slot.label},${startISO},${endISO},ERR,,,,,,\n`);
        }
        await sleep(100);
      }
    }
  }
  res.write('\n# RESUMEN — baseline por ticker. Umbral z-score (fundamentado): amarillo=media+1sigma, verde=media+2sigma\n');
  res.write('# sym,n,media,sigma,mediana,p90,amarillo,verde\n');
  for (const sym of tickers) {
    const a = bySym[sym] || [];
    if (!a.length) { res.write(`# ${sym},0,,,,,,\n`); continue; }
    const m = a.reduce((x,y)=>x+y,0)/a.length;
    const sd = Math.sqrt(a.reduce((x,y)=>x+(y-m)*(y-m),0)/a.length);
    res.write(`# ${sym},${a.length},${m.toFixed(1)},${sd.toFixed(1)},${pctile(a,50)},${pctile(a,90)},${Math.round(m+sd)},${Math.round(m+2*sd)}\n`);
  }
  res.end();
});

// ══════════════════════════════════════════════════════════════════════════
// DARK POOL · AUTO-CALIBRACIÓN — baseline propio por ticker (aprende en vivo)
// El mapa postea a /dp-sample el % que YA obtiene en updatePrints; el server lo
// acumula en el gist (mismo gist del ledger, archivo dp_baseline.json) y sirve
// las bandas por /dp-bands. Cada ticker aprende su p75/p90 sobre ventana rodante
// → colorea relativo a SU baseline, resuelve la watchlist cambiante sola.
// AISLADO: solo lee/escribe su propio blob; NO toca emisor/ledger/backtest/mapa.
// FAIL-OPEN: si faltan módulos o env → dp queda OFF y todo lo demás sigue igual.
//   ENV (reusa las del ledger): LEDGER_GH_TOKEN + LEDGER_GH_GIST
// ══════════════════════════════════════════════════════════════════════════
let dpStore = null;
try {
  const { createDpStore, gistBlobDriver } = require('./dp_store');
  const _tok = process.env.LEDGER_GH_TOKEN || '';
  const _gid = process.env.LEDGER_GH_GIST  || '';
  if (_tok && _gid) {
    dpStore = createDpStore(gistBlobDriver({
      token: _tok, gistId: _gid, filename: 'dp_baseline.json',
      fetch, onError: e => console.log('[dp] gist: ' + e.message)
    }));
  } else {
    console.log('🌑 Dark pool auto-cal OFF — faltan LEDGER_GH_TOKEN/GIST');
  }
} catch (e) { console.log('🌑 Dark pool auto-cal OFF — ' + e.message); }

// SEED = bandas p75/p90 sembradas desde los CSVs (los mid-liquidez calibrados).
// Se usan hasta que el ticker junte muestra propia (n>=25). _def = fallback.
const DP_SEED = {
  SPY:{y:83,g:90}, QQQ:{y:88,g:90}, AMZN:{y:92,g:94}, MSFT:{y:93,g:95},
  AMD:{y:85,g:92}, META:{y:85,g:95}, AVGO:{y:88,g:90}, TSLA:{y:79,g:86},
  PLTR:{y:87,g:93}, MU:{y:87,g:93}, GOOG:{y:91,g:99}, ORCL:{y:87,g:99},
  AAPL:{y:96,g:99}, NVDA:{y:86,g:96}
};
const DP_DEF = { y:88, g:93 };

// POST /dp-sample  { sym, pct, ts? } → { ok, accepted, reason }
// Lo llama el mapa con el % que ya computó. Spacing anti-sesgo + validación viven
// en el módulo puro; persiste al gist SOLO si la muestra fue aceptada.
app.post('/dp-sample', async (req, res) => {
  try {
    if (!dpStore) return res.json({ ok:false, off:true });
    const b = req.body || {};
    const sym = String(b.sym || '').toUpperCase();
    const pct = Number(b.pct);
    const ts  = Number(b.ts) > 0 ? Number(b.ts) : Date.now();
    const r = dpStore.sample(sym, ts, pct);   // aplica en RAM; el job de commit escribe al gist en tanda (cada 5min)
    return res.json({ ok:true, ...r });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

// GET /dp-bands → { ok, def, bands:{ SYM:{y,g,source,n} | {degenerate,source} } }
// El mapa lo consume para colorear fl-dpool relativo al baseline propio del sym.
// Un sym ausente en bands → el mapa cae a def. source = learned|seed|def.
app.get('/dp-bands', (req, res) => {
  try {
    if (!dpStore) return res.json({ ok:false, off:true, def:DP_DEF, seed:DP_SEED });
    return res.json({ ok:true, def:DP_DEF, bands: dpStore.allBands(DP_SEED, DP_DEF) });
  } catch (e) { res.json({ ok:false, error:e.message, def:DP_DEF }); }
});

// ══════════════════════════════════════════════════════════════════════════
// LEDGER INTELIGENTE · OBSERVACIONES — mide el poder predictivo de las LECTURAS
// (juez, dark pool, ballena, sticker) por FORWARD-RETURN direccional. El mapa y el
// asistente POSTean a /obs-log; un job trae barras forward y sella el desenlace.
// Store = mismo gist del ledger, archivo aparte obs_ledger.jsonl (JSONL de records).
// AISLADO del ledger de trades y del emisor. FAIL-OPEN: si faltan módulos/env → OFF.
//   ENV (reusa las del ledger): LEDGER_GH_TOKEN + LEDGER_GH_GIST
// ══════════════════════════════════════════════════════════════════════════
let obsStore = null, obsDriver = null, _obsMake = null, _obsResolve = null, _obsGetBars = null;
try {
  const { createLedgerStore } = require('./ledger_store');
  const { githubGistDriver }  = require('./ledger_store_github');
  const { makeObservation }   = require('./obs_ledger');
  const { resolveObsPending } = require('./obs_resolver');
  const _tok = process.env.LEDGER_GH_TOKEN || '';
  const _gid = process.env.LEDGER_GH_GIST  || '';
  if (_tok && _gid) {
    obsDriver = githubGistDriver({ token:_tok, gistId:_gid, filename:'obs_ledger.jsonl', fetch, onError:e=>console.log('[obs] gist: '+e.message) });
    obsStore  = createLedgerStore(obsDriver);
    _obsMake  = makeObservation;
    _obsResolve = resolveObsPending;
    _obsGetBars = (sym, s, e, tf) => optLive.getUnderlyingBars(sym, s, e, tf);
  } else {
    console.log('🧠 Ledger inteligente OFF — faltan LEDGER_GH_TOKEN/GIST');
  }
} catch (e) { console.log('🧠 Ledger inteligente OFF — ' + e.message); }

// POST /obs-log  { kind, sym, dir, ts?, px?, tf?, horizonBars?, strength?, tag?, ctx? } → { ok, id }
// Lo llaman las fuentes (mapa/asistente) cuando disparan una lectura significativa.
// La validación vive en makeObservation; upsert es idempotente por id.
app.post('/obs-log', async (req, res) => {
  try {
    if (!obsStore || !_obsMake) return res.json({ ok:false, off:true });
    const b = req.body || {};
    const rec = _obsMake({
      kind: b.kind, sym: String(b.sym || '').toUpperCase(),
      ts: Number(b.ts) > 0 ? Number(b.ts) : Date.now(),
      dir: b.dir, px: Number(b.px), tf: b.tf,
      horizonBars: Number(b.horizonBars), strength: Number(b.strength),
      tag: b.tag, ctx: b.ctx
    });
    if (!rec) return res.json({ ok:false, reason:'invalid' });
    obsStore.upsert(rec);
    try { await obsDriver.flush(); } catch(_){}
    return res.json({ ok:true, id: rec.id });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// LEDGER · LECTURA (pestaña 📒 del mapa) — Etapa 3. READ-ONLY del ledger de trades.
// Sirve el estado agregado de ledger_bolsa.jsonl (mismo gist) para el panel del mapa:
// scorecard global + juez por clase + cortes (setup/semáforo/horizonte) + BLOQUES POR
// TICKER. Reusa las MISMAS agregaciones que el /resumen (ledger_view → ledger_core +
// ledger_class_judge) → los números coinciden con el resumen semanal, no divergen.
// Solo LEE (init/loadAll), NUNCA escribe → aislado del emisor/resolver/gist de escritura.
// Cache corto (25s) para no golpear el gist si se reabre el panel. Display-only.
// FAIL-OPEN: sin módulos/env → { ok:false, off:true } y el panel muestra "apagado".
//   ENV (reusa las del ledger): LEDGER_GH_TOKEN + LEDGER_GH_GIST
// ══════════════════════════════════════════════════════════════════════════
let ledgerReadDriver = null, buildLedgerView = null;
let _ledgerViewCache = null, _ledgerViewAt = 0;
const LEDGER_VIEW_TTL = 25 * 1000;   // relee el gist como máximo cada 25s (panel manual → sobra)
try {
  const { githubGistDriver } = require('./ledger_store_github');
  ({ buildLedgerView } = require('./ledger_view'));
  const _tok = process.env.LEDGER_GH_TOKEN || '';
  const _gid = process.env.LEDGER_GH_GIST  || '';
  if (_tok && _gid && buildLedgerView) {
    ledgerReadDriver = githubGistDriver({ token:_tok, gistId:_gid, filename:'ledger_bolsa.jsonl', fetch, onError:e=>console.log('[ledger-read] gist: '+e.message) });
  } else {
    console.log('📒 Ledger-lectura OFF — faltan LEDGER_GH_TOKEN/GIST o ledger_view');
  }
} catch (e) { console.log('📒 Ledger-lectura OFF — ' + e.message); }

// GET /ledger-log → payload agregado para la pestaña 📒 (JSON). Read-only, cacheado 25s.
// ?fresh=1 fuerza relectura del gist. Protegido por sesión (API_PROTECT).
app.get('/ledger-log', async (req, res) => {
  try {
    if (!ledgerReadDriver || !buildLedgerView) return res.json({ ok:false, off:true });
    const now = Date.now();
    if (req.query.fresh === '1' || !_ledgerViewCache || (now - _ledgerViewAt) > LEDGER_VIEW_TTL) {
      await ledgerReadDriver.init();                 // ceba/refresca el cache desde el gist (SOLO lectura)
      _ledgerViewCache = buildLedgerView(ledgerReadDriver.loadAll());
      _ledgerViewAt = now;
    }
    res.set('Cache-Control', 'no-store');
    return res.json(_ledgerViewCache);
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// TELEGRAM PROXY · /tg/notify — el mapa (cliente) manda alertas SIN ver el token.
// El token del bot @liquidmapbolsa_bot vive SOLO acá (env TELEGRAM_TOKEN_BOLSA),
// nunca baja al navegador (antes estaba hardcodeado en el HTML = filtrado). El mapa
// postea { text } y el server hace el fan-out a los chat ids. Autenticado (requireApi):
// solo una sesión válida del mapa puede postear. FAIL-OPEN: sin token → ok:false HTTP 200.
//   ENV: TELEGRAM_TOKEN_BOLSA (obligatoria para enviar)
//        TG_CHAT_IDS (opcional, coma-separado; default = ids actuales)
// ══════════════════════════════════════════════════════════════════════════
const TG_TOKEN_BOLSA = process.env.TELEGRAM_TOKEN_BOLSA || '';
const TG_CHAT_IDS = (process.env.TG_CHAT_IDS || '1218461753,1373309702')
  .split(',').map(s => s.trim()).filter(Boolean);
if (!TG_TOKEN_BOLSA) console.warn('[tg-proxy] ⚠ TELEGRAM_TOKEN_BOLSA ausente → /tg/notify fail-open (no envía) hasta setearlo en Render');

app.post('/tg/notify', requireApi, async (req, res) => {
  try {
    const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
    if (!text.trim()) return res.json({ ok:false, reason:'sin texto' });
    if (!TG_TOKEN_BOLSA) return res.json({ ok:false, off:true });   // sin token → no-op
    await Promise.all(TG_CHAT_IDS.map(id =>
      fetch(`https://api.telegram.org/bot${TG_TOKEN_BOLSA}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true })
      })
    ));
    return res.json({ ok:true });
  } catch (e) { return res.json({ ok:false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ASISTENTE-JUEZ · /asistente — Claude viviendo en el mapa (JUEZ/INTÉRPRETE)
// Recibe el ESTADO del mapa (lo arma el cliente), inyecta la CONSTITUCIÓN v0.3
// + la ANTHROPIC_API_KEY (env, nunca al cliente, nunca logueada), llama a la
// Anthropic Messages API y devuelve el veredicto. FAIL-OPEN: si falta la key o
// la API tarda/falla → ok:false + HTTP 200, el mapa sigue igual. Aditivo: NO
// toca emisor, ledger ni backtest.
//   ENV: ANTHROPIC_API_KEY=sk-ant-...  (obligatoria)
//        ASISTENTE_MODEL=claude-sonnet-5  (opcional; opus-4-8 para revisiones)
// ══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
let CONSTITUCION_JUEZ = '';
try {
  CONSTITUCION_JUEZ = fs.readFileSync(path.join(__dirname, 'CONSTITUCION_ASISTENTE_v0.3.md'), 'utf8');
} catch(_e) {
  CONSTITUCION_JUEZ = 'Sos el JUEZ e INTÉRPRETE de LiquidMap PRO. Leés el estado que el mapa ya computó y das un veredicto claro. NO sos caja negra ni gatillo (no es consejo de inversión; el gatillo lo aprieta Gonzalo). Pesás 3 EJES: estructura (SuperTrend + semáforo + CHoCH/BOS), flujo (¿el CVD confirma o diverge?), contexto/HTF (el capó del Governor: discount/premium, MTF, EMA200). FRENO CALIBRADO: cuando los 3 ejes alinean, decí el tiro CON convicción; "esperá" SOLO cuando la evidencia está partida de verdad. Cerrás con "qué lo cambiaría". Hablás en rioplatense, claro. (Fallback — falta CONSTITUCION_ASISTENTE_v0.3.md en el repo)';
}
const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY;
if (!HAS_ANTHROPIC_KEY) console.warn('[asistente] ANTHROPIC_API_KEY ausente → /asistente responde fail-open hasta que la setees en Render.');
const ASISTENTE_MODEL = process.env.ASISTENTE_MODEL || 'claude-sonnet-5';
const TAREA_JUEZ = 'Te paso el ESTADO del mapa en JSON (organizado por los 3 ejes) y, si hay, la pregunta de Gonzalo. Dá el veredicto leyendo SOLO ese estado — grounded, sin inventar números que no estén. Formato: (1) una línea de veredicto (andá / esperá / no — y el grado), (2) 2-4 frases con el porqué apoyado en los 3 ejes y el capó del Governor, (3) "qué lo cambiaría". Si el estado dice sinDatos o el titular es NEUTRAL por conflicto, sé honesto: "esperá, y por qué". Si preguntan por el mejor tiro, cruzá seleccionRadar con el ticker actual.';

app.post('/asistente', async (req, res) => {
  try {
    const body = req.body || {};
    const state = body.state;
    const question = (typeof body.question === 'string') ? body.question.slice(0, 500) : null;
    if (!state || typeof state !== 'object') return res.json({ ok:false, error:'Falta el estado del mapa.' });
    if (!HAS_ANTHROPIC_KEY) return res.json({ ok:false, error:'El juez no está configurado (falta la API key en el server).' });

    // HOOK memoria del juez (próximo paso, read-only del ledger): state.memoriaJuez = ...

    const userContent = TAREA_JUEZ + '\n\n'
      + (question ? ('PREGUNTA DE GONZALO: ' + question + '\n\n') : '')
      + 'ESTADO DEL MAPA:\n' + JSON.stringify(state, null, 0);

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 25000);
    let apiResp;
    try {
      apiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ASISTENTE_MODEL,
          max_tokens: 2500,   // 700→1500→2500: red de seguridad. El freno REAL del largo es la constitución (veredicto breve, ~140 palabras). Si aún se corta con esto, revisar si el modelo mete thinking.
          system: CONSTITUCION_JUEZ,
          messages: [{ role: 'user', content: userContent }],
        }),
      });
    } finally { clearTimeout(to); }

    if (!apiResp.ok) {
      let detail = '';
      try { const ej = await apiResp.json(); detail = (ej && ej.error && ej.error.message) || ''; } catch(_e){}
      return res.json({ ok:false, error:'La API del juez respondió ' + apiResp.status + (detail ? (' — ' + detail) : '') });
    }
    const data = await apiResp.json();
    const verdict = Array.isArray(data.content)
      ? data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() : '';
    const stop = data.stop_reason || '';
    let out = verdict;
    if (!out) {
      // Sin texto: decir POR QUÉ en vez de un críptico "no devolvió texto".
      out = (stop === 'max_tokens')
        ? '(el juez se quedó sin espacio — subí el límite de tokens)'
        : '(el juez no devolvió texto' + (stop ? (' · ' + stop) : '') + ')';
    }
    // LEDGER INTELIGENTE · 4ta fuente JUEZ: registrar el veredicto como observación.
    // dir/conv salen del token que emite el juez en la 1ra línea; se mide su forward-return
    // para medir su poder predictivo y que se autocalibre leyendo su propio track record.
    // ts = momento EXACTO de la consulta (cada veredicto = una decisión propia, NO se ancla a la
    // hora como las otras 3 fuentes). Se loguean TAMBIÉN los neutral ('esperá'): el resolver mide
    // su MFE → cuántas veces frenó y se perdió el movimiento. Aditivo, fail-open.
    try {
      const mJuez = out.match(/⟦\s*JUEZ\s+dir\s*=\s*(up|down|neutral)\s+conv\s*=\s*(\d{1,3})\s*⟧/i);
      if (mJuez) {
        out = out.replace(mJuez[0], '').replace(/^\s+/, '');   // el humano no ve el token
        const _sym = (state.meta && state.meta.sym) ? String(state.meta.sym).toUpperCase() : '';
        const _px  = (state.meta) ? Number(state.meta.price) : NaN;
        if (obsStore && _obsMake && _sym && isFinite(_px) && _px > 0) {
          const _conv = Math.max(0, Math.min(100, parseInt(mJuez[2], 10)));
          const rec = _obsMake({
            kind: 'juez', sym: _sym, ts: Date.now(),
            dir: mJuez[1].toLowerCase(), px: _px, tf: '1H', horizonBars: 6, strength: _conv,
            ctx: {
              grado:   (state.gobernador && state.gobernador.grado) || null,
              clase:   (state.clase && state.clase.clase) || null,
              titular: (state.titular && state.titular.signal) || null,
              score:   (state.titular && state.titular.score) || null
            }
          });
          if (rec) { obsStore.upsert(rec); try { await obsDriver.flush(); } catch(_){} }
        }
      }
    } catch(_e) {}
    return res.json({ ok:true, verdict: out, model: data.model || ASISTENTE_MODEL, stop_reason: stop || null, usage: data.usage || null });
  } catch(e) {
    const msg = (e && e.name === 'AbortError') ? 'El juez tardó demasiado (timeout).' : ((e && e.message) || 'error');
    return res.json({ ok:false, error:'Juez no disponible: ' + msg });
  }
});

// ── HEALTH CHECK ─────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), service: 'LiquidMap PRO v2' });
});

// ── STATUS (tablero de salud: latido de monitores + ping al radar) ──
// El navegador pega solo acá (mismo origen). El ping al radar lo hace el server
// (evita CORS). RADAR_URL override por env si la URL real difiere.
const RADAR_URL = (process.env.RADAR_URL || 'https://liquidmap-proxy-1.onrender.com').replace(/\/+$/, '');
app.get('/status', async (req, res) => {
  const snap = health.snapshot();
  let radar;
  const t0 = Date.now();
  try {
    const r = await fetch(RADAR_URL + '/health', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'LiquidMapStatus' },
      timeout: 8000,
    });
    radar = { ok: r.ok, status: r.status, ms: Date.now() - t0, url: RADAR_URL, checkedAt: new Date().toISOString() };
  } catch (e) {
    radar = { ok: false, error: e.message, ms: Date.now() - t0, url: RADAR_URL, checkedAt: new Date().toISOString() };
  }
  res.json(Object.assign({}, snap, { radar }));
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
  if (dpStore) {
    dpStore.init()
      .then(() => console.log('🌑 Dark pool auto-cal listo (' + Object.keys(dpStore.raw().tickers).length + ' tickers)'))
      .catch(e => console.log('[dp] init: ' + e.message));
    // Commit en tanda cada 5min: escribe al gist SOLO si hubo muestras nuevas → mata la fuga de revisiones.
    setInterval(() => { try { if (dpStore.commit()) dpStore.flush().catch(()=>{}); } catch(_){} }, 5 * 60 * 1000);
  }
  if (obsStore && obsDriver) {
    obsDriver.init()
      .then(() => console.log('🧠 Ledger inteligente listo (' + obsStore.load().length + ' obs)'))
      .catch(e => console.log('[obs] init: ' + e.message));
    if (_obsResolve && _obsGetBars) setInterval(() => {
      _obsResolve(obsStore, _obsGetBars, {})
        .then(r => { if (r && r.resolved) { console.log('🧠 obs: ' + r.resolved + ' resueltas'); return obsDriver.flush(); } })
        .catch(() => {});
    }, 20 * 60 * 1000);
  }
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
