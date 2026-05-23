// ============================================================
//  monitor.js — LiquidMap PRO · Job 24/7
//  Corre dentro de Render · Sin navegador · Alertas automáticas
//  Actualizado: 22 Mayo 2026
// ============================================================

const fetch = require('node-fetch');

// ── CONFIG ───────────────────────────────────────────────────
const TELEGRAM_TOKEN = '8676337394:AAEVIwDY2xGwAmE7hMWcjjAMedjws_vjzSU';
const CHAT_IDS       = ['1218461753', '1373309702']; // Gonzalo, Sucel
const FINNHUB_TOKEN  = 'd0qsf2hr01qgsn5hm2k0d0qsf2hr01qgsn5hm2kg'; // mismo que mapas

const INTERVAL_MS    = 5 * 60 * 1000; // cada 5 min

// ── TICKERS ─────────────────────────────────────────────────
// Para agregar más: solo añade el ticker aquí, nada más
const CRYPTO_TICKERS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT',
  // 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT',  // descomentar para agregar
];

const STOCK_TICKERS = [
  'SPY', 'QQQ', 'AMZN', 'NVDA', 'IWM',
  'TSLA', 'AAPL', 'MSFT', 'GOOG', 'META',
  'WMT', 'DIA', 'AMD',
  // 'NFLX', 'COIN', 'JPM', 'BAC',  // descomentar para agregar
];

// ── ATR % POR TICKER (volatilidad esperada) ──────────────────
const ATR_MAP = {
  BTCUSDT:0.022, ETHUSDT:0.028, SOLUSDT:0.040, XRPUSDT:0.035,
  BNBUSDT:0.025, ADAUSDT:0.040, DOGEUSDT:0.050,
  SPY:0.008,  QQQ:0.010,  IWM:0.010,  DIA:0.008,
  AAPL:0.012, MSFT:0.012, GOOG:0.013, META:0.018,
  AMZN:0.015, NVDA:0.022, TSLA:0.030, AMD:0.025,
  WMT:0.010,
};

// ── ESTADO — evita repetir alertas ──────────────────────────
const lastAlert = {}; // { BTCUSDT: { type:'SH_BULL', ts:Date.now() } }
const COOLDOWN  = 15 * 60 * 1000; // 15 min entre alertas del mismo ticker+tipo

// ── HELPERS ─────────────────────────────────────────────────
function fmt(n) {
  const p = parseFloat(n);
  if (isNaN(p)) return '—';
  if (p >= 10000) return p.toFixed(0);
  if (p >= 1000)  return p.toFixed(1);
  if (p >= 100)   return p.toFixed(2);
  if (p >= 1)     return p.toFixed(3);
  return p.toFixed(5);
}

function getATR(ticker, price) {
  const pct = ATR_MAP[ticker.toUpperCase()] || 0.020;
  return parseFloat(price) * pct;
}

function canAlert(ticker, type) {
  const key = `${ticker}_${type}`;
  const last = lastAlert[key] || 0;
  if (Date.now() - last < COOLDOWN) return false;
  lastAlert[key] = Date.now();
  return true;
}

async function sendTelegram(text) {
  try {
    await Promise.all(CHAT_IDS.map(chat_id =>
      fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      })
    ));
    console.log(`[TG] ${text.substring(0, 80).replace(/\n/g,' ')}`);
  } catch (e) {
    console.error('[TG ERROR]', e.message);
  }
}

// ── DETECCIÓN STOP HUNT ──────────────────────────────────────
// tf en minutos: 1, 5, 15, 60, 240, 1440
function detectStopHunt(candle, ticker, tf) {
  const { o, h, l, c } = candle;
  const body  = Math.abs(c - o);
  const range = h - l;
  if (range === 0 || body === 0) return null;

  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  const isBearSH = upperWick >= body * 2 && upperWick >= range * 0.4;
  const isBullSH = lowerWick >= body * 2 && lowerWick >= range * 0.4;

  if (!isBearSH && !isBullSH) return null;

  // Peso por TF
  const weights = { 1:1, 5:1, 15:2, 60:3, 240:4, 1440:5 };
  const labels  = { 1:'1m ⚡', 5:'5m ⚡', 15:'15m 🔶', 60:'1H 🔴', 240:'4H 🔴', 1440:'1D 🔴' };
  const notes   = { 1:'Aviso leve', 5:'Aviso leve', 15:'Peso medio', 60:'ALTO PESO', 240:'MUY ALTO PESO', 1440:'MÁXIMO PESO' };

  const score = weights[tf] || 1;
  const label = labels[tf]  || `${tf}m`;
  const note  = notes[tf]   || '';

  return { type: isBullSH ? 'SH_BULL' : 'SH_BEAR', score, label, note, price: c };
}

// ── FORMATO MENSAJES TELEGRAM ────────────────────────────────
function buildSHMessage(ticker, sh, isCrypto) {
  const p    = fmt(sh.price);
  const atr  = getATR(ticker, sh.price);
  const dir  = sh.type === 'SH_BULL' ? 'ALCISTA 🟢' : 'BAJISTA 🔴';
  const emoji= sh.type === 'SH_BULL' ? '🐂' : '🐻';
  const icon = isCrypto ? '🌐' : '📊';

  const sl  = sh.type === 'SH_BULL' ? fmt(sh.price - atr * 1.5) : fmt(sh.price + atr * 1.5);
  const tp1 = sh.type === 'SH_BULL' ? fmt(sh.price + atr * 2)   : fmt(sh.price - atr * 2);
  const tp2 = sh.type === 'SH_BULL' ? fmt(sh.price + atr * 3)   : fmt(sh.price - atr * 3);

  return `${icon} <b>STOP HUNT ${dir}</b> ${emoji}
🎯 <b>${ticker}</b> · ${sh.label} · ${sh.note}
💰 Precio: <b>${p}</b>
⭐ Score: ${sh.score}/5

🛑 SL: ${sl}
✅ TP1: ${tp1}
✅ TP2: ${tp2}

⚡ LiquidMap PRO · Monitor 24/7`;
}

function buildZoneMessage(ticker, price, dir, isCrypto) {
  const p    = fmt(price);
  const atr  = getATR(ticker, price);
  const icon = isCrypto ? '🌐' : '📊';
  const isBuy = dir === 'BUY';

  const sl  = isBuy ? fmt(price - atr * 1.5) : fmt(price + atr * 1.5);
  const tp1 = isBuy ? fmt(price + atr * 2)   : fmt(price - atr * 2);
  const tp2 = isBuy ? fmt(price + atr * 3)   : fmt(price - atr * 3);

  return `${icon} <b>ZONA LIQUIDEZ — ${isBuy ? 'BUY 🟢' : 'SELL 🔴'}</b>
🎯 <b>${ticker}</b>
💰 Precio: <b>${p}</b>

🛑 SL: ${sl}
✅ TP1: ${tp1}
✅ TP2: ${tp2}

⚡ LiquidMap PRO · Monitor 24/7`;
}

// ── FETCH CRYPTO (Binance) ───────────────────────────────────
async function fetchBinanceCandles(symbol, interval, limit = 3) {
  // interval: '1m','5m','15m','1h','4h','1d'
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r   = await fetch(url);
  const raw = await r.json();
  // [openTime, o, h, l, c, vol, ...]
  return raw.map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

async function fetchBinancePrice(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const r   = await fetch(url);
  const d   = await r.json();
  return parseFloat(d.price);
}

// ── FETCH STOCKS (Finnhub) ───────────────────────────────────
async function fetchFinnhubCandles(symbol, resolution, count = 3) {
  // resolution: '1','5','15','60','D'
  const to   = Math.floor(Date.now() / 1000);
  const from = to - (count + 5) * resolutionToSec(resolution);
  const url  = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&token=${FINNHUB_TOKEN}`;
  const r    = await fetch(url);
  const d    = await r.json();
  if (!d || d.s === 'no_data' || !d.c) return [];
  const len = d.c.length;
  const candles = [];
  for (let i = 0; i < len; i++) {
    candles.push({ o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v[i] });
  }
  return candles.slice(-count);
}

async function fetchFinnhubPrice(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_TOKEN}`;
  const r   = await fetch(url);
  const d   = await r.json();
  return parseFloat(d.c); // current price
}

function resolutionToSec(res) {
  const map = { '1':60, '5':300, '15':900, '60':3600, '240':14400, 'D':86400 };
  return map[res] || 300;
}

// ── ANÁLISIS ZONA LIQUIDEZ (simplificado) ───────────────────
// Detecta si el precio está en una zona de soporte/resistencia
// basado en máximos/mínimos recientes de varias velas
function detectZoneTouch(candles, price) {
  if (candles.length < 3) return null;

  // Zona resistencia: precio cerca del máximo reciente
  const recentHigh = Math.max(...candles.slice(0, -1).map(c => c.h));
  const recentLow  = Math.min(...candles.slice(0, -1).map(c => c.l));
  const lastC      = candles[candles.length - 1];

  const nearHigh = Math.abs(price - recentHigh) / price < 0.003; // dentro 0.3%
  const nearLow  = Math.abs(price - recentLow)  / price < 0.003;

  // Solo alerta si la vela actual tocó la zona y rebotó
  if (nearHigh && lastC.c < lastC.o) return 'SELL'; // tocó resistencia y bajó
  if (nearLow  && lastC.c > lastC.o) return 'BUY';  // tocó soporte y subió
  return null;
}

// ── ESCANEAR UN TICKER CRYPTO ────────────────────────────────
async function scanCrypto(symbol) {
  try {
    const price = await fetchBinancePrice(symbol);
    if (!price) return;

    // Escanear múltiples TF — solo poderosos (1H, 4H, 1D)
    // 5m/15m tienen demasiado ruido en crypto
    const timeframes = [
      { interval: '1h',  tf: 60   },
      { interval: '4h',  tf: 240  },
      { interval: '1d',  tf: 1440 },
    ];

    for (const { interval, tf } of timeframes) {
      const candles = await fetchBinanceCandles(symbol, interval, 5);
      if (!candles.length) continue;

      const last = candles[candles.length - 1];

      // Stop Hunt
      const sh = detectStopHunt(last, symbol, tf);
      if (sh && canAlert(symbol, `${sh.type}_${tf}`)) {
        await sendTelegram(buildSHMessage(symbol, { ...sh, price }, true));
      }

      // Zona de liquidez
      const zone = detectZoneTouch(candles, price);
      if (zone && canAlert(symbol, `ZONE_${zone}_${tf}`)) {
        await sendTelegram(buildZoneMessage(symbol, price, zone, true));
      }
    }
  } catch (e) {
    console.error(`[CRYPTO ${symbol}]`, e.message);
  }
}

// ── ESCANEAR UN TICKER STOCK ─────────────────────────────────
async function scanStock(symbol) {
  try {
    const price = await fetchFinnhubPrice(symbol);
    if (!price || price <= 0) return;

    // Bolsa: solo TF con peso real ($2-3 de retorno)
    // 5m solo se usa con alertas de TV (QQQ, AMZN) — no aquí
    const timeframes = [
      { resolution: '60', tf: 60  },
      { resolution: 'D',  tf: 1440 },
    ];

    for (const { resolution, tf } of timeframes) {
      const candles = await fetchFinnhubCandles(symbol, resolution, 5);
      if (!candles.length) continue;

      const last = candles[candles.length - 1];

      // Stop Hunt
      const sh = detectStopHunt(last, symbol, tf);
      if (sh && canAlert(symbol, `${sh.type}_${tf}`)) {
        await sendTelegram(buildSHMessage(symbol, { ...sh, price }, false));
      }

      // Zona de liquidez
      const zone = detectZoneTouch(candles, price);
      if (zone && canAlert(symbol, `ZONE_${zone}_${tf}`)) {
        await sendTelegram(buildZoneMessage(symbol, price, zone, false));
      }
    }
  } catch (e) {
    console.error(`[STOCK ${symbol}]`, e.message);
  }
}

// ── LOOP PRINCIPAL ───────────────────────────────────────────
async function runScan() {
  const now = new Date().toISOString();
  console.log(`\n[SCAN] ${now} — ${CRYPTO_TICKERS.length} crypto · ${STOCK_TICKERS.length} stocks`);

  // Crypto
  for (const sym of CRYPTO_TICKERS) {
    await scanCrypto(sym);
    await new Promise(r => setTimeout(r, 300)); // pequeña pausa entre calls
  }

  // Stocks (solo en horario de mercado o pre/post — Finnhub igual responde)
  for (const sym of STOCK_TICKERS) {
    await scanStock(sym);
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`[SCAN] Completo.`);
}

// ── ARRANQUE ─────────────────────────────────────────────────
console.log('🚀 LiquidMap PRO Monitor 24/7 — arrancando...');
console.log(`   Crypto: ${CRYPTO_TICKERS.join(', ')}`);
console.log(`   Stocks: ${STOCK_TICKERS.join(', ')}`);
console.log(`   Intervalo: cada ${INTERVAL_MS / 60000} min`);

// Primera ejecución inmediata
runScan();

// Luego cada 5 min
setInterval(runScan, INTERVAL_MS);
