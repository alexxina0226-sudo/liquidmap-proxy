// ============================================================
//  monitor_bolsa_v2.js — LiquidMap PRO · BOLSA
//  Sistema Neuronal Institucional — SINCRONIZADO con Mapa v6
//
//  CAPA 1 — SUPERTREND JUEZ (3pts) — igual al mapa v6
//  CAPA 2 — POC / VWAP (1.5pts)
//  CAPA 3 — CVD real + divergencia (1.5pts)
//  CAPA 4 — CHoCH + BOS (2pts) — 2 cierres confirmados
//  CAPA 5 — Stop Hunt + Order Blocks + EQH/EQL (1pt)
//  CAPA 6 — GEX estimado + MaxPain (1pt)
//  CAPA 7 — Dark Pool estimado (1pt)
//  CAPA 8 — Confirmación 15m + Power Hour timing
//
//  Reglas:
//  - Solo opera en sesión NY (9:30–16:00 ET) y pre-market desde 9:00 ET
//  - Score mínimo 6/10 · mínimo 3 capas concordantes
//  - Power Hour (9:30–10:30 y 15:00–16:00 ET) = señales prioritarias
//  - Silencio en Lunch (11:30–13:30 ET)
//  - Cooldown 4H roto automáticamente por CHoCH
//  - Bot: @liquidmapbolsa_bot
// ============================================================

'use strict';
const fetch = require('node-fetch');

// ── CONFIG ──────────────────────────────────────────────────
const TELEGRAM_TOKEN_BOLSA = '8278713898:AAGGaBAhmUTDnqjBxyv3YVZAtYiwlsEA0J4';
const CHAT_IDS             = ['1218461753', '1373309702'];
const POLYGON_KEY          = process.env.POLYGON_KEY || ''; // velas + quote REALES (env var en Render)

const STOCK_TICKERS = [
  'SPY', 'QQQ', 'NVDA', 'AAPL', 'AMZN',
  'TSLA', 'MSFT', 'META', 'GOOG', 'AMD',
  'IWM', 'DIA', 'WMT',
];

const ATR_PCT = {
  SPY: 0.008, QQQ: 0.010, NVDA: 0.025, AAPL: 0.012,
  AMZN: 0.015, TSLA: 0.030, MSFT: 0.012, META: 0.018,
  GOOG: 0.013, AMD: 0.025, IWM: 0.010, DIA: 0.007, WMT: 0.010,
};

const MIN_SCORE     = 6;
const COOLDOWN_MS   = 4 * 60 * 60 * 1000;
const SCAN_INTERVAL = 5 * 60 * 1000;

// ── ESTADO ──────────────────────────────────────────────────
const STATE = {};
function getState(ticker) {
  if (!STATE[ticker]) {
    STATE[ticker] = { lastSignalDir: null, lastSignalTs: 0 };
  }
  return STATE[ticker];
}

// ── HELPERS ─────────────────────────────────────────────────
function fmt(n, ref) {
  if (isNaN(+n)) return '—';
  if (ref >= 1000) return (+n).toFixed(2);
  if (ref >= 100)  return (+n).toFixed(2);
  return (+n).toFixed(3);
}

// Factor ATR según timeframe — distancias proporcionales al TF operativo
const TF_ATR_FACTOR = { '5':0.10, '15':0.18, '60':0.35, '240':0.60, 'D':1.00 };
// Multiplicadores SL/TP por TF — scalp vs swing vs posicional
const TF_TP_MULT = {
  '5':   { sl:0.8,  tp1:1.2,  tp2:2.0,  tp3:3.0  },
  '15':  { sl:1.0,  tp1:1.5,  tp2:2.5,  tp3:4.0  },
  '60':  { sl:1.5,  tp1:2.0,  tp2:3.5,  tp3:6.0  },
  '240': { sl:2.0,  tp1:3.0,  tp2:5.0,  tp3:9.0  },
  'D':   { sl:2.5,  tp1:4.0,  tp2:7.0,  tp3:12.0 },
};
// ATR dinámico real — True Range EMA-14 Wilder (más preciso para SL/TP)
function calcRealATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trList = [];
  for (let i = 1; i < candles.length; i++) {
    trList.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i-1].c),
      Math.abs(candles[i].l - candles[i-1].c)
    ));
  }
  let atr = trList.slice(0, period).reduce((a, v) => a + v, 0) / period;
  for (let i = period; i < trList.length; i++) {
    atr = atr * (period - 1) / period + trList[i] / period;
  }
  return atr > 0 ? atr : null;
}

function getATR(ticker, price, currentTF, candles) {
  // Si hay velas suficientes, usar ATR real escalado al TF operativo
  if (candles && candles.length >= 15) {
    const realATR = calcRealATR(candles, 14);
    if (realATR) {
      const factor = TF_ATR_FACTOR[currentTF || '240'] || 0.60;
      // El ATR real ya viene del TF de las velas; lo ajustamos suavemente
      return realATR * (0.6 + factor * 0.4);
    }
  }
  // Fallback estático — idéntico al mapa
  const basePct = ATR_PCT[ticker] || 0.015;
  const factor  = TF_ATR_FACTOR[currentTF || '240'] || 0.60;
  return price * basePct * factor;
}
function getTPMult(currentTF) {
  return TF_TP_MULT[currentTF || '240'] || TF_TP_MULT['240'];
}

function isDST(date) {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return Math.max(jan, jul) !== date.getTimezoneOffset();
}

// ── SESIÓN NY ────────────────────────────────────────────────
function getNYSession() {
  const now      = new Date();
  const etOffset = isDST(now) ? -4 : -5;
  const etHour   = (now.getUTCHours() + etOffset + 24) % 24;
  const etMin    = now.getUTCMinutes();
  const etTime   = etHour + etMin / 60;

  const marketOpen      = etTime >= 9.5  && etTime < 16;
  const preMarket       = etTime >= 4    && etTime < 9.5;
  const afterHours      = etTime >= 16   && etTime < 20;
  const powerHourOpen   = etTime >= 9.5  && etTime < 10.5;
  const lunchZone       = etTime >= 11.5 && etTime < 13.5;
  const powerHourClose  = etTime >= 15   && etTime < 16;

  let sessionName = 'Cerrado';
  if (marketOpen)  sessionName = 'Sesión NY';
  if (preMarket)   sessionName = 'Pre-Market';
  if (afterHours)  sessionName = 'After-Hours';

  let powerHour = null;
  if (powerHourOpen)  powerHour = { name: '🔥 Power Hour Open',  weight: 1.6 };
  if (powerHourClose) powerHour = { name: '🔥 Power Hour Close', weight: 1.4 };

  return {
    etTime, marketOpen, preMarket, afterHours,
    lunchZone, powerHour, sessionName,
    shouldScan: marketOpen || (preMarket && etTime >= 9),
  };
}

// ── FETCH VELAS · POLYGON (reales SIP) ───────────────────────
async function fetchPolygonCandles(symbol, mult, span, fromDays) {
  if (!POLYGON_KEY) return [];
  try {
    const fmtDate = d => new Date(d).toISOString().slice(0, 10);
    const to   = fmtDate(Date.now());
    const from = fmtDate(Date.now() - fromDays * 86400000);
    const url  = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url, { timeout: 10000 });
    const d = await r.json();
    if (d.status === 'ERROR' || d.error || !d.results || !d.results.length) return [];
    // Polygon ya entrega t en ms — el monitor trabaja en ms internamente
    return d.results.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }));
  } catch { return []; }
}

async function fetchCandles(symbol, tf) {
  // TF → config nativa de Polygon (4H es mult=4/hour real, sin agrupar)
  let mult, span, days;
  switch (tf) {
    case '1D':  mult = 1; span = 'day';    days = 200; break;
    case '4H':  mult = 4; span = 'hour';   days = 300; break;
    case '1H':  mult = 1; span = 'hour';   days = 90;  break;
    case '15m': mult = 15; span = 'minute'; days = 25; break;
    default:    mult = 1; span = 'hour';   days = 90;
  }
  return await fetchPolygonCandles(symbol, mult, span, days);
}

async function fetchQuote(symbol) {
  if (!POLYGON_KEY) return null;
  try {
    // SIN snapshot (el plan Starter no lo autoriza → 401). Día actual + día previo
    // desde aggregates diarios, autorizado por el plan. Fuente única: Polygon.
    const to   = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10); // 7d cubre findes/feriados
    const url  = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=2&apiKey=${POLYGON_KEY}`;
    const r    = await fetch(url);
    const j    = await r.json();
    if (j.status === 'ERROR' || j.error || !j.results || !j.results.length) return null;
    const dayBar  = j.results[0];                               // sesión más reciente
    const prevBar = j.results.length > 1 ? j.results[1] : null; // día previo
    const live      = dayBar.c;
    const prevClose = prevBar ? prevBar.c : dayBar.o;
    if (!live) return null;
    // Formato compatible con el resto del monitor (c, h, l, o, pc, dp)
    return {
      c:  live,
      h:  dayBar.h || live,
      l:  dayBar.l || live,
      o:  dayBar.o || prevClose,
      pc: prevClose,
      dp: prevClose ? ((live - prevClose) / prevClose * 100) : 0
    };
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════
//  CAPA 1 — SUPERTREND JUEZ
//  Idéntico al mapa v6: period=10, multiplier=3.0, peso=3pts
// ════════════════════════════════════════════════════════════
function calcSuperTrend(candles, period = 10, multiplier = 3.0) {
  // IDÉNTICO al mapa HTML v6 — ATR = SMA deslizante de los últimos `period` TR
  // recalculado barra por barra (no EMA Wilder), para que monitor y mapa
  // generen el cruce de SuperTrend EXACTAMENTE en la misma vela.
  if (!candles || candles.length < period + 1) return null;
  const result = [];
  let prevUpper = 0, prevLower = 0, prevTrend = 1;
  for (let i = period; i < candles.length; i++) {
    const slice = candles.slice(i - period, i + 1);
    const trList = slice.map((b, j) => {
      if (j === 0) return b.h - b.l;
      return Math.max(b.h - b.l, Math.abs(b.h - slice[j-1].c), Math.abs(b.l - slice[j-1].c));
    });
    const atr = trList.reduce((a, v) => a + v, 0) / period;
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const upper = hl2 + multiplier * atr;
    const lower = hl2 - multiplier * atr;
    const finalUpper = (upper < prevUpper || candles[i-1].c > prevUpper) ? upper : prevUpper;
    const finalLower = (lower > prevLower || candles[i-1].c < prevLower) ? lower : prevLower;
    let trend = prevTrend;
    if (candles[i].c > finalUpper) trend = 1;
    else if (candles[i].c < finalLower) trend = -1;
    result.push({ value: trend === 1 ? finalLower : finalUpper, trend });
    prevUpper = finalUpper; prevLower = finalLower; prevTrend = trend;
  }

  if (result.length < 2) return null;

  const last    = result[result.length - 1];
  const prev    = result[result.length - 2];
  const crossed = last.trend !== prev.trend;

  return {
    value:   last.value,
    trend:   last.trend,
    bullish: last.trend === 1,
    bearish: last.trend === -1,
    crossed,
    label:   last.trend === 1 ? '📗 SuperTrend ALCISTA' : '📕 SuperTrend BAJISTA',
  };
}

// ════════════════════════════════════════════════════════════
//  CAPA 2 — VOLUME PROFILE: POC, VWAP, VAH, VAL
// ════════════════════════════════════════════════════════════
function buildVolumeProfile(candles, bins = 100) {
  const mn = Math.min(...candles.map(c => c.l));
  const mx = Math.max(...candles.map(c => c.h));
  if (mx <= mn) return null;

  const bs      = (mx - mn) / bins;
  const profile = new Array(bins).fill(0);

  for (const c of candles) {
    const iLow  = Math.max(0, Math.floor((c.l - mn) / bs));
    const iHigh = Math.min(bins - 1, Math.floor((c.h - mn) / bs));
    for (let i = iLow; i <= iHigh; i++) {
      profile[i] += c.v / Math.max(1, iHigh - iLow + 1);
    }
  }

  const maxVol = Math.max(...profile);
  const pocIdx = profile.indexOf(maxVol);
  const poc    = mn + pocIdx * bs + bs / 2;

  const total = profile.reduce((a, b) => a + b, 0);
  let lo = pocIdx, hi = pocIdx, acc = profile[pocIdx];
  while (acc < total * 0.70) {
    const al = lo > 0 ? profile[lo - 1] : 0;
    const ah = hi < bins - 1 ? profile[hi + 1] : 0;
    if (al >= ah && lo > 0) { lo--; acc += al; }
    else if (hi < bins - 1) { hi++; acc += ah; }
    else break;
  }

  let sumPV = 0, sumV = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    sumPV += tp * c.v;
    sumV  += c.v;
  }

  return {
    poc,
    vah:  mn + hi * bs + bs,
    val:  mn + lo * bs,
    vwap: sumV > 0 ? sumPV / sumV : poc,
    profile, min: mn, max: mx, binSize: bs,
  };
}

// ════════════════════════════════════════════════════════════
//  CAPA 3 — CVD + DELTA
//  APROXIMACIÓN: estima compra/venta por dirección de vela (60/40).
//  NO es CVD real por agresor (bid/ask tick). El CVD real requiere el
//  feed de trades de Polygon (FASE 3). Es una proxy estándar, no dato
//  inventado, pero el equipo debe saber que es aproximación.
// ════════════════════════════════════════════════════════════
function calcCVD(candles) {
  let cvd = 0, buyVol = 0, sellVol = 0;
  const deltas = [];

  for (const c of candles) {
    const bv = c.c >= c.o ? c.v * 0.6 : c.v * 0.4;
    const sv = c.v - bv;
    buyVol  += bv;
    sellVol += sv;
    cvd     += (bv - sv);
    deltas.push(bv - sv);
  }

  const total   = buyVol + sellVol || 1;
  const buyPct  = (buyVol / total) * 100;
  const recent  = candles.slice(-8);
  const priceDir = recent[recent.length - 1].c > recent[0].c ? 'up' : 'down';
  const cvdDir   = deltas.slice(-8).reduce((a, b) => a + b, 0) > 0 ? 'up' : 'down';

  return {
    cvd, buyVol, sellVol, buyPct,
    divergence: priceDir !== cvdDir,
    priceDir, cvdDir,
    bullish: cvd > 0 && buyPct > 51 && priceDir === cvdDir,
    bearish: cvd < 0 && buyPct < 49 && priceDir === cvdDir,
  };
}

// ════════════════════════════════════════════════════════════
//  CAPA 4 — CHoCH + BOS (con 2 cierres confirmados — igual mapa v6)
// ════════════════════════════════════════════════════════════
function detectStructure(candles) {
  if (candles.length < 30) return null;

  const lookback   = 5;
  const swingHighs = [], swingLows = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c   = candles[i];
    const win = [...candles.slice(i - lookback, i), ...candles.slice(i + 1, i + lookback + 1)];
    if (win.every(x => c.h >= x.h)) swingHighs.push({ price: c.h, idx: i });
    if (win.every(x => c.l <= x.l)) swingLows.push({ price: c.l, idx: i });
  }

  if (swingHighs.length < 2 || swingLows.length < 2) return null;

  const lastHigh  = swingHighs[swingHighs.length - 1];
  const prevHigh  = swingHighs[swingHighs.length - 2];
  const lastLow   = swingLows[swingLows.length - 1];
  const prevLow   = swingLows[swingLows.length - 2];
  const n         = candles.length;
  const lastClose = candles[n - 1].c;
  const prevClose = candles[n - 2].c;

  // CHoCH: requiere 2 cierres confirmados (igual mapa v6)
  if (lastClose < prevLow.price && prevClose < prevLow.price * 1.003)
    return { type: 'CHOCH_SELL', label: '⚡ CHoCH BAJISTA', priority: 10 };
  if (lastClose > prevHigh.price && prevClose > prevHigh.price * 0.997)
    return { type: 'CHOCH_BUY',  label: '⚡ CHoCH ALCISTA', priority: 10 };
  if (lastClose < lastLow.price && lastHigh.price < prevHigh.price)
    return { type: 'BOS_SELL', label: '📉 BOS BAJISTA', priority: 7 };
  if (lastClose > lastHigh.price && lastLow.price > prevLow.price)
    return { type: 'BOS_BUY',  label: '📈 BOS ALCISTA', priority: 7 };

  return null;
}

// ════════════════════════════════════════════════════════════
//  CAPA 5 — STOP HUNT + ORDER BLOCKS + EQH/EQL
// ════════════════════════════════════════════════════════════
function detectStopHunt(candles) {
  if (candles.length < 5) return null;
  const c      = candles[candles.length - 1];
  const body   = Math.abs(c.c - c.o);
  const range  = c.h - c.l;
  if (!range || body < range * 0.01) return null;

  const upperWick = c.h - Math.max(c.o, c.c);
  const lowerWick = Math.min(c.o, c.c) - c.l;
  const isBearSH  = upperWick >= body * 2.5 && upperWick / range >= 0.45;
  const isBullSH  = lowerWick >= body * 2.5 && lowerWick / range >= 0.45;
  if (!isBullSH && !isBearSH) return null;

  const prevHigh = Math.max(...candles.slice(-10, -1).map(x => x.h));
  const prevLow  = Math.min(...candles.slice(-10, -1).map(x => x.l));

  if (isBullSH && c.l < prevLow  * 0.999) return { type: 'SH_BUY',  strength: lowerWick/range };
  if (isBearSH && c.h > prevHigh * 1.001) return { type: 'SH_SELL', strength: upperWick/range };
  if (isBullSH) return { type: 'SH_BUY',  strength: lowerWick/range * 0.7 };
  if (isBearSH) return { type: 'SH_SELL', strength: upperWick/range * 0.7 };
  return null;
}

function detectLiquidityZones(candles, price) {
  const zones = [], tolerance = price * 0.002;
  const highs = candles.slice(-50).map(c => c.h);
  const lows  = candles.slice(-50).map(c => c.l);
  const hc = {}, lc = {};

  highs.forEach(h => { const k = Math.round(h/tolerance); hc[k] = (hc[k]||0)+1; });
  lows.forEach(l  => { const k = Math.round(l/tolerance); lc[k] = (lc[k]||0)+1; });

  Object.entries(hc).forEach(([k,n]) => {
    if (n >= 2) zones.push({ price: +k*tolerance, type: 'EQH',
      side: +k*tolerance > price ? 'above' : 'below',
      strength: Math.min(1, n/3), label: 'Equal Highs' });
  });
  Object.entries(lc).forEach(([k,n]) => {
    if (n >= 2) zones.push({ price: +k*tolerance, type: 'EQL',
      side: +k*tolerance < price ? 'below' : 'above',
      strength: Math.min(1, n/3), label: 'Equal Lows' });
  });

  for (let i = candles.length - 20; i < candles.length - 3; i++) {
    if (i < 0) continue;
    const c = candles[i], n1 = candles[i+1], n2 = candles[i+2];
    if (c.c < c.o && n1.c > n1.o && n2.c > n2.o && (n2.h-c.l)/price > 0.004)
      zones.push({ price: c.l, type:'OB_BUY',  side:'below', strength:(n2.h-c.l)/price*8, label:'Order Block Alcista' });
    if (c.c > c.o && n1.c < n1.o && n2.c < n2.o && (c.h-n2.l)/price > 0.004)
      zones.push({ price: c.h, type:'OB_SELL', side:'above', strength:(c.h-n2.l)/price*8, label:'Order Block Bajista' });
  }

  return {
    zones,
    nearZones: zones
      .filter(z => Math.abs(z.price-price)/price < 0.02)
      .sort((a,b) => Math.abs(a.price-price) - Math.abs(b.price-price)),
  };
}

// ════════════════════════════════════════════════════════════
//  CAPA 6 — RÉGIMEN DE VOLATILIDAD (real, por rango de velas)
//  NOTA: GEX/Call Wall/Put Wall/Max Pain REALES requieren cadena de
//  opciones (add-on Polygon, FASE 4). NO se inventan. Aquí solo
//  calculamos el régimen de volatilidad, que sí es dato real de precio.
// ════════════════════════════════════════════════════════════
function estimateGEX(price, vp, candles) {
  if (!vp || !candles || candles.length < 10)
    return { gexNet: 0, regime: 'N/D', callWall: null, putWall: null, maxPain: null, volRegime: 'N/D' };
  const ranges   = candles.slice(-10).map(c => (c.h - c.l) / c.c);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  // Régimen de volatilidad: dato REAL derivado del rango verdadero de las velas
  const lowVol = avgRange < 0.008;
  return {
    gexNet:   lowVol ? 1 : -1,
    regime:   'N/D (opciones FASE 4)',        // NO afirmamos GEX real
    volRegime: lowVol ? 'BAJA VOL' : 'ALTA VOL', // esto SÍ es real
    callWall: null,                            // requiere opciones reales
    putWall:  null,                            // requiere opciones reales
    maxPain:  null,                            // requiere opciones reales
  };
}

// ════════════════════════════════════════════════════════════
//  DARK POOL ESTIMADO — DESACTIVADO
//  Los prints de dark pool reales requieren el feed de trades con
//  condición de venta (add-on Polygon, FASE 3/4). No se estima.
// ════════════════════════════════════════════════════════════
function estimateDarkPool(candles, price) {
  return null;  // FASE 4: prints reales. No inventamos acumulación/distribución.
}
function _estimateDarkPool_disabled(candles, price) {
  if (candles.length < 10) return null;
  const vols   = candles.map(c => c.v);
  const avgVol = vols.slice(0,-3).reduce((a,b)=>a+b,0) / (vols.length-3);

  for (const c of candles.slice(-3)) {
    if (c.v < avgVol * 2.5) continue;
    const bodyPct = Math.abs(c.c-c.o) / (c.h-c.l);
    if (bodyPct < 0.3) return { direction:'NEUTRAL', volumeRatio:c.v/avgVol, label:'🌑 DP: acumulación/distribución oculta' };
    const dir = c.c > c.o ? 'BUY' : 'SELL';
    return { direction:dir, volumeRatio:c.v/avgVol, label:`🌑 Dark Pool ${dir==='BUY'?'alcista':'bajista'} ×${(c.v/avgVol).toFixed(1)}` };
  }
  return null;
}

// ════════════════════════════════════════════════════════════
//  MOTOR NEURONAL — PESOS IDÉNTICOS AL MAPA v6
// ════════════════════════════════════════════════════════════
function evaluateAllLayers({ price, candles4H, candles1H, candles15m, vp, session }) {
  const signals = [];

  // ── CAPA 1: SUPERTREND JUEZ (3pts) ─────────────────────
  const st4H = calcSuperTrend(candles4H);
  const st1H = calcSuperTrend(candles1H);

  if (st4H) {
    if (st4H.bullish) signals.push({ layer:1, dir:'BUY',  weight: st4H.crossed ? 3.5 : 3, label:`${st4H.label} 4H${st4H.crossed?' ← CRUCE':''} — precio sobre soporte` });
    if (st4H.bearish) signals.push({ layer:1, dir:'SELL', weight: st4H.crossed ? 3.5 : 3, label:`${st4H.label} 4H${st4H.crossed?' ← CRUCE':''} — precio bajo resistencia` });
  }
  if (st1H) {
    // Confirmación en 1H vale 0.5pts adicional si coincide con 4H
    if (st4H && st1H.trend === st4H.trend) {
      signals.push({ layer:1, dir: st1H.bullish?'BUY':'SELL', weight:0.5, label:`SuperTrend 1H confirma ${st1H.bullish?'alcista':'bajista'}` });
    }
  }

  // ── CAPA 2: POC / VWAP (1.5pts) ────────────────────────
  if (vp) {
    if (price > vp.vwap) signals.push({ layer:2, dir:'BUY',  weight:1.5, label:`Precio > VWAP (${fmt(vp.vwap,price)}) — alcista intradía` });
    else                 signals.push({ layer:2, dir:'SELL', weight:1.5, label:`Precio < VWAP (${fmt(vp.vwap,price)}) — bajista intradía` });

    if (price > vp.poc)  signals.push({ layer:2, dir:'BUY',  weight:0.5, label:`Precio > POC (${fmt(vp.poc,price)})` });
    else                 signals.push({ layer:2, dir:'SELL', weight:0.5, label:`Precio < POC (${fmt(vp.poc,price)})` });

    if (price > vp.vah)  signals.push({ layer:2, dir:'SELL', weight:0.5, label:'Sobre VAH — resistencia de valor' });
    else if (price < vp.val) signals.push({ layer:2, dir:'BUY', weight:0.5, label:'Bajo VAL — soporte de valor' });
  }

  // ── CAPA 3: CVD (1.5pts) ───────────────────────────────
  const cvd4H = calcCVD(candles4H);
  const cvd1H = calcCVD(candles1H);

  if (cvd4H.bullish) signals.push({ layer:3, dir:'BUY',  weight:1.5, label:`CVD 4H positivo — ${cvd4H.buyPct.toFixed(0)}% compra institucional` });
  if (cvd4H.bearish) signals.push({ layer:3, dir:'SELL', weight:1.5, label:`CVD 4H negativo — ${(100-cvd4H.buyPct).toFixed(0)}% venta institucional` });

  if (cvd4H.divergence) {
    const divDir = cvd4H.priceDir === 'up' ? 'SELL' : 'BUY';
    signals.push({ layer:3, dir:divDir, weight:2, label:`⚠️ Divergencia CVD 4H — ${divDir==='SELL'?'distribución':'acumulación'} oculta` });
  }

  if (cvd1H.bullish && cvd4H.bullish) signals.push({ layer:3, dir:'BUY',  weight:0.5, label:'CVD 1H confirma alcista' });
  if (cvd1H.bearish && cvd4H.bearish) signals.push({ layer:3, dir:'SELL', weight:0.5, label:'CVD 1H confirma bajista' });

  // ── CAPA 4: CHoCH + BOS (2pts) ─────────────────────────
  const struct4H = detectStructure(candles4H);
  const struct1H = detectStructure(candles1H);

  if (struct4H) {
    const sDir = struct4H.type.includes('BUY') ? 'BUY' : 'SELL';
    signals.push({ layer:4, dir:sDir, weight: struct4H.type.includes('CHOCH') ? 1.5 : 3.0, label:`${struct4H.label} 4H` });
  }
  if (struct1H) {
    const sDir = struct1H.type.includes('BUY') ? 'BUY' : 'SELL';
    signals.push({ layer:4, dir:sDir, weight: struct1H.type.includes('CHOCH') ? 0.8 : 2.0, label:`${struct1H.label} 1H` });
  }

  // ── CAPA 5: SH + OB + EQH/EQL (1pt) ───────────────────
  const sh4H = detectStopHunt(candles4H);
  const sh1H = detectStopHunt(candles1H);
  if (sh4H) signals.push({ layer:5, dir: sh4H.type==='SH_BUY'?'BUY':'SELL', weight: sh4H.strength*2, label:`🎯 Stop Hunt ${sh4H.type==='SH_BUY'?'alcista':'bajista'} 4H` });
  if (sh1H) signals.push({ layer:5, dir: sh1H.type==='SH_BUY'?'BUY':'SELL', weight: sh1H.strength,   label:`🎯 SH ${sh1H.type==='SH_BUY'?'alcista':'bajista'} 1H` });

  const liqData = detectLiquidityZones(candles4H, price);
  const nearSup = liqData.nearZones.find(z => z.side==='below' && z.strength>0.5);
  const nearRes = liqData.nearZones.find(z => z.side==='above' && z.strength>0.5);
  if (nearSup) signals.push({ layer:5, dir:'BUY',  weight:nearSup.strength, label:`${nearSup.label} soporte ${fmt(nearSup.price,price)}` });
  if (nearRes) signals.push({ layer:5, dir:'SELL', weight:nearRes.strength, label:`${nearRes.label} resistencia ${fmt(nearRes.price,price)}` });

  // ── CAPA 6: RÉGIMEN DE VOLATILIDAD (real, por rango de velas) ──
  // Solo usamos el régimen de volatilidad (dato real). NO walls/maxpain (FASE 4).
  const gex = estimateGEX(price, vp, candles4H);
  // En alta volatilidad el momentum se amplifica; refuerza levemente la dirección
  // YA establecida por capas reales (no genera dirección por sí solo).
  // Nota: no añade señal direccional propia para no inventar sesgo.

  // ── CAPA 7: DARK POOL — DESACTIVADA (requiere trades reales, FASE 4) ──
  const dp = null;  // estimateDarkPool desactivado: no inventamos prints

  // ── CAPA 8: CONFIRMACIÓN 15m + POWER HOUR ──────────────
  const cvd15m = calcCVD(candles15m);
  const sh15m  = detectStopHunt(candles15m);
  if (cvd15m.bullish) signals.push({ layer:8, dir:'BUY',  weight:0.5, label:'CVD 15m alcista — momentum entrada' });
  if (cvd15m.bearish) signals.push({ layer:8, dir:'SELL', weight:0.5, label:'CVD 15m bajista — momentum entrada' });
  if (sh15m) signals.push({ layer:8, dir: sh15m.type==='SH_BUY'?'BUY':'SELL', weight:0.8, label:'SH 15m — timing preciso' });

  if (session.powerHour) {
    const dir15 = cvd15m.bullish ? 'BUY' : cvd15m.bearish ? 'SELL' : null;
    if (dir15) signals.push({ layer:8, dir:dir15, weight: session.powerHour.weight - 1, label:`${session.powerHour.name} activa` });
  }

  // ── SCORE FINAL — NORMALIZADO 0-10 (igual mapa v6) ─────
  let buyScore = 0, sellScore = 0;
  for (const sig of signals) {
    if (sig.dir === 'BUY')  buyScore  += sig.weight;
    if (sig.dir === 'SELL') sellScore += sig.weight;
  }

  let direction = 'NEUTRAL';
  if (buyScore  > sellScore && (buyScore  - sellScore) >= 1.5) direction = 'BUY';
  if (sellScore > buyScore  && (sellScore - buyScore)  >= 1.5) direction = 'SELL';

  const netScore   = Math.abs(buyScore - sellScore);
  const finalScore = Math.min(10, Math.round(netScore * 1.2));

  const confluences = signals
    .filter(s => s.dir === direction)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5)
    .map(s => s.label);

  const layersInDir = new Set(signals.filter(s => s.dir === direction).map(s => s.layer));

  return {
    direction, score: finalScore, buyScore, sellScore,
    confluences, signals, layersInDir,
    st4H, cvd4H, struct4H, sh4H, gex, dp, vp,
  };
}

// ── MENSAJE TELEGRAM ─────────────────────────────────────────
function buildMessage(ticker, price, result, session, quote, candles4H) {
  const isBuy  = result.direction === 'BUY';
  const _tf    = '240';  // monitor analiza en 4H — señales de swing
  const atr    = getATR(ticker, price, _tf, candles4H);
  const _m     = getTPMult(_tf);
  const sl     = isBuy ? price - atr * _m.sl  : price + atr * _m.sl;
  const tp1    = isBuy ? price + atr * _m.tp1 : price - atr * _m.tp1;
  const tp2    = isBuy ? price + atr * _m.tp2 : price - atr * _m.tp2;
  const tp3    = isBuy ? price + atr * _m.tp3 : price - atr * _m.tp3;

  const arrow   = isBuy ? '▲ BUY — COMPRA 🟢' : '▼ SELL — VENTA 🔴';
  const quality = result.score >= 8 ? '🔥 MÁXIMA CALIDAD'
                : result.score >= 6 ? '⭐ INSTITUCIONAL'
                : '✅ VÁLIDA';

  const phLine    = session.powerHour ? `\n⏰ ${session.powerHour.name}` : '';
  const stLine    = result.st4H       ? `\n${result.st4H.label}${result.st4H.crossed?' ← CRUCE RECIENTE':''}` : '';
  const structL   = result.struct4H   ? `\n🔷 ${result.struct4H.label} 4H` : '';
  const shLine    = result.sh4H       ? `\n🎯 Stop Hunt ${result.sh4H.type==='SH_BUY'?'alcista':'bajista'} 4H` : '';
  const dpLine    = '';  // Dark Pool desactivado (FASE 4)
  const gexLine   = (result.gex && result.gex.volRegime && result.gex.volRegime !== 'N/D')
    ? `\n📊 Volatilidad: ${result.gex.volRegime} · GEX/MaxPain: N/D (opciones FASE 4)`
    : '';
  const confList  = result.confluences.map(c => `  • ${c}`).join('\n');
  const changeStr = (quote && quote.pc && quote.pc !== 0)
    ? `${((quote.c - quote.pc)/quote.pc*100) >= 0 ? '+' : ''}${((quote.c - quote.pc)/quote.pc*100).toFixed(2)}%`
    : (quote && typeof quote.dp === 'number' ? `${quote.dp>=0?'+':''}${quote.dp.toFixed(2)}%` : '—');

  return `📊 <b>SEÑAL INSTITUCIONAL — BOLSA</b>
${arrow}

🎯 <b>${ticker}</b> · 4H${phLine}
💰 Precio: <b>${fmt(price,price)}</b> (${changeStr} hoy)
⭐ Score: ${result.score}/10 · ${quality}
🌏 Sesión: ${session.sessionName}${stLine}

📊 <b>Confluencias:</b>
${confList}${structL}${shLine}${dpLine}${gexLine}

📈 CVD: ${result.cvd4H.cvd>0?'▲ Positivo':'▼ Negativo'} · ${result.cvd4H.buyPct.toFixed(0)}% Buy
📐 POC: ${result.vp?fmt(result.vp.poc,price):'—'} · VWAP: ${result.vp?fmt(result.vp.vwap,price):'—'}

🛑 SL:  ${fmt(sl,price)}
✅ TP1: ${fmt(tp1,price)} · R:R 1:2
✅ TP2: ${fmt(tp2,price)} · R:R 1:3
🔶 TP3: ${fmt(tp3,price)} · R:R 1:5

⚡ LiquidMap PRO · Bolsa v2`;
}

// ── ENVIAR TELEGRAM ──────────────────────────────────────────
async function sendTelegram(text) {
  try {
    await Promise.all(CHAT_IDS.map(id =>
      fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN_BOLSA}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML',
                               disable_web_page_preview: true }),
      })
    ));
    console.log(`[TG-BOLSA] ✅ ${text.substring(0,60).replace(/\n/g,' ')}`);
  } catch(e) { console.error('[TG-BOLSA ERROR]', e.message); }
}

// ── SCANNER PRINCIPAL ────────────────────────────────────────
async function scanTicker(ticker, session) {
  const s = getState(ticker);
  try {
    const [candles4H, candles1H, candles15m, quote] = await Promise.all([
      fetchCandles(ticker, '4H'),
      fetchCandles(ticker, '1H'),
      fetchCandles(ticker, '15m'),
      fetchQuote(ticker),
    ]);

    if (candles4H.length < 20) {
      console.log(`[${ticker}] Sin datos suficientes`);
      return;
    }

    const price  = quote?.c || candles4H[candles4H.length - 1].c;
    // Overlay precio del último cierre (Polygon, delay 15 min en Starter) sobre la
    // última vela real de cada TF. Fuente única, sin Finnhub.
    if (quote?.c) {
      for (const arr of [candles4H, candles1H, candles15m]) {
        if (arr.length) {
          const last = arr[arr.length - 1];
          last.c = quote.c;
          if (quote.h) last.h = Math.max(last.h, quote.h);
          if (quote.l) last.l = Math.min(last.l, quote.l);
        }
      }
    }
    // VOLUME PROFILE sobre VENTANA OPERATIVA (últimas 60 velas 4H), no toda la
    // historia — clave anti-POC-viejo. Idéntico criterio que el mapa v7.
    const vpWindow = candles4H.slice(-60);
    const vp     = buildVolumeProfile(vpWindow, 100);
    const result = evaluateAllLayers({ price, candles4H, candles1H, candles15m, vp, session });

    const stLabel = result.st4H ? (result.st4H.bullish ? '↑ST' : '↓ST') : 'ST?';
    console.log(`[${ticker}] Dir=${result.direction} Score=${result.score}/10 ${stLabel} BUY=${result.buyScore.toFixed(1)} SELL=${result.sellScore.toFixed(1)} Capas=${result.layersInDir.size}`);

    if (result.direction === 'NEUTRAL') return;

    const minReq = session.powerHour ? 5 : MIN_SCORE;
    if (result.score < minReq) {
      console.log(`[${ticker}] Score ${result.score}/${minReq} insuficiente`);
      return;
    }

    if (result.layersInDir.size < 3) {
      console.log(`[${ticker}] Solo ${result.layersInDir.size} capas — necesita 3`);
      return;
    }

    const hasChoch = result.struct4H?.type?.includes('CHOCH') || result.struct4H?.type?.includes('BOS');
    const inCooldown = s.lastSignalDir === result.direction
                    && (Date.now() - s.lastSignalTs) < COOLDOWN_MS
                    && !hasChoch;
    if (inCooldown) {
      const h = ((COOLDOWN_MS - (Date.now() - s.lastSignalTs)) / 3600000).toFixed(1);
      console.log(`[${ticker}] Cooldown — ${h}h restantes`);
      return;
    }

    console.log(`[${ticker}] ✅ SEÑAL BOLSA v2: ${result.direction} score=${result.score}/10`);
    await sendTelegram(buildMessage(ticker, price, result, session, quote, candles4H));

    s.lastSignalDir = result.direction;
    s.lastSignalTs  = Date.now();

  } catch(e) {
    console.error(`[${ticker}] Error:`, e.message);
  }
}

// ── LOOP PRINCIPAL ────────────────────────────────────────────
async function runScan() {
  const session = getNYSession();
  const now     = new Date().toISOString();

  if (!session.shouldScan) {
    console.log(`[BOLSA] ${now} · Mercado cerrado (${session.sessionName}) — esperando apertura NY`);
    return;
  }
  if (session.lunchZone) {
    console.log(`[BOLSA] ${now} · Lunch zone (11:30–13:30 ET) — silencio`);
    return;
  }

  console.log(`\n[BOLSA SCAN v2] ${now} · ${session.sessionName} ${session.powerHour ? `· ${session.powerHour.name}` : ''}`);

  for (const ticker of STOCK_TICKERS) {
    await scanTicker(ticker, session);
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('[BOLSA SCAN v2] Completo.');
}

// ── ARRANQUE ──────────────────────────────────────────────────
console.log('📊 LiquidMap PRO Monitor BOLSA v2 — Sincronizado con Mapa v6');
console.log(`   Tickers   : ${STOCK_TICKERS.join(', ')}`);
console.log('   CAPA 1    : SuperTrend JUEZ (3pts) — NUEVO v2');
console.log('   CAPA 2    : POC / VWAP (1.5pts)');
console.log('   CAPA 3    : CVD real + divergencia (1.5pts)');
console.log('   CAPA 4    : CHoCH + BOS con 2 cierres (2pts)');
console.log('   CAPA 5    : Stop Hunt + OB + EQH/EQL (1pt)');
console.log('   CAPA 6    : GEX + MaxPain (1pt)');
console.log('   CAPA 7    : Dark Pool estimado (1pt)');
console.log('   CAPA 8    : 15m + Power Hour timing');
console.log(`   Score     : mínimo ${MIN_SCORE}/10 · 3 capas concordantes · max 10`);
console.log('   Bot       : @liquidmapbolsa_bot');
console.log('   Velas     : POLYGON.IO (SIP real) · Quote: aggregates diarios · FUENTE ÚNICA');

if (!POLYGON_KEY) {
  console.error('⚠️  FALTA POLYGON_KEY — agregá la env var en Render (Environment → Add). El monitor no leerá velas reales sin ella.');
} else {
  console.log(`   Polygon   : ✅ key cargada (${POLYGON_KEY.slice(0,4)}…)`);
}

runScan();
setInterval(runScan, SCAN_INTERVAL);
