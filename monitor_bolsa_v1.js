// ============================================================
//  monitor_bolsa.js — LiquidMap PRO · BOLSA v6
//  Sistema Neuronal Institucional — SINCRONIZADO con Mapa v6
//
//  CAPA 1 — SUPERTREND JUEZ (3pts) — igual al mapa v6
//  CAPA 2 — POC / VWAP (1.5pts)
//  CAPA 3 — CVD real + divergencia (1.5pts)
//  CAPA 4 — CHoCH + BOS (2pts) — 2 cierres confirmados
//  CAPA 5 — Stop Hunt + Order Blocks + EQH/EQL (1pt)
//  CAPA 6 — Régimen de Volatilidad (REAL, contexto · 0pts al score)
//  CAPA 7 — Dark Pool DESACTIVADA (requiere endpoint Trades · Developer $79)
//  CAPA 8 — Confirmación 15m + Power Hour timing
//
//  GEX/MaxPain: N/D — requieren cadena de opciones; NO afectan el score.
//  TP/SL: ESTRUCTURALES (POC/VWAP/VAH-VAL/pools/máx-mín/proy) — idéntico al mapa.
//  El score nace SOLO de capas con datos reales de Polygon SIP. Cero sintético.
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

// Factor ATR según timeframe — usado solo como relleno de TP cuando faltan niveles reales
const TF_ATR_FACTOR = { '5':0.10, '15':0.18, '60':0.35, '240':0.60, 'D':1.00 };
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
      return realATR * (0.6 + factor * 0.4);
    }
  }
  // Fallback estático
  const basePct = ATR_PCT[ticker] || 0.015;
  const factor  = TF_ATR_FACTOR[currentTF || '240'] || 0.60;
  return price * basePct * factor;
}

// ── TP/SL ESTRUCTURALES (idéntico al mapa v6) ────────────────
// TP anclados a niveles REALES: VWAP, POC, VAH/VAL, pools de liquidez (equal H/L),
// máx/mín del día, proyección medida del impulso (BOS). ATR solo de relleno.
function computeStructuralTargets(price, dir, vp, zones, quote, struct, atr) {
  if ((dir !== 'BUY' && dir !== 'SELL') || !price || !atr) return null;
  const isBuy = dir === 'BUY';
  const cand = [];
  // Distancia mínima del TP al precio: que NO se pegue (evita el R:R invertido, ej. TP1 a +0.04%).
  // El "Máx/Mín día" que cae justo en el precio queda descartado; entra el siguiente nivel real o ATR.
  const minTP = Math.max(atr * 0.8, price * 0.004);
  const add = (p, label) => { if (p != null && isFinite(p) && (isBuy ? p > price : p < price) && Math.abs(p - price) >= minTP) cand.push({ price: p, label }); };
  if (vp) { add(vp.vwap, 'VWAP'); add(vp.poc, 'POC'); add(isBuy ? vp.vah : vp.val, isBuy ? 'VAH' : 'VAL'); }
  // Pool de liquidez del lado del objetivo (equal highs/lows)
  if (zones && zones.nearZones) {
    const poolSide = isBuy ? 'above' : 'below';
    const pool = zones.nearZones.find(z => z.side === poolSide && (z.type === 'EQH' || z.type === 'EQL'));
    if (pool) add(pool.price, 'Pool liq.');
  }
  if (quote) add(isBuy ? quote.h : quote.l, isBuy ? 'Máx día' : 'Mín día');
  // Proyección medida (measured move): rango de la sesión del día proyectado desde el precio
  if (quote && quote.h != null && quote.l != null && quote.h > quote.l) {
    const rng = quote.h - quote.l;
    add(isBuy ? price + rng : price - rng, 'Proy. BOS');
  }
  cand.sort((a, b) => isBuy ? a.price - b.price : b.price - a.price);
  const uniq = [];
  for (const c of cand) { if (!uniq.some(u => Math.abs(u.price - c.price) / price < 0.0015)) uniq.push(c); }
  // Relleno con proyección ATR si faltan niveles para 3 TP
  const atrMults = [1.0, 1.8, 2.6]; let mi = 0;
  while (uniq.length < 3 && mi < atrMults.length) {
    const proj = isBuy ? price + atr * atrMults[mi] : price - atr * atrMults[mi];
    if (!uniq.some(u => Math.abs(u.price - proj) / price < 0.0015)) uniq.push({ price: proj, label: 'Proy. ATR' });
    mi++;
  }
  uniq.sort((a, b) => isBuy ? a.price - b.price : b.price - a.price); // re-orden tras relleno (evita TP3<TP2)
  const tps = uniq.slice(0, 3);
  // SL: invalidación estructural del lado opuesto + buffer ATR, con distancia mínima
  const slCand = [];
  const addSL = (p, label) => { if (p != null && isFinite(p) && (isBuy ? p < price : p > price)) slCand.push({ price: p, label }); };
  if (zones && zones.nearZones) {
    const slSide = isBuy ? 'below' : 'above';
    const slPool = zones.nearZones.find(z => z.side === slSide);
    if (slPool) addSL(slPool.price, 'Pool');
  }
  addSL(isBuy ? (vp && vp.val) : (vp && vp.vah), isBuy ? 'VAL' : 'VAH');
  addSL(isBuy ? (quote && quote.l) : (quote && quote.h), isBuy ? 'Mín día' : 'Máx día');
  slCand.sort((a, b) => isBuy ? b.price - a.price : a.price - b.price);
  const buffer = atr * 0.4;
  let slPrice, slLabel;
  if (slCand.length) { slPrice = isBuy ? slCand[0].price - buffer : slCand[0].price + buffer; slLabel = slCand[0].label; }
  else { slPrice = isBuy ? price - atr * 1.2 : price + atr * 1.2; slLabel = 'ATR'; }
  const minSL = atr * 0.6;
  if (isBuy && (price - slPrice) < minSL) slPrice = price - minSL;
  if (!isBuy && (slPrice - price) < minSL) slPrice = price + minSL;
  return { tps, sl: { price: slPrice, label: slLabel } };
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
  // CALIBRADO = mapa HTML v6 = Pine: ATR Wilder (RMA) + giro contra banda de la vela PREVIA.
  // Mismo cálculo en monitor, mapa y TradingView → misma dirección y mismo cruce.
  if (!candles || candles.length < period + 1) return null;
  // True Range
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) tr.push(candles[i].h - candles[i].l);
    else tr.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i-1].c),
      Math.abs(candles[i].l - candles[i-1].c)
    ));
  }
  // ATR Wilder (RMA), idéntico a ta.atr() del Pine
  const atrArr = new Array(candles.length).fill(NaN);
  let atrPrev = 0, seed = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < period) { seed += tr[i]; if (i === period - 1) { atrPrev = seed / period; atrArr[i] = atrPrev; } }
    else { atrPrev = (atrPrev * (period - 1) + tr[i]) / period; atrArr[i] = atrPrev; }
  }
  const result = [];
  let finalUpperPrev = 0, finalLowerPrev = 0, trendPrev = 1, started = false;
  for (let i = period - 1; i < candles.length; i++) {
    const atr = atrArr[i];
    if (isNaN(atr)) continue;
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const upper = hl2 + multiplier * atr;
    const lower = hl2 - multiplier * atr;
    let finalUpper, finalLower, trend;
    if (!started) {
      finalUpper = upper; finalLower = lower; trend = candles[i].c >= hl2 ? 1 : -1; started = true;
    } else {
      finalUpper = (upper < finalUpperPrev || candles[i-1].c > finalUpperPrev) ? upper : finalUpperPrev;
      finalLower = (lower > finalLowerPrev || candles[i-1].c < finalLowerPrev) ? lower : finalLowerPrev;
      trend = candles[i].c > finalUpperPrev ? 1 : candles[i].c < finalLowerPrev ? -1 : trendPrev;
    }
    result.push({ value: trend === 1 ? finalLower : finalUpper, trend });
    finalUpperPrev = finalUpper; finalLowerPrev = finalLower; trendPrev = trend;
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
// Velas de la SESIÓN actual (reset diario, como el VWAP de TradingView).
// Compara la fecha en horario de Nueva York del último candle.
function currentSessionCandles(candles) {
  if (!candles || !candles.length) return [];
  const etDate = ts => new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const lastDate = etDate(candles[candles.length - 1].t);
  return candles.filter(c => etDate(c.t) === lastDate);
}

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
    if (price > vp.vwap) signals.push({ layer:2, dir:'BUY',  weight:1.5, label:`Precio sobre VWAP (${fmt(vp.vwap,price)}) — alcista intradía` });
    else                 signals.push({ layer:2, dir:'SELL', weight:1.5, label:`Precio bajo VWAP (${fmt(vp.vwap,price)}) — bajista intradía` });

    if (price > vp.poc)  signals.push({ layer:2, dir:'BUY',  weight:0.5, label:`Precio sobre POC (${fmt(vp.poc,price)})` });
    else                 signals.push({ layer:2, dir:'SELL', weight:0.5, label:`Precio bajo POC (${fmt(vp.poc,price)})` });

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
  // TP/SL ESTRUCTURALES (niveles reales: POC/VWAP/VAH-VAL/pools/máx-mín día/proy). ATR solo relleno.
  const zones4H = detectLiquidityZones(candles4H, price);
  const tgt = computeStructuralTargets(price, result.direction, result.vp, zones4H, quote, result.struct4H, atr);
  const sl  = tgt ? tgt.sl.price : (isBuy ? price - atr*1.5 : price + atr*1.5);
  const slLb  = tgt ? ' · ' + tgt.sl.label : '';
  const tp1 = tgt && tgt.tps[0] ? tgt.tps[0].price : null;
  const tp2 = tgt && tgt.tps[1] ? tgt.tps[1].price : null;
  const tp3 = tgt && tgt.tps[2] ? tgt.tps[2].price : null;
  const t1Lb = tgt && tgt.tps[0] ? ' · ' + tgt.tps[0].label : '';
  const t2Lb = tgt && tgt.tps[1] ? ' · ' + tgt.tps[1].label : '';
  const t3Lb = tgt && tgt.tps[2] ? ' · ' + tgt.tps[2].label : '';

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
  const escHTML  = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const confList  = result.confluences.map(c => `  • ${escHTML(c)}`).join('\n');
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

🛑 SL:  ${fmt(sl,price)}${slLb}
✅ TP1: ${tp1!=null?fmt(tp1,price)+t1Lb:'—'} · cerrar 50%
✅ TP2: ${tp2!=null?fmt(tp2,price)+t2Lb:'—'} · cerrar 30%
🔶 TP3: ${tp3!=null?fmt(tp3,price)+t3Lb:'—'} · dejar 20%
📌 Al llegar a TP1 → mover SL a breakeven

⚡ LiquidMap PRO · Bolsa v6`;
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
    // VWAP/POC ANCLADOS A LA SESIÓN (reset diario, como TradingView): se calculan
    // sobre las velas de 15m de la sesión actual — NO sobre 60 velas 4H (~1.5 meses).
    // Esto evita el VWAP a la deriva (ej. QQQ daba VWAP a −$141 del precio).
    let vpWindow = currentSessionCandles(candles15m);
    if (vpWindow.length < 6) vpWindow = (candles15m.length ? candles15m : candles4H).slice(-26); // respaldo: ~1 sesión
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

    console.log(`[${ticker}] ✅ SEÑAL BOLSA v6: ${result.direction} score=${result.score}/10`);
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

  console.log(`\n[BOLSA SCAN v6] ${now} · ${session.sessionName} ${session.powerHour ? `· ${session.powerHour.name}` : ''}`);

  for (const ticker of STOCK_TICKERS) {
    await scanTicker(ticker, session);
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('[BOLSA SCAN v6] Completo.');
}

// ── ARRANQUE ──────────────────────────────────────────────────
console.log('📊 LiquidMap PRO Monitor BOLSA v6 — Sincronizado con Mapa v6');
console.log(`   Tickers   : ${STOCK_TICKERS.join(', ')}`);
console.log('   CAPA 1    : SuperTrend JUEZ (3pts)');
console.log('   CAPA 2    : POC / VWAP (1.5pts)');
console.log('   CAPA 3    : CVD real + divergencia (1.5pts)');
console.log('   CAPA 4    : CHoCH + BOS con 2 cierres (2pts)');
console.log('   CAPA 5    : Stop Hunt + OB + EQH/EQL (1pt)');
console.log('   CAPA 6    : Régimen de Volatilidad (REAL · contexto, 0pts al score)');
console.log('   CAPA 7    : Dark Pool — DESACTIVADA (requiere endpoint Trades · Developer $79)');
console.log('   CAPA 8    : 15m + Power Hour timing');
console.log('   GEX/MaxPain: N/D — requieren cadena de opciones (no afectan el score)');
console.log('   TP/SL     : ESTRUCTURALES (POC/VWAP/VAH-VAL/pools/máx-mín/proy) — idéntico al mapa v6');
console.log(`   Score     : mínimo ${MIN_SCORE}/10 · 3 capas concordantes · max 10 · SOLO capas reales`);
console.log('   Bot       : @liquidmapbolsa_bot');
console.log('   Velas     : POLYGON.IO (SIP real) · Quote: aggregates diarios · FUENTE ÚNICA');

if (!POLYGON_KEY) {
  console.error('⚠️  FALTA POLYGON_KEY — agregá la env var en Render (Environment → Add). El monitor no leerá velas reales sin ella.');
} else {
  console.log(`   Polygon   : ✅ key cargada (${POLYGON_KEY.slice(0,4)}…)`);
}

runScan();
setInterval(runScan, SCAN_INTERVAL);
