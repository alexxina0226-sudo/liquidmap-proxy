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

// ── ARCO BOSWAVES (CAPA 14) — módulo compartido bot/RADAR ──
// Port JS del "Arc VWAP Supertrend [BOSWaves]" (MPL 2.0, open source).
// Si el archivo no está en el repo, la capa se desactiva sola (sin crashear)
// y el resto del bot sigue idéntico — deploy seguro: subir AMBOS archivos.
let computeArc = null;
try { computeArc = require('./arc_boswaves.js').computeArc; }
catch (e) { console.log('⚠️ arc_boswaves.js no encontrado — CAPA 14 (Arco) desactivada. Subir arc_boswaves.js al repo para activarla.'); }

// ── OPCIONES: GEX (Black-Scholes) + Max Pain REALES (capa compartida con server/mapa) ──
// Misma capa que la ruta /alpaca-options-metrics → bot y mapa muestran lo MISMO.
// Si options_live.js no está en el repo, el bot sigue mostrando N/D (no crashea).
let getOptionsMetrics = null;
try { getOptionsMetrics = require('./options_live.js').getOptionsMetrics; }
catch (e) { console.log('⚠️ options_live.js no encontrado — GEX/Max Pain reales desactivados (muestra N/D). Subir options_live.js + options_metrics.js para activarlos.'); }

// ── CONFIG ──────────────────────────────────────────────────
const TELEGRAM_TOKEN_BOLSA = '8278713898:AAGGaBAhmUTDnqjBxyv3YVZAtYiwlsEA0J4';
const CHAT_IDS             = ['1218461753', '1373309702'];
const POLYGON_KEY          = process.env.POLYGON_KEY || ''; // velas + quote REALES (env var en Render)
// Polygon.io → Massive.com (30-oct-2025). api.polygon.io se apaga en 2026 ("Premature close").
// Base nueva api.massive.com (misma API/key). Override con POLYGON_BASE si cambia.
const POLYGON_BASE         = process.env.POLYGON_BASE || 'https://api.massive.com';
// Massive comprime las respuestas y node-fetch las corta ("Premature close").
// Fix probado: Accept-Encoding identity (sin compresión) + User-Agent navegador.
const POLYGON_HEADERS      = {
  'Accept': 'application/json',
  'Accept-Encoding': 'identity',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

// ── ALPACA SIP (reemplaza Polygon/Massive — real-time, sin delay 15min) ───────
// Keys server-side (Render Environment). feed=sip requiere Algo Trader Plus.
// Las funciones fetchPolygonCandles/fetchQuote conservan nombre/firma/forma de retorno;
// solo cambia la FUENTE adentro → cero cambios en los llamadores. Revert = restaurar backup.
const ALPACA_KEY_ID  = process.env.ALPACA_KEY_ID  || '';
const ALPACA_SECRET  = process.env.ALPACA_SECRET_KEY || '';
const ALPACA_DATA    = process.env.ALPACA_DATA_BASE || 'https://data.alpaca.markets';
const ALPACA_HEADERS = {
  'Accept': 'application/json',
  'Accept-Encoding': 'identity',
  'APCA-API-KEY-ID': ALPACA_KEY_ID,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
};
function alpacaTF(mult, span) {
  const unit = { minute: 'Min', hour: 'Hour', day: 'Day', week: 'Week', month: 'Month' }[String(span).toLowerCase()];
  return unit ? `${mult}${unit}` : null;
}

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
    STATE[ticker] = { lastSignalDir: null, lastSignalTs: 0, lastStructSig: null, lastCandle4H: null };
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
function computeStructuralTargets(price, dir, vp, zones, quote, struct, atr, atrTV) {
  if ((dir !== 'BUY' && dir !== 'SELL') || !price || !atr) return null;
  const isBuy = dir === 'BUY';
  // ── TP a la fórmula de TV/Pine: proyección ATR pura (igual que el indicador Pine v6) ──
  // TP1=3×ATR (R:R 1:2 con SL 1.5×ATR), TP2=4.5×ATR, TP3=7.5×ATR. atrTV = ATR(14) REAL del 4H
  // (mismo ta.atr(14) del Pine). Antes los TP se anclaban a estructura cercana (Máx/Mín día, pools)
  // y quedaban pegados (TP1 a +0.04%). Ahora calzan con los números de TV.
  const a14 = (atrTV && atrTV > 0) ? atrTV : atr;
  const sgn = isBuy ? 1 : -1;
  const tps = [
    { price: price + sgn * 3.0 * a14, label: 'Proy. ATR' },
    { price: price + sgn * 4.5 * a14, label: 'Proy. ATR' },
    { price: price + sgn * 7.5 * a14, label: 'Proy. ATR' },
  ];
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
  // ET REAL vía Intl(America/New_York) — correcto en CUALQUIER TZ de servidor.
  // FIX sesión: el isDST() de abajo usaba getTimezoneOffset(), que en el contenedor
  // UTC de Render daba SIEMPRE false → asumía -5 (invierno) en pleno verano (-4) →
  // corría toda la hora ET 1h atrás: mostraba "Pre-Market" con mercado abierto y
  // desfasaba Power Hour. Intl con America/New_York respeta el DST US solo. Una verdad.
  // (mismo patrón que ya usa resampleSession4H / currentSessionCandles)
  const now      = new Date();
  const _etP     = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  const _getET   = t => parseInt(_etP.find(x => x.type === t).value, 10);
  let etHour     = _getET('hour'); if (etHour === 24) etHour = 0;   // Intl puede dar 24 a medianoche
  const etMin    = _getET('minute');
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

// ── FETCH VELAS · ALPACA SIP (real-time) ───────────────────────
// Conserva firma (symbol, mult, span, fromDays) y forma de retorno {t(ms),o,h,l,c,v}
// del Polygon original → los llamadores (fetchCandles) no cambian. feed=sip · paginado.
async function fetchPolygonCandles(symbol, mult, span, fromDays) {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET) return [];
  const timeframe = alpacaTF(mult, span);
  if (!timeframe) return [];
  try {
    const fmtDate = d => new Date(d).toISOString().slice(0, 10);
    const to   = fmtDate(Date.now());
    const from = fmtDate(Date.now() - fromDays * 86400000);
    const out = [];
    let pageToken = '';
    for (let page = 0; page < 8; page++) {
      const qs = new URLSearchParams({
        timeframe, start: from, end: to, adjustment: 'split', feed: 'sip', sort: 'asc', limit: '10000',
      });
      if (pageToken) qs.set('page_token', pageToken);
      const url = `${ALPACA_DATA}/v2/stocks/${encodeURIComponent(symbol)}/bars?${qs.toString()}`;
      const r = await fetch(url, { headers: ALPACA_HEADERS, timeout: 12000 });
      const d = await r.json();
      if (!r.ok || d.error || d.message && !d.bars) return [];
      const bars = Array.isArray(d.bars) ? d.bars : [];
      for (const b of bars) out.push({ t: new Date(b.t).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
      pageToken = d.next_page_token || '';
      if (!pageToken) break;
    }
    return out;
  } catch { return []; }
}

async function fetchCandles(symbol, tf) {
  // TF → config nativa de Polygon (4H es mult=4/hour real, sin agrupar)
  let mult, span, days;
  switch (tf) {
    case '1D':  mult = 1; span = 'day';    days = 200; break;
    case '4H':  mult = 4; span = 'hour';   days = 300; break;
    case '1H':  mult = 1; span = 'hour';   days = 90;  break;
    case '15m': mult = 15; span = 'minute'; days = 45; break;  // +hist: el 4H de sesión se arma de acá (ROOT #5)
    case '15mXL': mult = 15; span = 'minute'; days = 120; break; // serie EXTENDIDA solo para el ARCO (necesita 110+ velas 4H de sesión); las capas validadas siguen usando 45d
    default:    mult = 1; span = 'hour';   days = 90;
  }
  return await fetchPolygonCandles(symbol, mult, span, days);
}

async function fetchQuote(symbol) {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET) return null;
  try {
    // Día actual + previo desde daily bars de Alpaca (sort=desc → [0]=más reciente, [1]=previo).
    const to   = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10); // 7d cubre findes/feriados
    const url  = `${ALPACA_DATA}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${from}&end=${to}&feed=sip&adjustment=split&sort=desc&limit=2`;
    const r    = await fetch(url, { headers: ALPACA_HEADERS, timeout: 12000 });
    const j    = await r.json();
    if (!r.ok || j.error || !Array.isArray(j.bars) || !j.bars.length) return null;
    const dayBar  = j.bars[0];                               // sesión más reciente (sort=desc)
    const prevBar = j.bars.length > 1 ? j.bars[1] : null;    // día previo
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
//  ADX / DMI — WILDER · IDÉNTICO A ta.dmi(14,14) DEL PINE v6.1
//  "El alma de TV": ADX ≥20 = tendencia válida · ≥30 = fuerte ·
//  <20 = LATERAL → la señal se BLOQUEA (= adx_ok del Pine, línea 602).
//  Caso de calibración: WMT 12-jun — Pine NEUTRAL (ADX 19, squeeze)
//  vs bot BUY 10/10. Con este filtro, ese 10/10 no se envía.
// ════════════════════════════════════════════════════════════
const ADX_LEN    = 14;   // = i_adx_len del Pine
const ADX_MIN    = 20;   // = i_adx_min del Pine (umbral lateral)
const ADX_FUERTE = 30;   // = umbral 🔥 FUERTE del Pine (sig_quality)

function calcADX(candles, len = ADX_LEN) {
  if (!candles || candles.length < len * 2 + 2) return null; // datos insuficientes → fail-open (no bloquea)
  // RMA (Wilder): seed = SMA(p), luego (prev*(p-1)+x)/p — igual ta.rma()
  const rma = (vals, p) => {
    const out = new Array(vals.length).fill(null);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      if (i < p) { sum += vals[i]; if (i === p - 1) out[i] = sum / p; }
      else out[i] = (out[i - 1] * (p - 1) + vals[i]) / p;
    }
    return out;
  };
  const trArr = [], pdmArr = [], ndmArr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
    trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - candles[i - 1].h, dn = candles[i - 1].l - l;
    pdmArr.push(up > dn && up > 0 ? up : 0);   // +DM
    ndmArr.push(dn > up && dn > 0 ? dn : 0);   // -DM
  }
  const trR = rma(trArr, len), pR = rma(pdmArr, len), nR = rma(ndmArr, len);
  const dxArr = [];
  let diPlus = 0, diMinus = 0;
  for (let i = 0; i < trArr.length; i++) {
    if (trR[i] === null) continue;             // warmup del RMA
    const dip = trR[i] === 0 ? 0 : 100 * pR[i] / trR[i];
    const dim = trR[i] === 0 ? 0 : 100 * nR[i] / trR[i];
    diPlus = dip; diMinus = dim;
    const s = dip + dim;
    dxArr.push(s === 0 ? 0 : 100 * Math.abs(dip - dim) / s);
  }
  if (dxArr.length < len) return null;
  const adxSm = rma(dxArr, len);
  const adx = adxSm[adxSm.length - 1];
  if (adx === null || !isFinite(adx)) return null;
  return {
    adx, diPlus, diMinus,
    strong:  adx >= ADX_MIN,
    lateral: adx <  ADX_MIN,
    bull: diPlus > diMinus,
    bear: diMinus > diPlus,
    quality: adx >= ADX_FUERTE ? '🔥 FUERTE' : adx >= ADX_MIN ? '✅ VÁLIDA' : '⚠️ LATERAL',
  };
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

// ── ROOT #5 FIX: 4H ANCLADO A LA SESIÓN (como TradingView) ──────────────
// Polygon entrega barras de 4h de RELOJ (ancla fija + horario extendido), por eso
// el SuperTrend 4H salía OPUESTO al Pine. TradingView ancla el 4H a la apertura de
// sesión: validado en AMZN, las velas 4H de TV abren 09:30 y 13:30 ET (RTH 9:30–16:00).
// Resampleamos las velas de 15m (que ya bajamos, y caen justo en :30) en velas 4H de
// sesión: dos por día → [09:30–13:30) y [13:30–16:00). Se descarta el pre/post-market.
// Esas velas alimentan calcSuperTrend → misma vela que TV → misma dirección y cruce.
// `tMs`: true si los timestamps están en milisegundos (el monitor trabaja en ms).
function resampleSession4H(bars, tMs) {
  if (!bars || !bars.length) return [];
  const toMs = t => tMs ? t : t * 1000;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const buckets = new Map(); const order = [];
  for (const b of bars) {
    const p = fmt.formatToParts(new Date(toMs(b.t)));
    const g = t => p.find(x => x.type === t).value;
    let hh = parseInt(g('hour'), 10); if (hh === 24) hh = 0;
    const mins = hh * 60 + parseInt(g('minute'), 10);   // minutos ET desde 00:00
    if (mins < 570 || mins >= 960) continue;            // fuera de RTH (570=9:30, 960=16:00)
    const slot = mins < 810 ? 'A' : 'B';                // 810 = 13:30
    const key = `${g('year')}-${g('month')}-${g('day')}|${slot}`;
    let bk = buckets.get(key);
    if (!bk) { bk = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }; buckets.set(key, bk); order.push(key); }
    else { bk.h = Math.max(bk.h, b.h); bk.l = Math.min(bk.l, b.l); bk.c = b.c; bk.v += (b.v || 0); }
  }
  return order.map(k => buckets.get(k));
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
function evaluateAllLayers({ price, candles4H, candles4HXL, candles1H, candles15m, vp, session }) {
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

  // ── CAPA 13: ADX/DMI — EL ALMA DE TV (= capa 13 del Pine v6.1) ──
  // +1pt si hay tendencia real (ADX≥20) con DMI en la dirección. El
  // BLOQUEO por lateral (ADX<20) se aplica en el gate de envío, como adx_ok.
  const adx4H = calcADX(candles4H);
  if (adx4H && adx4H.strong) {
    if (adx4H.bull) signals.push({ layer:13, dir:'BUY',  weight:1, label:`📡 ADX ${adx4H.adx.toFixed(1)} + DMI alcista — tendencia real` });
    if (adx4H.bear) signals.push({ layer:13, dir:'SELL', weight:1, label:`📡 ADX ${adx4H.adx.toFixed(1)} + DMI bajista — tendencia real` });
  }

  // ── CAPA 14: ARCO BOSWAVES — el gatillo del triángulo (ST+arco+VWAP) ──
  // Port fiel del "Arc VWAP Supertrend [BOSWaves]" (MPL 2.0). Dos aportes:
  // · ESTADO (+0.75): dirección actual del arco — confluencia continua.
  // · EVENTO (+1.5): flip CONFIRMADO por VWAP en las últimas 2 velas 4H —
  //   el disparo preciso que Gonzalo opera en TV (par "VWAP Confirmed").
  // Usa la serie EXTENDIDA (4HXL); si falta el módulo o hay pocas velas,
  // la capa se omite sin afectar nada (fail-open, datos reales o nada).
  let arc4H = null;
  if (computeArc && candles4HXL && candles4HXL.length >= 110) {
    try { arc4H = computeArc(candles4HXL); } catch (e) { arc4H = null; }
    if (arc4H && arc4H.initialized) {
      const bull = arc4H.trend === 'BULL';
      signals.push({
        layer: 14, dir: bull ? 'BUY' : 'SELL', weight: 0.75,
        label: `🌀 Arco BOSWaves ${bull ? 'alcista' : 'bajista'} 4H (VWAP ${arc4H.vwapAgreesNow ? '✓' : '✗'})`,
      });
      const lf = arc4H.lastFlip;
      if (lf && lf.confirmed && arc4H.flipAgeBars !== null && arc4H.flipAgeBars <= 2) {
        signals.push({
          layer: 14, dir: lf.bull ? 'BUY' : 'SELL', weight: 1.5,
          label: `🌀 FLIP ${lf.bull ? 'BULL' : 'BEAR'} del arco · VWAP confirmado${lf.live ? ' (intrabarra)' : ''} — gatillo del triángulo`,
        });
      }
    }
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
    st4H, cvd4H, struct4H, sh4H, gex, dp, vp, adx4H, arc4H,
  };
}

// ── MENSAJE TELEGRAM ─────────────────────────────────────────
function buildMessage(ticker, price, result, session, quote, candles4H) {
  const isBuy  = result.direction === 'BUY';
  const _tf    = '240';  // monitor analiza en 4H — señales de swing
  const atr    = getATR(ticker, price, _tf, candles4H);
  const atrTV  = calcRealATR(candles4H, 14) || atr;   // ATR(14) real del 4H = ta.atr(14) del Pine → TP a lo TV
  // TP/SL ESTRUCTURALES (niveles reales: POC/VWAP/VAH-VAL/pools/máx-mín día/proy). ATR solo relleno.
  const zones4H = detectLiquidityZones(candles4H, price);
  const tgt = computeStructuralTargets(price, result.direction, result.vp, zones4H, quote, result.struct4H, atr, atrTV);
  const sl  = tgt ? tgt.sl.price : (isBuy ? price - atr*1.5 : price + atr*1.5);
  const slLb  = tgt ? ' · ' + tgt.sl.label : '';
  const tp1 = tgt && tgt.tps[0] ? tgt.tps[0].price : null;
  const tp2 = tgt && tgt.tps[1] ? tgt.tps[1].price : null;
  const tp3 = tgt && tgt.tps[2] ? tgt.tps[2].price : null;
  const t1Lb = tgt && tgt.tps[0] ? ' · ' + tgt.tps[0].label : '';
  const t2Lb = tgt && tgt.tps[1] ? ' · ' + tgt.tps[1].label : '';
  const t3Lb = tgt && tgt.tps[2] ? ' · ' + tgt.tps[2].label : '';

  const arrow   = isBuy ? '▲ BUY — COMPRA 🟢' : '▼ SELL — VENTA 🔴';
  // Calidad alineada al Pine: 🔥 solo con ADX≥30 (tendencia fuerte real).
  // Score alto en ADX 20-30 = ⭐ INSTITUCIONAL (válida, sin humo).
  const adxV    = result.adx4H ? result.adx4H.adx : null;
  const quality = (result.score >= 8 && (adxV === null || adxV >= ADX_FUERTE)) ? '🔥 MÁXIMA CALIDAD'
                : result.score >= 6 ? '⭐ INSTITUCIONAL'
                : '✅ VÁLIDA';
  const adxLine = result.adx4H ? `\n📡 Régimen: ADX ${result.adx4H.adx.toFixed(1)} · ${result.adx4H.quality}` : '';
  const arcLine = (result.arc4H && result.arc4H.initialized)
    ? `\n🌀 Arco: ${result.arc4H.trend === 'BULL' ? '▲ BULL' : '▼ BEAR'}${result.arc4H.lastFlip && result.arc4H.flipAgeBars <= 2 && result.arc4H.lastFlip.confirmed ? ' · FLIP confirmado hace ' + result.arc4H.flipAgeBars + ' vela' + (result.arc4H.flipAgeBars === 1 ? '' : 's') : ''} · VWAP ${result.arc4H.vwapAgreesNow ? '✓' : '✗'}`
    : '';

  const phLine    = session.powerHour ? `\n⏰ ${session.powerHour.name}` : '';
  const stLine    = result.st4H       ? `\n${result.st4H.label}${result.st4H.crossed?' ← CRUCE RECIENTE':''}` : '';
  const structL   = result.struct4H   ? `\n🔷 ${result.struct4H.label} 4H` : '';
  const shLine    = result.sh4H       ? `\n🎯 Stop Hunt ${result.sh4H.type==='SH_BUY'?'alcista':'bajista'} 4H` : '';
  const dpLine    = '';  // Dark Pool desactivado (FASE 4)
  const om = result.optMetrics;
  const gexReal = om && om.ok && om.gex;
  const gexInfo = gexReal
    ? ` · GEX ${om.gex.regimeCode === 'LONG_GAMMA' ? '🟢 LONG (pin)' : '🔴 SHORT (volátil)'}`
      + `\n🧱 Call Wall $${om.gex.callWall} · Put Wall $${om.gex.putWall}`
      + (om.gex.gammaFlip ? ` · Flip $${om.gex.gammaFlip}` : '')
      + `\n🎯 Max Pain $${om.maxPain} · exp ${om.expiration}`
    : ' · GEX/MaxPain: N/D (opciones FASE 4)';
  const gexLine   = (result.gex && result.gex.volRegime && result.gex.volRegime !== 'N/D')
    ? `\n📊 Volatilidad: ${result.gex.volRegime}${gexInfo}`
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
⭐ Score: ${result.score}/10 · ${quality}${adxLine}${arcLine}
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
    // ROOT #5 FIX: ya NO pedimos 4h nativas a Polygon (venían de reloj + extendido →
    // SuperTrend opuesto al Pine). El 4H se arma resampleando los 15m a sesión (09:30/13:30).
    // ARCO: pedimos 120 días de 15m UNA sola vez; las capas validadas reciben el recorte
    // de 45 días (idéntico a antes, cero cambio de comportamiento) y el ARCO recibe la
    // serie completa (necesita 110+ velas 4H de sesión para converger). Mismo fetch, una verdad.
    const [candles1H, candles15mFull, quote] = await Promise.all([
      fetchCandles(ticker, '1H'),
      fetchCandles(ticker, '15mXL'),
      fetchQuote(ticker),
    ]);
    const cut45 = Date.now() - 45 * 86400000;
    const candles15m = candles15mFull.filter(b => b.t >= cut45);  // mismas referencias → el overlay del precio vivo llega a ambas series

    if (candles15m.length < 30) {
      console.log(`[${ticker}] Sin datos 15m suficientes para armar el 4H`);
      return;
    }

    // Overlay precio del último cierre (Polygon, delay 15 min en Starter) sobre la
    // última vela real de cada TF. Fuente única, sin Finnhub. Se hace ANTES de
    // resamplear, para que la última vela 4H ya refleje el precio vivo.
    if (quote?.c) {
      for (const arr of [candles1H, candles15m]) {
        if (arr.length) {
          const last = arr[arr.length - 1];
          last.c = quote.c;
          if (quote.h) last.h = Math.max(last.h, quote.h);
          if (quote.l) last.l = Math.min(last.l, quote.l);
        }
      }
    }

    // 4H ANCLADO A SESIÓN (como TradingView) desde los 15m ya con overlay.
    const candles4H = resampleSession4H(candles15m, true);
    // Serie EXTENDIDA solo para el ARCO (capa 14) — no toca las capas validadas.
    const candles4HXL = resampleSession4H(candles15mFull, true);
    if (candles4H.length < 11) {
      console.log(`[${ticker}] 4H de sesión insuficiente (${candles4H.length} velas)`);
      return;
    }

    const price  = quote?.c || candles4H[candles4H.length - 1].c;
    const candle4HId = candles4H[candles4H.length - 1].t;
    // VWAP/POC ANCLADOS A LA SESIÓN (reset diario, como TradingView): se calculan
    // sobre las velas de 15m de la sesión actual — NO sobre 60 velas 4H (~1.5 meses).
    // Esto evita el VWAP a la deriva (ej. QQQ daba VWAP a −$141 del precio).
    let vpWindow = currentSessionCandles(candles15m);
    if (vpWindow.length < 6) vpWindow = (candles15m.length ? candles15m : candles4H).slice(-26); // respaldo: ~1 sesión
    const vp     = buildVolumeProfile(vpWindow, 100);
    const result = evaluateAllLayers({ price, candles4H, candles4HXL, candles1H, candles15m, vp, session });

    const stLabel = result.st4H ? (result.st4H.bullish ? '↑ST' : '↓ST') : 'ST?';
    console.log(`[${ticker}] Dir=${result.direction} Score=${result.score}/10 ${stLabel} BUY=${result.buyScore.toFixed(1)} SELL=${result.sellScore.toFixed(1)} Capas=${result.layersInDir.size}`);

    if (result.direction === 'NEUTRAL') return;

    // ── RÉGIMEN ADX — CONFLUENCIA, NO JUEZ (decisión 12-jun, revisada) ──
    // El ADX es LENTO (RMA de RMA): en un cambio de tendencia preciso — BOS con
    // velas de volumen, CHoCH del triángulo — todavía viene < 20 caminando atrás.
    // Bloquear por ADX bajo MATA la señal temprana, que es el oro del sistema
    // (lo vimos con HOOD: el precio explota antes de que el ADX confirme).
    // Por eso NO bloqueamos: el ADX solo SUMA +1pt como confluencia (capa 13)
    // cuando hay tendencia real, y marca calidad 🔥 con ≥30. El juez que filtra
    // sigue siendo el SuperTrend + estructura, no el ADX. Solo lo dejamos
    // anotado en el log para vigilar si una señal nació en régimen lateral.
    if (result.adx4H && result.adx4H.lateral) {
      console.log(`[${ticker}] ℹ️ ADX ${result.adx4H.adx.toFixed(1)} < ${ADX_MIN} (lateral) — NO bloquea; señal ${result.direction} validada por estructura. ADX informa, no juzga.`);
    }

    const minReq = session.powerHour ? 5 : MIN_SCORE;
    if (result.score < minReq) {
      console.log(`[${ticker}] Score ${result.score}/${minReq} insuficiente`);
      return;
    }

    if (result.layersInDir.size < 3) {
      console.log(`[${ticker}] Solo ${result.layersInDir.size} capas — necesita 3`);
      return;
    }

    // ── ANTI-SPAM (FIX) ───────────────────────────────────
    // Antes: cualquier scan con un CHoCH/BOS presente en 4H rompía el cooldown y
    // reenviaba cada 5 min por horas → +1000 notificaciones repetidas (el 90% iguales).
    // Ahora: el evento estructural solo cuenta como NUEVO una vez (firma por tipo),
    // y solo se permite UNA señal por vela 4H por dirección (el 4H no varía entre
    // scans). Resultado: 1–2 señales por activo, como pediste.
    const structSig   = result.struct4H ? result.struct4H.type : null;   // CHOCH_*/BOS_* o null
    const isNewStruct = structSig !== null && structSig !== s.lastStructSig;
    const sameDir     = s.lastSignalDir === result.direction;
    const sameCandle  = s.lastCandle4H === candle4HId;

    // REGLA: una señal por vela 4H por dirección (mata el spam de 5-min)
    if (sameDir && sameCandle && !isNewStruct) {
      console.log(`[${ticker}] Ya señalado ${result.direction} en esta vela 4H — silencio (anti-spam)`);
      return;
    }

    // REGLA: cooldown por tiempo (misma dirección), roto SOLO por estructura NUEVA
    // (antes lo rompía la simple PRESENCIA de CHoCH/BOS → esa era la fuga del spam)
    const inCooldown = sameDir
                    && (Date.now() - s.lastSignalTs) < COOLDOWN_MS
                    && !isNewStruct;
    if (inCooldown) {
      const h = ((COOLDOWN_MS - (Date.now() - s.lastSignalTs)) / 3600000).toFixed(1);
      console.log(`[${ticker}] Cooldown ${h}h — misma dir sin estructura nueva — silencio`);
      return;
    }

    console.log(`[${ticker}] ✅ SEÑAL BOLSA v6: ${result.direction} score=${result.score}/10`);

    // GEX (BS) + Max Pain REALES (mensual, cacheado 10min). NUNCA bloquea la señal:
    // si Alpaca/opciones fallan, optMetrics queda null y se muestra el N/D de siempre.
    result.optMetrics = null;
    if (getOptionsMetrics) {
      try { result.optMetrics = await getOptionsMetrics(ticker, { mode: 'monthly' }); }
      catch (e) { console.log(`[${ticker}] GEX/MaxPain no disponible (${e.message}) — señal sigue`); }
    }

    await sendTelegram(buildMessage(ticker, price, result, session, quote, candles4H));

    s.lastSignalDir = result.direction;
    s.lastSignalTs  = Date.now();
    s.lastStructSig = structSig;   // recuerda el evento estructural ya disparado (no repetir)
    s.lastCandle4H  = candle4HId;

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
console.log(`   CAPA 13   : ADX/DMI Wilder(${ADX_LEN}) 4H — +1pt CONFLUENCIA si ADX≥${ADX_MIN} con DMI a favor (= Pine v6.1)`);
console.log(`   RÉGIMEN   : ADX informa (🔥≥${ADX_FUERTE} / ✅≥${ADX_MIN} / ⚠️ rango) pero NO bloquea — el juez es SuperTrend+estructura, no el ADX (lento)`);
console.log(`   CAPA 14   : ARCO BOSWaves 4H — estado +0.75 · flip VWAP-confirmado ≤2 velas +1.5 (gatillo del triángulo) · ${computeArc ? 'ACTIVA' : '⚠️ DESACTIVADA (falta arc_boswaves.js)'}`);
console.log('   GEX/MaxPain: N/D — requieren cadena de opciones (no afectan el score)');
console.log('   TP/SL     : ESTRUCTURALES (POC/VWAP/VAH-VAL/pools/máx-mín/proy) — idéntico al mapa v6');
console.log(`   Score     : mínimo ${MIN_SCORE}/10 · 3 capas concordantes · max 10 · SOLO capas reales`);
console.log('   Anti-spam : 1 señal por vela 4H · cooldown roto solo por estructura NUEVA');
console.log('   Bot       : @liquidmapbolsa_bot');
console.log('   Velas     : ALPACA SIP (real-time, sin delay 15min) · Quote: daily bars · FUENTE ÚNICA');

if (!ALPACA_KEY_ID || !ALPACA_SECRET) {
  console.error('⚠️  FALTAN ALPACA_KEY_ID / ALPACA_SECRET_KEY — agregalas en Render (Environment). El monitor no leerá velas sin ellas.');
} else {
  console.log(`   Alpaca    : ✅ keys cargadas (${ALPACA_KEY_ID.slice(0,4)}…) · feed=sip`);
}

runScan();
setInterval(runScan, SCAN_INTERVAL);
