// ============================================================
//  monitor_bolsa_v1.js — LiquidMap PRO · BOLSA
//  Sistema Neuronal Institucional — Stocks Edition
//
//  CAPA 1 — VOLUME PROFILE: POC, VAH, VAL, HVN
//  CAPA 2 — CVD + DELTA: compra/venta agresiva institucional
//  CAPA 3 — ESTRUCTURA: CHoCH, BOS, swing highs/lows
//  CAPA 4 — LIQUIDEZ: Stop Hunt, EQH/EQL, Order Blocks
//  CAPA 5 — GEX + MAX PAIN + OPTIONS FLOW (bolsa = opciones)
//  CAPA 6 — DARK POOL + VWAP + sesión NY
//  CAPA 7 — CONFIRMACIÓN 15m + timing Power Hour
//
//  Reglas:
//  - Solo opera en sesión NY (9:30–16:00 ET) y Pre-Market relevante
//  - Score mínimo 6/10 · mínimo 3 capas concordantes
//  - Power Hour (9:30–10:30 y 15:00–16:00 ET) = señales prioritarias
//  - Silencio en Lunch (11:30–13:30 ET) — demasiado ruido
//  - Bot separado: @liquidmapbolsa_bot
// ============================================================

'use strict';
const fetch = require('node-fetch');

// ── CONFIG ──────────────────────────────────────────────────
const TELEGRAM_TOKEN_BOLSA = '8278713898:AAGGaBAhmUTDnqjBxyv3YVZAtYiwlsEA0J4';
const CHAT_IDS             = ['1218461753', '1373309702'];
const FINNHUB_TOKEN        = 'd0qsf2hr01qgsn5hm2k0d0qsf2hr01qgsn5hm2kg';

// Tickers activos — agregar aquí para activar nuevos
const STOCK_TICKERS = [
  'SPY', 'QQQ', 'NVDA', 'AAPL', 'AMZN',
  'TSLA', 'MSFT', 'META', 'GOOG', 'AMD',
  'IWM', 'DIA', 'WMT'
];

// ATR estimado por ticker (% del precio)
const ATR_PCT = {
  SPY: 0.008, QQQ: 0.010, NVDA: 0.025, AAPL: 0.012,
  AMZN: 0.015, TSLA: 0.030, MSFT: 0.012, META: 0.018,
  GOOG: 0.013, AMD: 0.025, IWM: 0.010, DIA: 0.007, WMT: 0.010,
};

const MIN_SCORE    = 6;       // score mínimo 6/10
const COOLDOWN_MS  = 4 * 60 * 60 * 1000; // 4H cooldown
const SCAN_INTERVAL = 5 * 60 * 1000;     // scan cada 5 min

// ── ESTADO NEURONAL ─────────────────────────────────────────
const STATE = {};
function getState(ticker) {
  if (!STATE[ticker]) {
    STATE[ticker] = {
      lastSignalDir: null, lastSignalTs: 0,
      lastStructure: 'NEUTRAL', lastCVDDir: 'neutral',
    };
  }
  return STATE[ticker];
}

// ── HELPERS ──────────────────────────────────────────────────
function fmt(n, ref) {
  if (isNaN(+n)) return '—';
  if (ref >= 1000) return (+n).toFixed(2);
  if (ref >= 100)  return (+n).toFixed(2);
  return (+n).toFixed(3);
}

function getATR(ticker, price) {
  return price * (ATR_PCT[ticker] || 0.015);
}

// ── SESIÓN NY — NÚCLEO DEL MONITOR DE BOLSA ─────────────────
function getNYSession() {
  const now = new Date();
  // Convertir a ET (UTC-4 en verano, UTC-5 en invierno)
  const etOffset = isDST(now) ? -4 : -5;
  const etHour = (now.getUTCHours() + etOffset + 24) % 24;
  const etMin  = now.getUTCMinutes();
  const etTime = etHour + etMin / 60;

  // Mercado cerrado — no tiene sentido monitorear stocks
  const marketOpen  = etTime >= 9.5  && etTime < 16;
  const preMarket   = etTime >= 4    && etTime < 9.5;
  const afterHours  = etTime >= 16   && etTime < 20;

  // Power Hours — ventanas institucionales en bolsa
  const powerHourOpen  = etTime >= 9.5  && etTime < 10.5;  // mejor momento del día
  const lunchZone      = etTime >= 11.5 && etTime < 13.5;  // evitar — ruido máximo
  const powerHourClose = etTime >= 15   && etTime < 16;    // segunda mejor ventana

  let sessionName = 'Cerrado';
  if (marketOpen)  sessionName = 'Sesión NY';
  if (preMarket)   sessionName = 'Pre-Market';
  if (afterHours)  sessionName = 'After-Hours';

  let powerHour = null;
  if (powerHourOpen)  powerHour = { name: '🔥 Power Hour Open', weight: 1.6 };
  if (powerHourClose) powerHour = { name: '🔥 Power Hour Close', weight: 1.4 };

  return {
    etHour, etTime, marketOpen, preMarket, afterHours,
    lunchZone, powerHour, sessionName,
    shouldScan: marketOpen || (preMarket && etTime >= 9), // escanear desde 9am ET
  };
}

function isDST(date) {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return Math.max(jan, jul) !== date.getTimezoneOffset();
}

// ── FETCH FINNHUB — DATOS REALES ──────────────────────────────
async function fetchFinnhubCandles(symbol, resolution, from, to) {
  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&token=${FINNHUB_TOKEN}`;
    const r   = await fetch(url, { timeout: 8000 });
    const d   = await r.json();
    if (!d || d.s === 'no_data' || !d.c) return [];
    return d.t.map((t, i) => ({
      t: t * 1000, o: d.o[i], h: d.h[i], l: d.l[i],
      c: d.c[i], v: d.v[i],
    }));
  } catch { return []; }
}

async function fetchCandles(symbol, tf) {
  const now  = Math.floor(Date.now() / 1000);
  let resolution, from;

  switch(tf) {
    case '1D': resolution = 'D';  from = now - 86400 * 120; break; // 120 días
    case '4H': resolution = '60'; from = now - 3600 * 200;  break; // ~200 velas H → agrupa 4
    case '1H': resolution = '60'; from = now - 3600 * 100;  break; // 100 horas
    case '15m': resolution = '15'; from = now - 900 * 100;  break; // 100 velas 15m
    default:    resolution = '60'; from = now - 3600 * 100;
  }

  const raw = await fetchFinnhubCandles(symbol, resolution, from, now);

  // Para 4H agrupar velas 1H de a 4
  if (tf === '4H' && resolution === '60') {
    return groupCandles(raw, 4);
  }
  return raw;
}

function groupCandles(candles, n) {
  const grouped = [];
  for (let i = 0; i < candles.length; i += n) {
    const group = candles.slice(i, i + n);
    if (!group.length) continue;
    grouped.push({
      t: group[0].t,
      o: group[0].o,
      h: Math.max(...group.map(c => c.h)),
      l: Math.min(...group.map(c => c.l)),
      c: group[group.length - 1].c,
      v: group.reduce((a, c) => a + c.v, 0),
    });
  }
  return grouped;
}

// Quote en tiempo real
async function fetchQuote(symbol) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_TOKEN}`;
    const r   = await fetch(url, { timeout: 6000 });
    return await r.json();
  } catch { return null; }
}

// ── CAPA 1: VOLUME PROFILE ────────────────────────────────────
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

  const vah = mn + hi * bs + bs;
  const val = mn + lo * bs;

  // VWAP estimado (promedio ponderado por volumen)
  let sumPV = 0, sumV = 0;
  for (const c of candles) {
    const typical = (c.h + c.l + c.c) / 3;
    sumPV += typical * c.v;
    sumV  += c.v;
  }
  const vwap = sumV > 0 ? sumPV / sumV : poc;

  return { poc, vah, val, vwap, profile, min: mn, max: mx, binSize: bs };
}

// ── CAPA 2: CVD + DELTA ───────────────────────────────────────
function calcCVD(candles) {
  let cvd = 0, buyVol = 0, sellVol = 0;
  const deltas = [];
  for (const c of candles) {
    const bv = c.c >= c.o ? c.v * 0.6 : c.v * 0.4; // estimación sin datos de tape
    const sv = c.v - bv;
    buyVol  += bv;
    sellVol += sv;
    cvd     += (bv - sv);
    deltas.push(bv - sv);
  }
  const total  = buyVol + sellVol || 1;
  const buyPct = (buyVol / total) * 100;

  // Divergencia CVD vs precio
  const recent   = candles.slice(-8);
  const priceDir = recent[recent.length - 1].c > recent[0].c ? 'up' : 'down';
  const cvdRecent = deltas.slice(-8).reduce((a, b) => a + b, 0);
  const cvdDir    = cvdRecent > 0 ? 'up' : 'down';
  const divergence = priceDir !== cvdDir;

  return {
    cvd, buyVol, sellVol, buyPct, divergence, priceDir, cvdDir,
    bullish: cvd > 0 && buyPct > 51 && !divergence,
    bearish: cvd < 0 && buyPct < 49 && !divergence,
  };
}

// ── CAPA 3: ESTRUCTURA CHoCH + BOS ───────────────────────────
function detectStructure(candles) {
  if (candles.length < 30) return null;
  const lookback  = 5;
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
  const lastClose = candles[candles.length - 1].c;
  const prevClose = candles[candles.length - 2].c;

  if (lastClose < prevLow.price && prevClose < prevLow.price * 1.003)
    return { type: 'CHOCH_SELL', label: '⚡ CHoCH BAJISTA', desc: 'Cambio de carácter — reversión bajista', priority: 10 };
  if (lastClose > prevHigh.price && prevClose > prevHigh.price * 0.997)
    return { type: 'CHOCH_BUY', label: '⚡ CHoCH ALCISTA', desc: 'Cambio de carácter — reversión alcista', priority: 10 };
  if (lastClose < lastLow.price && lastHigh.price < prevHigh.price)
    return { type: 'BOS_SELL', label: '📉 BOS BAJISTA', desc: 'Continuación bajista confirmada', priority: 7 };
  if (lastClose > lastHigh.price && lastLow.price > prevLow.price)
    return { type: 'BOS_BUY', label: '📈 BOS ALCISTA', desc: 'Continuación alcista confirmada', priority: 7 };

  return null;
}

// ── CAPA 4: STOP HUNT ─────────────────────────────────────────
function detectStopHunt(candles) {
  if (candles.length < 5) return null;
  const c    = candles[candles.length - 1];
  const body  = Math.abs(c.c - c.o);
  const range = c.h - c.l;
  if (!range || body < range * 0.01) return null;

  const upperWick = c.h - Math.max(c.o, c.c);
  const lowerWick = Math.min(c.o, c.c) - c.l;

  const isBearSH = upperWick >= body * 2.5 && upperWick / range >= 0.45;
  const isBullSH = lowerWick >= body * 2.5 && lowerWick / range >= 0.45;
  if (!isBullSH && !isBearSH) return null;

  const prevHigh = Math.max(...candles.slice(-10, -1).map(x => x.h));
  const prevLow  = Math.min(...candles.slice(-10, -1).map(x => x.l));

  if (isBullSH && c.l < prevLow * 0.999)
    return { type: 'SH_BUY',  strength: lowerWick / range, brokeLevel: prevLow };
  if (isBearSH && c.h > prevHigh * 1.001)
    return { type: 'SH_SELL', strength: upperWick / range, brokeLevel: prevHigh };
  if (isBullSH) return { type: 'SH_BUY',  strength: lowerWick / range * 0.7, brokeLevel: null };
  if (isBearSH) return { type: 'SH_SELL', strength: upperWick / range * 0.7, brokeLevel: null };
  return null;
}

// ── CAPA 4b: ZONAS DE LIQUIDEZ + ORDER BLOCKS ────────────────
function detectLiquidityZones(candles, price) {
  const zones = [], tolerance = price * 0.002;
  const highs = candles.slice(-50).map(c => c.h);
  const lows  = candles.slice(-50).map(c => c.l);

  // Equal Highs / Equal Lows
  const hc = {}, lc = {};
  highs.forEach(h => { const k = Math.round(h / tolerance); hc[k] = (hc[k]||0)+1; });
  lows.forEach(l  => { const k = Math.round(l / tolerance); lc[k] = (lc[k]||0)+1; });

  Object.entries(hc).forEach(([k, n]) => {
    if (n >= 2) zones.push({ price: +k * tolerance, type: 'EQH',
      side: +k * tolerance > price ? 'above' : 'below',
      strength: Math.min(1, n/3), label: 'Equal Highs' });
  });
  Object.entries(lc).forEach(([k, n]) => {
    if (n >= 2) zones.push({ price: +k * tolerance, type: 'EQL',
      side: +k * tolerance < price ? 'below' : 'above',
      strength: Math.min(1, n/3), label: 'Equal Lows' });
  });

  // Order Blocks
  for (let i = candles.length - 20; i < candles.length - 3; i++) {
    if (i < 0) continue;
    const c = candles[i], n1 = candles[i+1], n2 = candles[i+2];
    if (c.c < c.o && n1.c > n1.o && n2.c > n2.o && (n2.h - c.l)/price > 0.004)
      zones.push({ price: c.l, type: 'OB_BUY', side: 'below', strength: (n2.h-c.l)/price*8, label: 'Order Block Alcista' });
    if (c.c > c.o && n1.c < n1.o && n2.c < n2.o && (c.h - n2.l)/price > 0.004)
      zones.push({ price: c.h, type: 'OB_SELL', side: 'above', strength: (c.h-n2.l)/price*8, label: 'Order Block Bajista' });
  }

  const nearZones = zones
    .filter(z => Math.abs(z.price - price)/price < 0.02)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));

  return { zones, nearZones };
}

// ── CAPA 5: GEX ESTIMADO + MAX PAIN ──────────────────────────
// Sin acceso a datos de opciones reales, estimamos con precio vs VWAP/POC
// y niveles psicológicos — lógica idéntica al mapa HTML
function estimateGEX(price, vp, candles) {
  if (!vp) return { gexNet: 0, regime: 'NEUTRAL', callWall: null, putWall: null };

  // GEX estimado: en bolsa el precio tiende a "pinear" strikes redondos cerca del cierre
  // Aproximar Call Wall (resistencia gamma) y Put Wall (soporte gamma)
  const roundUp   = Math.ceil(price / 5) * 5;  // siguiente nivel redondo
  const roundDown = Math.floor(price / 5) * 5; // nivel redondo inferior

  // Régimen GEX: positivo (precio se mueve lento) vs negativo (movimientos amplificados)
  // Estimamos por volatilidad intraday de las últimas velas
  const ranges  = candles.slice(-10).map(c => (c.h - c.l) / c.c);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const regime   = avgRange < 0.008 ? 'POSITIVO (bajo vol)' : 'NEGATIVO (alto vol)';
  const gexNet   = avgRange < 0.008 ? 1 : -1;

  // Max Pain estimado — nivel psicológico más cercano con más "gravedad"
  // En acciones es el nivel redondo más cercano al precio
  const maxPain = Math.round(price / 10) * 10;

  return { gexNet, regime, callWall: roundUp, putWall: roundDown, maxPain };
}

// ── CAPA 6: DARK POOL ESTIMADO ────────────────────────────────
// Detecta divergencia volumen/precio — huella institucional
function estimateDarkPool(candles, price) {
  if (candles.length < 10) return null;

  const vols    = candles.map(c => c.v);
  const avgVol  = vols.slice(0, -3).reduce((a, b) => a + b, 0) / (vols.length - 3);
  const recent  = candles.slice(-3);

  // Dark Pool: vela con volumen anómalamente alto respecto al precio
  for (const c of recent) {
    if (c.v < avgVol * 2.5) continue; // no es anómalo
    const dir = c.c > c.o ? 'BUY' : 'SELL';
    // Señal DP: volumen muy alto con cuerpo pequeño = acumulación/distribución oculta
    const bodyPct = Math.abs(c.c - c.o) / (c.h - c.l);
    if (bodyPct < 0.3) {
      return { direction: 'NEUTRAL', volumeRatio: c.v/avgVol, label: '🌑 DP: acumulación/distribución oculta' };
    }
    return { direction: dir, volumeRatio: c.v/avgVol, label: `🌑 Dark Pool ${dir === 'BUY' ? 'alcista' : 'bajista'} x${(c.v/avgVol).toFixed(1)}` };
  }
  return null;
}

// ── MOTOR NEURONAL BOLSA ─────────────────────────────────────
function evaluateAllLayers({ price, candles4H, candles1H, candles15m, vp, session }) {
  const signals = [];

  // ── CAPA 1: POC + VWAP + VALUE AREA ────────────────────
  if (vp) {
    if (price > vp.poc) signals.push({ layer:1, dir:'BUY',  weight:1,   label:`Precio > POC (${fmt(vp.poc,price)})` });
    else                signals.push({ layer:1, dir:'SELL', weight:1,   label:`Precio < POC (${fmt(vp.poc,price)})` });

    if (price > vp.vwap) signals.push({ layer:1, dir:'BUY',  weight:1.5, label:`Precio > VWAP (${fmt(vp.vwap,price)}) — alcista intradía` });
    else                 signals.push({ layer:1, dir:'SELL', weight:1.5, label:`Precio < VWAP (${fmt(vp.vwap,price)}) — bajista intradía` });

    if (price > vp.vah) signals.push({ layer:1, dir:'SELL', weight:0.5, label:'Sobre VAH — sobrecomprado, resistencia' });
    else if (price < vp.val) signals.push({ layer:1, dir:'BUY', weight:0.5, label:'Bajo VAL — sobrevendido, soporte' });
  }

  // ── CAPA 2: CVD ─────────────────────────────────────────
  const cvd4H = calcCVD(candles4H);
  const cvd1H = calcCVD(candles1H);

  if (cvd4H.bullish) signals.push({ layer:2, dir:'BUY',  weight:1.5, label:`CVD 4H positivo — ${cvd4H.buyPct.toFixed(0)}% compra institucional` });
  if (cvd4H.bearish) signals.push({ layer:2, dir:'SELL', weight:1.5, label:`CVD 4H negativo — ${(100-cvd4H.buyPct).toFixed(0)}% venta institucional` });

  if (cvd4H.divergence) {
    const divDir = cvd4H.priceDir === 'up' ? 'SELL' : 'BUY';
    signals.push({ layer:2, dir:divDir, weight:2, label:`⚠️ Divergencia CVD — ${divDir==='SELL'?'distribución oculta':'acumulación oculta'}` });
  }

  if (cvd1H.bullish && cvd4H.bullish) signals.push({ layer:2, dir:'BUY',  weight:0.8, label:'CVD 1H confirma alcista' });
  if (cvd1H.bearish && cvd4H.bearish) signals.push({ layer:2, dir:'SELL', weight:0.8, label:'CVD 1H confirma bajista' });

  // ── CAPA 3: ESTRUCTURA ──────────────────────────────────
  const struct4H = detectStructure(candles4H);
  const struct1H = detectStructure(candles1H);

  if (struct4H) {
    const sDir = struct4H.type.includes('BUY') ? 'BUY' : 'SELL';
    signals.push({ layer:3, dir:sDir, weight: struct4H.type.includes('CHOCH')?3:2, label:`${struct4H.label} 4H` });
  }
  if (struct1H) {
    const sDir = struct1H.type.includes('BUY') ? 'BUY' : 'SELL';
    signals.push({ layer:3, dir:sDir, weight: struct1H.type.includes('CHOCH')?1.5:1, label:`${struct1H.label} 1H` });
  }

  // ── CAPA 4: STOP HUNT + LIQUIDEZ ───────────────────────
  const sh4H = detectStopHunt(candles4H);
  const sh1H = detectStopHunt(candles1H);
  if (sh4H) signals.push({ layer:4, dir: sh4H.type==='SH_BUY'?'BUY':'SELL', weight: sh4H.strength*2,
    label:`🎯 Stop Hunt ${sh4H.type==='SH_BUY'?'alcista':'bajista'} 4H` });
  if (sh1H) signals.push({ layer:4, dir: sh1H.type==='SH_BUY'?'BUY':'SELL', weight: sh1H.strength*1.2,
    label:`🎯 SH ${sh1H.type==='SH_BUY'?'alcista':'bajista'} 1H` });

  const liqData = detectLiquidityZones(candles4H, price);
  const nearSup = liqData.nearZones.find(z => z.side==='below' && z.strength>0.5);
  const nearRes = liqData.nearZones.find(z => z.side==='above' && z.strength>0.5);
  if (nearSup) signals.push({ layer:4, dir:'BUY',  weight:nearSup.strength, label:`${nearSup.label} soporte en ${fmt(nearSup.price,price)}` });
  if (nearRes) signals.push({ layer:4, dir:'SELL', weight:nearRes.strength, label:`${nearRes.label} resistencia en ${fmt(nearRes.price,price)}` });

  // ── CAPA 5: GEX + MAX PAIN ──────────────────────────────
  const gex = estimateGEX(price, vp, candles4H);
  if (gex.gexNet < 0) signals.push({ layer:5, dir:'BUY',  weight:0.8, label:`GEX ${gex.regime} — movimientos amplificados, oportunidad direccional` });
  if (gex.putWall && price > gex.putWall) signals.push({ layer:5, dir:'BUY',  weight:0.5, label:`Precio sobre Put Wall (${fmt(gex.putWall,price)}) — soporte gamma` });
  if (gex.callWall && price < gex.callWall) signals.push({ layer:5, dir:'SELL', weight:0.5, label:`Precio bajo Call Wall (${fmt(gex.callWall,price)}) — resistencia gamma` });

  // ── CAPA 6: DARK POOL ───────────────────────────────────
  const dp = estimateDarkPool(candles4H, price);
  if (dp && dp.direction !== 'NEUTRAL') {
    signals.push({ layer:6, dir: dp.direction, weight: Math.min(2, dp.volumeRatio/3), label: dp.label });
  }

  // ── CAPA 7: CONFIRMACIÓN 15m + POWER HOUR ──────────────
  const cvd15m = calcCVD(candles15m);
  const sh15m  = detectStopHunt(candles15m);
  if (cvd15m.bullish) signals.push({ layer:7, dir:'BUY',  weight:0.5, label:'CVD 15m alcista — momentum' });
  if (cvd15m.bearish) signals.push({ layer:7, dir:'SELL', weight:0.5, label:'CVD 15m bajista — momentum' });
  if (sh15m) signals.push({ layer:7, dir: sh15m.type==='SH_BUY'?'BUY':'SELL', weight:0.8, label:'SH 15m — timing de entrada' });

  // Power Hour pesa más
  if (session.powerHour) {
    const dir15 = cvd15m.bullish ? 'BUY' : cvd15m.bearish ? 'SELL' : null;
    if (dir15) signals.push({ layer:7, dir: dir15, weight: session.powerHour.weight - 1,
      label:`${session.powerHour.name} — ventana institucional activa` });
  }

  // ── SCORE FINAL ─────────────────────────────────────────
  let buyScore = 0, sellScore = 0;
  for (const sig of signals) {
    if (sig.dir === 'BUY')  buyScore  += sig.weight;
    if (sig.dir === 'SELL') sellScore += sig.weight;
  }

  let direction = 'NEUTRAL';
  if (buyScore > sellScore && Math.abs(buyScore-sellScore) >= 1.5) direction = 'BUY';
  if (sellScore > buyScore && Math.abs(buyScore-sellScore) >= 1.5) direction = 'SELL';

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
    cvd4H, struct4H, sh4H, gex, dp, vp,
  };
}

// ── MENSAJE TELEGRAM ─────────────────────────────────────────
function buildMessage(ticker, price, result, session, quote) {
  const isBuy  = result.direction === 'BUY';
  const atr    = getATR(ticker, price);
  const sl     = isBuy ? price - atr * 1.5 : price + atr * 1.5;
  const tp1    = isBuy ? price + atr * 2   : price - atr * 2;
  const tp2    = isBuy ? price + atr * 3   : price - atr * 3;
  const tp3    = isBuy ? price + atr * 5   : price - atr * 5;

  const arrow   = isBuy ? '▲ BUY — COMPRA 🟢' : '▼ SELL — VENTA 🔴';
  const quality = result.score >= 8 ? '🔥 MÁXIMA CALIDAD'
                : result.score >= 6 ? '⭐ INSTITUCIONAL'
                : '✅ VÁLIDA';

  const phLine    = session.powerHour ? `\n⏰ ${session.powerHour.name}` : '';
  const structL   = result.struct4H   ? `\n🔷 ${result.struct4H.label} 4H` : '';
  const shLine    = result.sh4H       ? `\n🎯 Stop Hunt ${result.sh4H.type==='SH_BUY'?'alcista':'bajista'} 4H` : '';
  const dpLine    = result.dp && result.dp.direction !== 'NEUTRAL' ? `\n${result.dp.label}` : '';
  const gexLine   = result.gex ? `\nGEX: ${result.gex.regime} · MP: ${fmt(result.gex.maxPain,price)}` : '';
  const confList  = result.confluences.map(c => `  • ${c}`).join('\n');
  const changeStr = quote ? `${quote.dp > 0 ? '+' : ''}${((quote.c - quote.pc)/quote.pc*100).toFixed(2)}%` : '—';

  return `📊 <b>SEÑAL INSTITUCIONAL — BOLSA</b>
${arrow}

🎯 <b>${ticker}</b> · 4H${phLine}
💰 Precio: <b>${fmt(price,price)}</b> (${changeStr} hoy)
⭐ Score: ${result.score}/10 · ${quality}
🌏 Sesión: ${session.sessionName}

📊 <b>Confluencias:</b>
${confList}${structL}${shLine}${dpLine}${gexLine}

📈 CVD: ${result.cvd4H.cvd>0?'▲ Positivo':'▼ Negativo'} · ${result.cvd4H.buyPct.toFixed(0)}% Buy
📐 POC: ${result.vp?fmt(result.vp.poc,price):'—'} · VWAP: ${result.vp?fmt(result.vp.vwap,price):'—'}

🛑 SL:  ${fmt(sl,price)}
✅ TP1: ${fmt(tp1,price)} · R:R 1:2
✅ TP2: ${fmt(tp2,price)} · R:R 1:3
🔶 TP3: ${fmt(tp3,price)} · R:R 1:5

⚡ LiquidMap PRO · Bolsa v1`;
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

    const price = quote?.c || candles4H[candles4H.length - 1].c;
    const vp    = buildVolumeProfile(candles4H, 100);
    const result = evaluateAllLayers({ price, candles4H, candles1H, candles15m, vp, session });

    console.log(`[${ticker}] Dir=${result.direction} Score=${result.score}/10 BUY=${result.buyScore.toFixed(1)} SELL=${result.sellScore.toFixed(1)} Capas=${result.layersInDir.size}`);

    // REGLA 1: Sin dirección → silencio
    if (result.direction === 'NEUTRAL') return;

    // REGLA 2: Score mínimo (en Power Hour baja a 5)
    const minReq = session.powerHour ? 5 : MIN_SCORE;
    if (result.score < minReq) {
      console.log(`[${ticker}] Score ${result.score}/${minReq} insuficiente — silencio`);
      return;
    }

    // REGLA 3: Al menos 3 capas concordando
    if (result.layersInDir.size < 3) {
      console.log(`[${ticker}] Solo ${result.layersInDir.size} capas — necesita 3`);
      return;
    }

    // REGLA 4: Cooldown (se rompe si hay CHoCH)
    const hasChoch = result.struct4H?.type?.includes('CHOCH');
    const inCooldown = s.lastSignalDir === result.direction
                    && (Date.now() - s.lastSignalTs) < COOLDOWN_MS
                    && !hasChoch;
    if (inCooldown) {
      const h = ((COOLDOWN_MS - (Date.now() - s.lastSignalTs)) / 3600000).toFixed(1);
      console.log(`[${ticker}] Cooldown — ${h}h restantes`);
      return;
    }

    // ✅ DISPARAR
    console.log(`[${ticker}] ✅ SEÑAL BOLSA: ${result.direction} score=${result.score}/10`);
    const msg = buildMessage(ticker, price, result, session, quote);
    await sendTelegram(msg);

    s.lastSignalDir = result.direction;
    s.lastSignalTs  = Date.now();

  } catch(e) {
    console.error(`[${ticker}] Error:`, e.message);
  }
}

// ── LOOP PRINCIPAL ────────────────────────────────────────────
async function runScan() {
  const session = getNYSession();
  const now = new Date().toISOString();

  // Si el mercado está cerrado y no es pre-market relevante → no escanear bolsa
  if (!session.shouldScan) {
    console.log(`[BOLSA] ${now} · Mercado cerrado (${session.sessionName}) — esperando apertura NY`);
    return;
  }

  // Lunch zone — silencio completo
  if (session.lunchZone) {
    console.log(`[BOLSA] ${now} · Lunch zone (11:30–13:30 ET) — silencio, demasiado ruido`);
    return;
  }

  console.log(`\n[BOLSA SCAN] ${now} · ${session.sessionName} ${session.powerHour ? `· ${session.powerHour.name}` : ''}`);

  for (const ticker of STOCK_TICKERS) {
    await scanTicker(ticker, session);
    await new Promise(r => setTimeout(r, 1000)); // 1s entre tickers
  }

  console.log(`[BOLSA SCAN] Completo.`);
}

// ── ARRANQUE ──────────────────────────────────────────────────
console.log('📊 LiquidMap PRO Monitor BOLSA v1 — Sistema Neuronal Institucional');
console.log(`   Tickers  : ${STOCK_TICKERS.join(', ')}`);
console.log(`   Capas    : POC·VWAP·CVD·CHoCH·BOS·SH·GEX·MaxPain·DarkPool·OB`);
console.log(`   Sesión   : Solo NY (9:30–16:00 ET) · Sin Lunch (11:30–13:30)`);
console.log(`   Score    : mínimo ${MIN_SCORE}/10 · 3 capas concordantes`);
console.log(`   Power Hour: 9:30–10:30 y 15:00–16:00 ET ponderadas`);
console.log(`   Bot      : @liquidmapbolsa_bot`);

runScan();
setInterval(runScan, SCAN_INTERVAL);
