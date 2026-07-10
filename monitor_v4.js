// ============================================================
//  monitor_v4.js — LiquidMap PRO · SISTEMA NEURONAL INSTITUCIONAL
//  Arquitectura cuántica de capas — idéntica al mapa HTML crypto
//
//  CAPA 1 — CONTEXTO DE MERCADO (sesgo macro, sesión, ciclo)
//  CAPA 2 — ESTRUCTURA (CHoCH, BOS, swing highs/lows)
//  CAPA 3 — VOLUMEN INSTITUCIONAL (CVD, OI, Delta, liquidaciones)
//  CAPA 4 — LIQUIDEZ (zonas, Stop Hunt, Order Flow, Dark Pool)
//  CAPA 5 — CONFIRMACIÓN (FR, GEX, convergencia multi-TF)
//  CAPA 6 — DECISIÓN (score ponderado, calidad, timing Kill Zone)
//
//  Regla máxima: NUNCA dispara por cumplir — solo cuando
//  todas las capas convergen en la misma dirección.
//  Si hay duda → silencio. Si hay señal → es real.
//
//  DATA: velas/funding/OI/L-S vía proxy Render → Bybit (Binance 418 baneado).
// ============================================================

'use strict';
const fetch = require('node-fetch');
const { computeArc } = require('./arc_boswaves.js');   // CAPA 14 · motor del arco (ya en el repo, lo usa el bot bolsa)

// ── LATIDO DE SALUD (2b) — singleton compartido con server.js. No-op si falta el módulo (fail-open). ──
let hbBeat = () => {}, hbSignal = () => {};
try { const hs = require('./health_state.js'); hbBeat = hs.beat; hbSignal = hs.signal; }
catch (e) { console.warn('⚠️  health_state no disponible (latido off):', e.message); }

// ── CONFIG ─────────────────────────────────────────────────
const TELEGRAM_TOKEN = '8676337394:AAEVIwDY2xGwAmE7hMWcjjAMedjws_vjzSU';
const CHAT_IDS       = ['1218461753', '1373309702'];
// PROXY: por defecto LOOPBACK local. El bot corre DENTRO de server.js (mismo proceso),
// así que pegarle al /proxy por la URL PÚBLICA de Render salía a internet y volvía a entrar a
// la MISMA instancia free (1 solo proceso) → se ahogaba bajo carga ("Premature close").
// Por 127.0.0.1 el pedido nunca sale de la caja: sin DNS, sin TLS, sin el edge de Render.
// Override con PROXY_URL si alguna vez se corre el bot por separado (fuera de server.js).
const PORT           = process.env.PORT || 3000;
const PROXY          = process.env.PROXY_URL || `http://127.0.0.1:${PORT}/proxy`;

// Tickers activos — agregar aquí cuando se quiera activar uno nuevo
const CRYPTO_TICKERS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'ADAUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT','DOTUSDT',
  'MATICUSDT','LTCUSDT'
];

// ATR base — se usa solo como fallback si hay < 15 velas
// El sistema calcula ATR dinámico real (True Range EMA-14)
const ATR_PCT = {
  BTCUSDT:0.022, ETHUSDT:0.028, SOLUSDT:0.040, BNBUSDT:0.025,
  XRPUSDT:0.035, ADAUSDT:0.038, AVAXUSDT:0.042, DOGEUSDT:0.045,
  LINKUSDT:0.038, DOTUSDT:0.040, MATICUSDT:0.045, LTCUSDT:0.030,
};

// Score mínimo para disparar (de 10 posibles)
const MIN_SCORE = 6;

// Cooldown: no repetir la misma dirección en el mismo ticker
// hasta que el mercado cambie de estructura
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4H

// ANTI-FLOOD (fix SOL): el cooldown de 4H se rompe solo con un CHoCH NUEVO.
// Un CHoCH cuenta como "nuevo" solo si cambió de dirección o si su nivel se movió
// ≥ MIN_CHOCH_ATR_MULT × ATR respecto del último disparado. Normalizado por
// volatilidad → SOL/DOGE/AVAX dejan de re-disparar por micro-giros; BTC igual que antes.
const MIN_CHOCH_ATR_MULT = 0.5;   // subir = más estricto (menos señales) · bajar = más permisivo

// Scan cada 5 min — pero solo dispara cuando hay calidad real
const SCAN_INTERVAL = 5 * 60 * 1000;

// ── ESTADO NEURONAL ─────────────────────────────────────────
// Memoria de cada ticker — el sistema aprende entre scans
const STATE = {};

function getState(ticker) {
  if (!STATE[ticker]) {
    STATE[ticker] = {
      lastSignalDir: null,
      lastSignalTs: 0,
      lastSignalPrice: 0,
      lastChochType: null,
      lastChochLevel: null,
      lastStructure: 'NEUTRAL',
      lastCVDDir: 'neutral',
      lastOITrend: 'neutral',
      consecutiveNeutral: 0,
      lastProcessedCandle4H: null,
      lastProcessedCandle1H: null,
    };
  }
  return STATE[ticker];
}

// ── HELPERS ─────────────────────────────────────────────────
function fmt(n, ref) {
  if (isNaN(+n)) return '—';
  if (ref >= 10000) return (+n).toFixed(0);
  if (ref >= 1000)  return (+n).toFixed(1);
  if (ref >= 10)    return (+n).toFixed(3);
  return (+n).toFixed(4);
}

// ATR dinámico real — True Range EMA-14 Wilder
// Se adapta a cualquier cripto y a cambios de volatilidad
function calcRealATR(candles, period = 14) {
  if (!candles || candles.length < 2) return null;
  const trList = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i-1].c),
      Math.abs(candles[i].l - candles[i-1].c)
    );
    trList.push(tr);
  }
  if (trList.length < period) return null;
  let atr = trList.slice(0, period).reduce((a, v) => a + v, 0) / period;
  for (let i = period; i < trList.length; i++) {
    atr = atr * (period - 1) / period + trList[i] / period;
  }
  return atr;
}

// ── ANTI-FLOOD: ¿el CHoCH es GENUINAMENTE NUEVO? (normalizado por ATR) ──
// El cooldown de 4H se rompe SOLO con un CHoCH nuevo. Antes cualquier cambio de
// nivel (centavos) contaba → las cripto choppy re-disparaban. Ahora es "nuevo"
// solo si cambió de tipo/dirección o si el nivel se movió ≥ mult×ATR del último.
function isNewChochATR(chochType, chochLevel, lastType, lastLevel, atr, mult) {
  if (!chochType) return false;                          // no hay CHoCH → no es "nuevo"
  if (lastType == null || lastLevel == null) return true; // sin historial → cuenta como nuevo
  if (chochType !== lastType) return true;               // cambió de dirección → nuevo real
  const minMove = Math.max((atr > 0 ? atr : 0) * mult, 1e-9);  // epsilon: nivel idéntico nunca es "nuevo"
  return Math.abs(chochLevel - lastLevel) >= minMove;    // mismo tipo: solo si el nivel se movió ≥ mult×ATR
}

function getATR(ticker, price, candles) {
  // Primero intenta ATR dinámico real
  if (candles && candles.length >= 15) {
    const dynATR = calcRealATR(candles, 14);
    if (dynATR && dynATR > 0) return dynATR;
  }
  // Fallback estático si no hay suficientes velas
  return price * (ATR_PCT[ticker] || 0.025);
}

// VWAP real — Σ(precio_típico × volumen) / Σvolumen
function calcRealVWAP(candles) {
  if (!candles || !candles.length) return null;
  let sumPV = 0, sumV = 0, sumPV2 = 0;
  for (const b of candles) {
    const tp = (b.h + b.l + b.c) / 3;
    const vol = b.qv || b.v;
    sumPV  += tp * vol;
    sumV   += vol;
    sumPV2 += tp * tp * vol;
  }
  if (!sumV) return null;
  const vwap = sumPV / sumV;
  const variance = Math.max(0, sumPV2 / sumV - vwap * vwap);
  const sigma = Math.sqrt(variance);
  return {
    vwap,
    sigma1up: vwap + sigma,
    sigma1dn: vwap - sigma,
    sigma2up: vwap + 2 * sigma,
    sigma2dn: vwap - 2 * sigma,
  };
}

// EMA del último valor — MISMO método que el mapa (seed SMA + recursión EMA).
// Se usa para la referencia HTF (EMA200 sobre 4H) en la GUARDA HTF (opción B).
function emaLast(vals, period) {
  if (!vals || vals.length < period) return null;
  const k = 2 / (period + 1);
  let e = vals.slice(0, period).reduce((a, b) => a + b, 0) / period; // seed = SMA
  for (let i = period; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

// Detectar Kill Zone UTC — ventanas institucionales reales
function getKillZone() {
  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const t = h + m / 60;
  if (t >= 0  && t < 2)   return { name: 'Asia Open KZ',    weight: 1.2 };
  if (t >= 7  && t < 9)   return { name: 'London Open KZ',  weight: 1.5 }; // máxima importancia
  if (t >= 12 && t < 14)  return { name: 'NY Open KZ',      weight: 1.5 }; // máxima importancia
  if (t >= 13 && t < 16)  return { name: 'NY-London Overlap', weight: 1.6 }; // overlap = pico máximo
  if (t >= 20 && t < 21)  return { name: 'NY Close KZ',     weight: 1.2 };
  return null; // fuera de Kill Zone — señal válida pero peso normal
}

function getSession() {
  const h = new Date().getUTCHours();
  if (h >= 0  && h < 8)  return 'Asia';
  if (h >= 8  && h < 16) return 'Londres';
  if (h >= 13 && h < 21) return 'New York';
  return 'Cierre';
}

// ── FETCH (vía proxy Render → Bybit) ────────────────────────
async function fetchCandles(symbol, interval, limit = 100) {
  // Usar proxy de Render → traduce a Bybit (Binance da 418 desde Render)
  const url = `${PROXY}?path=/api/v3/klines&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  // 2 intentos: el proxy free puede cortar la conexión ("Premature close") bajo carga.
  // Un reintento corto tras drenar la cola suele resolverlo. Si persiste, propaga (aborta
  // el ticker como antes) — no inventa data parcial.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r   = await fetch(url, { timeout: 10000 });
      const raw = await r.json();
      if (!Array.isArray(raw)) return [];
      return raw.map(k => ({
        t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4],
        v: +k[5], qv: +k[7],           // quote volume en USDT
        trades: +k[8],
        buyBaseVol: +k[9],             // volumen de compra agresiva
        buyQuoteVol: +k[10],           // volumen de compra en USDT
        closeTime: k[6],
      }));
    } catch (e) {
      if (attempt === 2) throw e;                          // tras 2 intentos, propaga (como antes)
      await new Promise(res => setTimeout(res, 500));      // backoff corto antes del reintento
    }
  }
  return [];
}

// Funding Rate — clave en crypto, contrarian institucional
async function fetchFundingRate(symbol) {
  try {
    const url = `${PROXY}?path=/fapi/v1/fundingRate&symbol=${symbol}&limit=3`;
    const r   = await fetch(url, { timeout: 6000 });
    const d   = await r.json();
    if (!Array.isArray(d) || !d.length) return { current: 0, trend: 'neutral' };
    const rates = d.map(x => parseFloat(x.fundingRate) * 100);
    const current = rates[rates.length - 1];
    const prev    = rates[0];
    const trend   = current > prev + 0.005 ? 'rising'
                  : current < prev - 0.005 ? 'falling' : 'stable';
    return { current, trend, nextFunding: d[d.length - 1].fundingTime };
  } catch { return { current: 0, trend: 'neutral' }; }
}

// Open Interest — confirma convicción institucional
async function fetchOpenInterest(symbol) {
  try {
    const url = `${PROXY}?path=/fapi/v1/openInterest&symbol=${symbol}&futures=1`;
    const r   = await fetch(url, { timeout: 6000 });
    const d   = await r.json();
    return d.openInterest ? parseFloat(d.openInterest) : 0;
  } catch { return 0; }
}

// OI histórico para detectar tendencia
async function fetchOIHistory(symbol) {
  try {
    const url = `${PROXY}?path=/futures/data/openInterestHist&symbol=${symbol}&period=4h&limit=10`;
    const r   = await fetch(url, { timeout: 6000 });
    const d   = await r.json();
    if (!Array.isArray(d) || d.length < 2) return { trend: 'neutral', change: 0 };
    const latest = parseFloat(d[d.length - 1].sumOpenInterest);
    const prev   = parseFloat(d[0].sumOpenInterest);
    const change = ((latest - prev) / prev) * 100;
    const trend  = change > 2 ? 'rising' : change < -2 ? 'falling' : 'stable';
    return { trend, change, latest, prev };
  } catch { return { trend: 'neutral', change: 0 }; }
}

// Long/Short Ratio — sentimiento del mercado
async function fetchLSRatio(symbol) {
  try {
    const url = `${PROXY}?path=/futures/data/globalLongShortAccountRatio&symbol=${symbol}&period=4h&limit=5`;
    const r   = await fetch(url, { timeout: 6000 });
    const d   = await r.json();
    if (!Array.isArray(d) || !d.length) return { ratio: 1, longs: 50, shorts: 50 };
    const latest = d[d.length - 1];
    const ratio  = parseFloat(latest.longShortRatio);
    const longs  = parseFloat(latest.longAccount) * 100;
    const shorts = 100 - longs;
    return { ratio, longs, shorts };
  } catch { return { ratio: 1, longs: 50, shorts: 50 }; }
}

// ── CAPA 1: VOLUME PROFILE → POC + VALUE AREA ──────────────
// Idéntico al mapa HTML — base del análisis institucional.
// bins = 60 para COINCIDIR con el mapa crypto (HTML ~3745) → POC/VAH/VAL
// iguales map↔monitor. Antes era 100 y divergía (FUGA E medida en fotos).
function buildVolumeProfile(candles, bins = 60) {
  const mn = Math.min(...candles.map(c => c.l));
  const mx = Math.max(...candles.map(c => c.h));
  if (mx <= mn) return null;
  const bs = (mx - mn) / bins;
  const profile = new Array(bins).fill(0);
  for (const c of candles) {
    // Usar quote volume (USDT) para perfil institucional real
    const vol = c.qv || c.v;
    const iLow  = Math.max(0, Math.floor((c.l - mn) / bs));
    const iHigh = Math.min(bins - 1, Math.floor((c.h - mn) / bs));
    for (let i = iLow; i <= iHigh; i++) {
      profile[i] += vol / Math.max(1, iHigh - iLow + 1);
    }
  }
  const maxVol = Math.max(...profile);
  const pocIdx = profile.indexOf(maxVol);
  const poc    = mn + pocIdx * bs + bs / 2;

  // Value Area 70%
  const total = profile.reduce((a, b) => a + b, 0);
  let lo = pocIdx, hi = pocIdx, acc = profile[pocIdx];
  while (acc < total * 0.70) {
    const al = lo > 0 ? profile[lo - 1] : 0;
    const ah = hi < bins - 1 ? profile[hi + 1] : 0;
    if (al >= ah && lo > 0)        { lo--; acc += al; }
    else if (hi < bins - 1)        { hi++; acc += ah; }
    else break;
  }
  const vah = mn + hi * bs + bs;
  const val = mn + lo * bs;

  // HVN — nodos de alto volumen (zonas institucionales)
  const hvnThreshold = maxVol * 0.75;
  const hvns = [];
  for (let i = 0; i < bins; i++) {
    if (profile[i] >= hvnThreshold) {
      hvns.push(mn + i * bs + bs / 2);
    }
  }

  return { poc, vah, val, hvns, profile, min: mn, max: mx, binSize: bs };
}

// ── CAPA 2: CVD — DELTA INSTITUCIONAL ───────────────────────
// Detecta quién manda: compradores o vendedores agresivos
function calcCVD(candles) {
  let cvd = 0, buyVol = 0, sellVol = 0;
  const deltas = [];
  for (const c of candles) {
    // Usar buyBaseVol de Binance cuando disponible (más preciso)
    const bv = c.buyBaseVol > 0 ? c.buyBaseVol : (c.c >= c.o ? c.v : 0);
    const sv = c.v - bv;
    buyVol  += bv;
    sellVol += sv;
    cvd     += (bv - sv);
    deltas.push(bv - sv);
  }
  const total   = buyVol + sellVol || 1;
  const buyPct  = (buyVol / total) * 100;

  // Detectar divergencia CVD vs precio — señal institucional clave
  const recentCandles = candles.slice(-10);
  const priceDir = recentCandles[recentCandles.length - 1].c > recentCandles[0].c ? 'up' : 'down';
  const cvdRecent = deltas.slice(-10).reduce((a, b) => a + b, 0);
  const cvdDir    = cvdRecent > 0 ? 'up' : 'down';
  const divergence = priceDir !== cvdDir; // precio sube pero CVD baja = distribución

  // Momentum del CVD — aceleración
  const cvdMomentum = deltas.slice(-5).reduce((a, b) => a + b, 0);

  return {
    cvd, buyVol, sellVol, buyPct,
    divergence, priceDir, cvdDir,
    cvdMomentum,
    bullish: cvd > 0 && buyPct > 51 && !divergence,
    bearish: cvd < 0 && buyPct < 49 && !divergence,
  };
}

// ── CAPA 3: STOP HUNT — TRAMPA INSTITUCIONAL ────────────────
// El mapa lo detecta perfectamente — replicar aquí
function detectStopHunt(candles) {
  if (!candles.length) return null;
  const c    = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!c || !prev) return null;

  const { o, h, l, close: cl = c.c } = { o: c.o, h: c.h, l: c.l, close: c.c };
  const body      = Math.abs(cl - o);
  const range     = h - l;
  if (!range || body < range * 0.01) return null; // vela doji extrema — ignorar

  const upperWick = h - Math.max(o, cl);
  const lowerWick = Math.min(o, cl) - l;

  // Criterio institucional: mecha >= 2.5x cuerpo Y >= 45% del rango
  // Más estricto que v3 para eliminar ruido
  const isBearSH = upperWick >= body * 2.5 && upperWick / range >= 0.45;
  const isBullSH = lowerWick >= body * 2.5 && lowerWick / range >= 0.45;

  if (!isBullSH && !isBearSH) return null;

  // Confirmar que la mecha perforó un swing previo — SH real
  const prevHigh = Math.max(...candles.slice(-10, -1).map(x => x.h));
  const prevLow  = Math.min(...candles.slice(-10, -1).map(x => x.l));

  const brokeHigh = h > prevHigh * 1.001; // perforó máximos previos y cerró abajo
  const brokeLow  = l < prevLow  * 0.999; // perforó mínimos previos y cerró arriba

  if (isBullSH && brokeLow)  return { type: 'SH_BUY',  strength: lowerWick / range, brokeLevel: prevLow  };
  if (isBearSH && brokeHigh) return { type: 'SH_SELL', strength: upperWick / range, brokeLevel: prevHigh };

  // SH sin perforar swing — válido pero menos fuerte
  if (isBullSH) return { type: 'SH_BUY',  strength: lowerWick / range * 0.7, brokeLevel: null };
  if (isBearSH) return { type: 'SH_SELL', strength: upperWick / range * 0.7, brokeLevel: null };

  return null;
}

// ── CAPA 4: ESTRUCTURA — CHoCH Y BOS ────────────────────────
// CHoCH = cambio de carácter (reversión)
// BOS   = break of structure (continuación)
function detectStructure(candles) {
  if (candles.length < 30) return null;

  // Detectar swings significativos con filtro de ruido
  const swingHighs = [];
  const swingLows  = [];
  const lookback   = 5;

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    const highs = candles.slice(i - lookback, i).concat(candles.slice(i + 1, i + lookback + 1));
    const lows  = highs;

    if (highs.every(x => c.h >= x.h)) swingHighs.push({ price: c.h, idx: i });
    if (lows.every(x => c.l <= x.l))  swingLows.push({ price: c.l, idx: i });
  }

  if (swingHighs.length < 2 || swingLows.length < 2) return null;

  const lastHigh    = swingHighs[swingHighs.length - 1];
  const prevHigh    = swingHighs[swingHighs.length - 2];
  const lastLow     = swingLows[swingLows.length - 1];
  const prevLow     = swingLows[swingLows.length - 2];
  const lastClose   = candles[candles.length - 1].c;
  const prevClose   = candles[candles.length - 2].c;

  // CHoCH bajista: tendencia alcista rota — precio cierra bajo último swing low
  // Requiere dos cierres para confirmar (no fakeout)
  if (lastClose < prevLow.price && prevClose < prevLow.price * 1.003) {
    return {
      type: 'CHOCH_SELL', label: '⚡ CHoCH BAJISTA',
      desc: 'Cambio de carácter — reversión bajista confirmada',
      level: prevLow.price, priority: 10 // máxima prioridad
    };
  }

  // CHoCH alcista: tendencia bajista rota
  if (lastClose > prevHigh.price && prevClose > prevHigh.price * 0.997) {
    return {
      type: 'CHOCH_BUY', label: '⚡ CHoCH ALCISTA',
      desc: 'Cambio de carácter — reversión alcista confirmada',
      level: prevHigh.price, priority: 10
    };
  }

  // BOS bajista: continuación — nuevo low bajo estructura bajista
  if (lastClose < lastLow.price && lastHigh.price < prevHigh.price) {
    return {
      type: 'BOS_SELL', label: '📉 BOS BAJISTA',
      desc: 'Quiebre de estructura bajista — continuación',
      level: lastLow.price, priority: 7
    };
  }

  // BOS alcista: continuación — nuevo high sobre estructura alcista
  if (lastClose > lastHigh.price && lastLow.price > prevLow.price) {
    return {
      type: 'BOS_BUY', label: '📈 BOS ALCISTA',
      desc: 'Quiebre de estructura alcista — continuación',
      level: lastHigh.price, priority: 7
    };
  }

  return null;
}

// ── CAPA 5: ZONAS DE LIQUIDEZ INSTITUCIONALES ────────────────
// Equal Highs/Lows + Order Blocks + zonas de volumen
function detectLiquidityZones(candles, price) {
  const zones = [];
  const lookback = Math.min(candles.length - 1, 50);

  // Equal Highs y Equal Lows — acumulación de stops retail
  const tolerance = price * 0.002; // 0.2% de tolerancia
  const highs = candles.slice(-lookback).map(c => c.h);
  const lows  = candles.slice(-lookback).map(c => c.l);

  // EQH — múltiples highs en el mismo nivel
  const highClusters = {};
  highs.forEach(h => {
    const key = Math.round(h / tolerance);
    highClusters[key] = (highClusters[key] || 0) + 1;
  });
  Object.entries(highClusters).forEach(([key, count]) => {
    if (count >= 2) {
      const level = parseInt(key) * tolerance;
      zones.push({ price: level, type: 'EQH', side: level > price ? 'above' : 'below',
                   strength: Math.min(1, count / 3), label: 'Equal Highs' });
    }
  });

  // EQL — múltiples lows en el mismo nivel
  const lowClusters = {};
  lows.forEach(l => {
    const key = Math.round(l / tolerance);
    lowClusters[key] = (lowClusters[key] || 0) + 1;
  });
  Object.entries(lowClusters).forEach(([key, count]) => {
    if (count >= 2) {
      const level = parseInt(key) * tolerance;
      zones.push({ price: level, type: 'EQL', side: level < price ? 'below' : 'above',
                   strength: Math.min(1, count / 3), label: 'Equal Lows' });
    }
  });

  // Order Blocks — última vela bajista antes de impulso alcista (y viceversa)
  for (let i = candles.length - 20; i < candles.length - 3; i++) {
    if (i < 0) continue;
    const c    = candles[i];
    const next = candles[i + 1];
    const next2 = candles[i + 2];

    // OB alcista: vela bajista seguida de dos velas alcistas fuertes
    if (c.c < c.o && next.c > next.o && next2.c > next2.o) {
      const moveSize = next2.h - c.l;
      if (moveSize / price > 0.005) { // movimiento significativo
        zones.push({ price: c.l, type: 'OB_BUY', side: 'below',
                     strength: moveSize / price * 10, label: 'Order Block Alcista' });
      }
    }
    // OB bajista: vela alcista seguida de dos velas bajistas fuertes
    if (c.c > c.o && next.c < next.o && next2.c < next2.o) {
      const moveSize = c.h - next2.l;
      if (moveSize / price > 0.005) {
        zones.push({ price: c.h, type: 'OB_SELL', side: 'above',
                     strength: moveSize / price * 10, label: 'Order Block Bajista' });
      }
    }
  }

  // Clasificar por proximidad al precio actual
  const nearZones = zones
    .filter(z => Math.abs(z.price - price) / price < 0.025) // dentro del 2.5%
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));

  return { zones, nearZones };
}

// ── CAPA 6: DETECCIÓN DE BALLENAS Y DARK POOL ────────────────
// Velas con volumen anómalo = actividad institucional
function detectWhaleActivity(candles, price) {
  if (candles.length < 20) return null;

  const vols    = candles.map(c => c.qv || c.v);
  const avgVol  = vols.slice(0, -5).reduce((a, b) => a + b, 0) / (vols.length - 5);
  const recentVols = vols.slice(-5);
  const maxRecent  = Math.max(...recentVols);

  // Volumen > 3x promedio = ballena / institución
  if (maxRecent < avgVol * 3) return null;

  const whaleCandle = candles[candles.length - 1 - (5 - recentVols.indexOf(maxRecent) - 1)];
  if (!whaleCandle) return null;

  const direction = whaleCandle.c > whaleCandle.o ? 'BUY' : 'SELL';
  const ratio     = maxRecent / avgVol;

  return {
    direction,
    volumeRatio: ratio,
    price: whaleCandle.c,
    label: ratio > 5 ? '🐋 Ballena extrema' : '🐋 Actividad institucional',
  };
}

// ── MOTOR NEURONAL — EVALUACIÓN POR CAPAS ────────────────────
// Retorna score 0-10 y dirección consensuada
function evaluateAllLayers({
  price, candles4H, candles1H, candles15m,
  fundingRate, oiHistory, lsRatio, vp
}) {
  const signals   = [];
  let score       = 0;
  let direction   = null; // 'BUY' | 'SELL' — se va confirmando capa por capa
  const confluences = [];

  // ── CAPA 1: POC + VALUE AREA ─────────────────────────────
  if (vp) {
    if (price > vp.poc) {
      signals.push({ layer: 1, dir: 'BUY',  weight: 1, label: `Precio > POC (${fmt(vp.poc, price)})` });
    } else {
      signals.push({ layer: 1, dir: 'SELL', weight: 1, label: `Precio < POC (${fmt(vp.poc, price)})` });
    }
    // VAH/VAL — extremos del Value Area
    if (price > vp.vah) {
      signals.push({ layer: 1, dir: 'SELL', weight: 0.5, label: 'Precio sobre VAH — sobrecomprado' });
    } else if (price < vp.val) {
      signals.push({ layer: 1, dir: 'BUY',  weight: 0.5, label: 'Precio bajo VAL — sobrevendido' });
    }
  }

  // ── CAPA 2: CVD + DELTA ──────────────────────────────────
  const cvd4H  = calcCVD(candles4H);
  const cvd1H  = calcCVD(candles1H);

  if (cvd4H.bullish) {
    signals.push({ layer: 2, dir: 'BUY',  weight: 1.5, label: `CVD 4H positivo — compras institucionales (${cvd4H.buyPct.toFixed(0)}% buy)` });
  } else if (cvd4H.bearish) {
    signals.push({ layer: 2, dir: 'SELL', weight: 1.5, label: `CVD 4H negativo — ventas institucionales (${(100-cvd4H.buyPct).toFixed(0)}% sell)` });
  }

  // Divergencia CVD — señal de distribución/acumulación oculta
  if (cvd4H.divergence) {
    const divDir = cvd4H.priceDir === 'up' ? 'SELL' : 'BUY';
    signals.push({ layer: 2, dir: divDir, weight: 2, label: `⚠️ Divergencia CVD — precio ${cvd4H.priceDir === 'up' ? 'sube' : 'baja'} pero CVD ${cvd4H.cvdDir === 'up' ? 'sube' : 'baja'} — ${divDir === 'SELL' ? 'distribución oculta' : 'acumulación oculta'}` });
  }

  // Confirmación CVD en 1H
  if (cvd1H.bullish && cvd4H.bullish) {
    signals.push({ layer: 2, dir: 'BUY',  weight: 1, label: 'CVD 1H confirma alcista' });
  } else if (cvd1H.bearish && cvd4H.bearish) {
    signals.push({ layer: 2, dir: 'SELL', weight: 1, label: 'CVD 1H confirma bajista' });
  }

  // ── CAPA 3: ESTRUCTURA CHoCH + BOS ──────────────────────
  const struct4H  = detectStructure(candles4H);
  const struct1H  = detectStructure(candles1H);

  if (struct4H) {
    const sDir = struct4H.type.includes('BUY') ? 'BUY' : 'SELL';
    const w    = struct4H.type.includes('CHOCH') ? 3 : 2; // CHoCH vale más
    signals.push({ layer: 3, dir: sDir, weight: w, label: `${struct4H.label} en 4H — ${struct4H.desc}` });
  }
  if (struct1H) {
    const sDir = struct1H.type.includes('BUY') ? 'BUY' : 'SELL';
    const w    = struct1H.type.includes('CHOCH') ? 1.5 : 1;
    signals.push({ layer: 3, dir: sDir, weight: w, label: `${struct1H.label} en 1H` });
  }

  // ── CAPA 4: STOP HUNT ────────────────────────────────────
  const sh4H = detectStopHunt(candles4H);
  const sh1H = detectStopHunt(candles1H);

  if (sh4H) {
    const shDir = sh4H.type === 'SH_BUY' ? 'BUY' : 'SELL';
    signals.push({ layer: 4, dir: shDir, weight: sh4H.strength * 2,
                   label: `${sh4H.type === 'SH_BUY' ? '🎯 Stop Hunt alcista' : '🎯 Stop Hunt bajista'} 4H — mecha ${(sh4H.strength * 100).toFixed(0)}% del rango` });
  }
  if (sh1H) {
    const shDir = sh1H.type === 'SH_BUY' ? 'BUY' : 'SELL';
    signals.push({ layer: 4, dir: shDir, weight: sh1H.strength * 1.2,
                   label: `${sh1H.type === 'SH_BUY' ? '🎯 SH alcista' : '🎯 SH bajista'} 1H` });
  }

  // ── CAPA 4b: ZONAS DE LIQUIDEZ ───────────────────────────
  const liqData = detectLiquidityZones(candles4H, price);
  const nearSup = liqData.nearZones.find(z => z.side === 'below' && z.strength > 0.5);
  const nearRes = liqData.nearZones.find(z => z.side === 'above' && z.strength > 0.5);

  if (nearSup) {
    signals.push({ layer: 4, dir: 'BUY',  weight: nearSup.strength,
                   label: `${nearSup.label} soporte en ${fmt(nearSup.price, price)}` });
  }
  if (nearRes) {
    signals.push({ layer: 4, dir: 'SELL', weight: nearRes.strength,
                   label: `${nearRes.label} resistencia en ${fmt(nearRes.price, price)}` });
  }

  // ── CAPA 4c: BALLENAS / DARK POOL ───────────────────────
  const whale = detectWhaleActivity(candles4H, price);
  if (whale) {
    signals.push({ layer: 4, dir: whale.direction, weight: Math.min(2, whale.volumeRatio / 3),
                   label: `${whale.label} x${whale.volumeRatio.toFixed(1)} volumen normal` });
  }

  // ── CAPA 5: FUNDING RATE — CONTRARIAN INSTITUCIONAL ──────
  const fr = fundingRate;
  if (fr.current < -0.02) {
    signals.push({ layer: 5, dir: 'BUY',  weight: 1.5, label: `FR muy negativo (${fr.current.toFixed(3)}%) — shorts sobreapalancados, pump probable` });
  } else if (fr.current < -0.01) {
    signals.push({ layer: 5, dir: 'BUY',  weight: 0.8, label: `FR negativo (${fr.current.toFixed(3)}%) — sesgo alcista` });
  } else if (fr.current > 0.05) {
    signals.push({ layer: 5, dir: 'SELL', weight: 1.5, label: `FR extremo (${fr.current.toFixed(3)}%) — longs sobreapalancados, corrección probable` });
  } else if (fr.current > 0.03) {
    signals.push({ layer: 5, dir: 'SELL', weight: 0.8, label: `FR alto (${fr.current.toFixed(3)}%) — sesgo bajista` });
  }

  // Tendencia del FR — si está subiendo/bajando confirma momentum
  if (fr.trend === 'rising') {
    signals.push({ layer: 5, dir: 'SELL', weight: 0.5, label: 'FR en aumento — acumulando presión bajista' });
  } else if (fr.trend === 'falling') {
    signals.push({ layer: 5, dir: 'BUY',  weight: 0.5, label: 'FR cayendo — alivio de longs, posible rebote' });
  }

  // ── CAPA 5b: OPEN INTEREST ───────────────────────────────
  if (oiHistory) {
    const cvdDir4H = cvd4H.bullish ? 'BUY' : cvd4H.bearish ? 'SELL' : null;

    // OI sube + precio sube = tendencia real
    if (oiHistory.trend === 'rising' && cvdDir4H === 'BUY') {
      signals.push({ layer: 5, dir: 'BUY',  weight: 1, label: `OI subiendo (${oiHistory.change > 0 ? '+' : ''}${oiHistory.change.toFixed(1)}%) + precio sube — tendencia alcista real` });
    }
    // OI sube + precio baja = shorts acumulándose — peligro squeeze
    if (oiHistory.trend === 'rising' && cvdDir4H === 'SELL') {
      signals.push({ layer: 5, dir: 'SELL', weight: 1, label: `OI subiendo + ventas — shorts acumulándose` });
    }
    // OI cae bruscamente = liquidaciones — buscar suelo/techo
    if (oiHistory.trend === 'falling' && Math.abs(oiHistory.change) > 5) {
      signals.push({ layer: 5, dir: 'BUY',  weight: 0.8, label: `OI cayendo (${oiHistory.change.toFixed(1)}%) — liquidaciones, posible suelo` });
    }
  }

  // ── CAPA 5c: LONG/SHORT RATIO ────────────────────────────
  if (lsRatio) {
    // Extremos son contrarian — cuando todos son longs, institucionales venden
    if (lsRatio.longs > 65) {
      signals.push({ layer: 5, dir: 'SELL', weight: 0.8, label: `L/S extremo (${lsRatio.longs.toFixed(0)}% longs) — euforia retail, institucionales posicionando short` });
    } else if (lsRatio.shorts > 65) {
      signals.push({ layer: 5, dir: 'BUY',  weight: 0.8, label: `L/S extremo (${lsRatio.shorts.toFixed(0)}% shorts) — pánico retail, institucionales acumulando` });
    }
  }

  // ── CAPA 6: CONFIRMACIÓN 15m — TIMING DE ENTRADA ─────────
  const cvd15m = calcCVD(candles15m);
  const sh15m  = detectStopHunt(candles15m);

  // 15m confirma la dirección macro — timing fino
  if (cvd15m.bullish) signals.push({ layer: 6, dir: 'BUY',  weight: 0.5, label: 'CVD 15m alcista — momentum confirma' });
  if (cvd15m.bearish) signals.push({ layer: 6, dir: 'SELL', weight: 0.5, label: 'CVD 15m bajista — momentum confirma' });
  if (sh15m) {
    const shDir = sh15m.type === 'SH_BUY' ? 'BUY' : 'SELL';
    signals.push({ layer: 6, dir: shDir, weight: 0.8, label: `SH en 15m — timing de entrada preciso` });
  }

  // ── CÁLCULO DEL SCORE PONDERADO ──────────────────────────
  let buyScore  = 0;
  let sellScore = 0;

  for (const sig of signals) {
    if (sig.dir === 'BUY')  buyScore  += sig.weight;
    if (sig.dir === 'SELL') sellScore += sig.weight;
  }

  const maxScore = Math.max(buyScore, sellScore);
  const minScore = Math.min(buyScore, sellScore);
  const netScore = maxScore - minScore; // diferencia — mide consenso

  if (buyScore  > sellScore) direction = 'BUY';
  if (sellScore > buyScore)  direction = 'SELL';
  if (Math.abs(buyScore - sellScore) < 1.5) direction = 'NEUTRAL'; // mercado indeciso

  // Score final normalizado 0-10
  const finalScore = Math.min(10, Math.round(netScore * 1.2));

  // Confluencias en la dirección ganadora para el mensaje
  const winnerConfs = signals
    .filter(s => s.dir === direction)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5)
    .map(s => s.label);

  return {
    direction,
    score: finalScore,
    buyScore, sellScore, netScore,
    confluences: winnerConfs,
    signals,
    cvd4H, struct4H, sh4H, liqData, whale,
    vp,
  };
}

// ── CONSTRUIR MENSAJE INSTITUCIONAL ─────────────────────────
function buildMessage(ticker, price, result, fr, oiHistory, lsRatio, session, killZone, dynATR) {
  const isBuy = result.direction === 'BUY';
  const atr   = dynATR || getATR(ticker, price);

  // SL/TP basados en ATR + estructura
  const sl  = isBuy ? price - atr * 1.5 : price + atr * 1.5;
  const tp1 = isBuy ? price + atr * 2   : price - atr * 2;
  const tp2 = isBuy ? price + atr * 3   : price - atr * 3;
  const tp3 = isBuy ? price + atr * 5   : price - atr * 5;

  const arrow   = isBuy ? '▲ BUY — COMPRA 🟢' : '▼ SELL — VENTA 🔴';
  const quality = result.score >= 8 ? '🔥 MÁXIMA CALIDAD'
                : result.score >= 6 ? '⭐ INSTITUCIONAL'
                : '✅ VÁLIDA';

  const kzLine   = killZone ? `\n⏰ Kill Zone: ${killZone.name}` : '';
  const whaleL   = result.whale ? `\n${result.whale.label}` : '';
  const structL  = result.struct4H ? `\n🔷 ${result.struct4H.label} 4H` : '';
  const shLine   = result.sh4H
    ? `\n🎯 Stop Hunt ${result.sh4H.type === 'SH_BUY' ? 'alcista' : 'bajista'} detectado` : '';
  const oiLine   = oiHistory?.change ? `\nOI: ${oiHistory.change > 0 ? '+' : ''}${oiHistory.change.toFixed(1)}%` : '';
  const lsLine   = lsRatio ? ` · L/S: ${lsRatio.longs.toFixed(0)}%L / ${lsRatio.shorts.toFixed(0)}%S` : '';
  const confList = result.confluences.map(c => `  • ${c}`).join('\n');

  return `🌐 <b>SEÑAL INSTITUCIONAL</b>
${arrow}

🎯 <b>${ticker}</b> · 4H 🔴${kzLine}
💰 Precio: <b>${fmt(price, price)}</b>
⭐ Score: ${result.score}/10 · ${quality}

📊 <b>Confluencias:</b>
${confList}${structL}${shLine}${whaleL}

📈 CVD: ${result.cvd4H.cvd > 0 ? '▲ Positivo' : '▼ Negativo'} · ${result.cvd4H.buyPct.toFixed(0)}% Buy${oiLine}${lsLine}
💸 FR: ${fr.current.toFixed(3)}%
📐 POC: ${result.vp ? fmt(result.vp.poc, price) : '—'} · VAH: ${result.vp ? fmt(result.vp.vah, price) : '—'} · VAL: ${result.vp ? fmt(result.vp.val, price) : '—'}
🌏 Sesión: ${session}

🛑 SL:  ${fmt(sl, price)}
✅ TP1: ${fmt(tp1, price)} · R:R 1:2
✅ TP2: ${fmt(tp2, price)} · R:R 1:3
🔶 TP3: ${fmt(tp3, price)} · R:R 1:5

⚡ LiquidMap PRO · Sistema Neuronal v4`;
}

// ── ENVIAR TELEGRAM ──────────────────────────────────────────
async function sendTelegram(text) {
  try {
    await Promise.all(CHAT_IDS.map(id =>
      fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: id, text, parse_mode: 'HTML',
                                  disable_web_page_preview: true }),
      })
    ));
    console.log(`[TG] ✅ Enviado: ${text.substring(0, 60).replace(/\n/g, ' ')}`);
  } catch(e) { console.error('[TG ERROR]', e.message); }
}

// ════════════════════════════════════════════════════════════
//  SCANNER NEURONAL PRINCIPAL
// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
//  CAPA 14 · ARCO VWAP SUPERTREND [BOSWaves] — FLIP CONFIRMADO
//  Independiente del score neuronal: el valor del flip es avisar el GIRO,
//  no esperar a que converjan las 6 capas. Reglas (calidad institucional):
//   · Solo flips CONFIRMADOS por VWAP de sesión (flip.confirmed).
//   · Solo sobre vela CERRADA (no la viva, que puede revertir) — !flip.live.
//   · 1 alerta por flip — dedup por timestamp del flip (anti-spam) en ARC_STATE.
//  CRYPTO: anclaje UTC (el diario de TV/Bybit cierra 00:00 UTC, NO en ET) —
//  sin esto los VWAPs resetean 4-5h corridos y el flip no coincide con TV.
// ════════════════════════════════════════════════════════════
const ARC_OPTS  = { anchorTz: 'UTC', filterPeriod: 'Session' };   // crypto 24/7 → ancla UTC
const ARC_STATE = {};                                             // {sym_tf: t del último flip alertado} — vive entre scans
const ARC_RECENT_BARS = 2;                                        // un flip solo es alertable si ocurrió en las últimas N velas CERRADAS → mata el backlog al (re)arrancar

function detectArcFlipAlerts(candles, sym, tf, state, opts) {
  const arc = computeArc(candles, opts || {});
  if (!arc || !arc.initialized || !arc.flips || !arc.flips.length) return [];
  const key = `${sym}_${tf}`;
  const lastT = state[key] || 0;

  // flips confirmados sobre vela CERRADA (la viva puede revertir → fuera)
  const closed = arc.flips.filter(f => f.confirmed && !f.live);
  if (!closed.length) { if (state[key] === undefined) state[key] = 0; return []; }
  const newestT = Math.max(...closed.map(f => f.t));

  // Ventana de RECENCIA: solo alertar flips de las últimas N velas cerradas. Resuelve el
  // spam de (re)arranque: el marcador anti-spam vive en memoria y se borra al reiniciar
  // (free tier reinicia seguido), así que sin esto el arco repetía TODO el historial de
  // flips de golpe. Con la ventana, al arrancar siembra su línea de base (state ← newestT)
  // y SOLO alerta un flip genuinamente fresco (de las últimas ARC_RECENT_BARS velas cerradas).
  const idxCut = candles.length - 1 - ARC_RECENT_BARS;
  const recentCutoff = idxCut >= 0 ? candles[idxCut].t : 0;
  const fresh = closed.filter(f => f.t > lastT && f.t >= recentCutoff);

  state[key] = Math.max(lastT, newestT);   // siembra/avanza el marcador SIEMPRE (evita re-alertar el backlog)
  if (!fresh.length) return [];
  return fresh.map(f => ({
    sym, tf, dir: f.bull ? 'BUY' : 'SELL', bull: f.bull, price: f.price, t: f.t,
    msg: `🌀 <b>ARCO FLIP ${f.bull ? 'ALCISTA 🟢' : 'BAJISTA 🔴'}</b> confirmado\n` +
         `${sym} · ${tf} · $${fmt(f.price, f.price)} · VWAP ✓\n` +
         `CAPA 14 — giro del arco (independiente del score). Confirmá estructura en el mapa / TV.`
  }));
}

async function scanTicker(ticker) {
  const s = getState(ticker);

  try {
    // ── PASO 1: Obtener todos los datos en paralelo ──────
    const [candles4H, candles1H, candles15m, fr, oiHistory, lsRatio, candlesArc4H] = await Promise.all([
      fetchCandles(ticker, '4h',  100),
      fetchCandles(ticker, '1h',  60),
      fetchCandles(ticker, '15m', 60),
      fetchFundingRate(ticker),
      fetchOIHistory(ticker),
      fetchLSRatio(ticker),
      fetchCandles(ticker, '4h',  200).catch(() => []),   // CAPA 14: velas dedicadas para el ARCO (≥110) — aislado, NO toca el VP/POC; .catch → NUNCA aborta el scan del ticker
    ]);

    if (candles4H.length < 30) return;

    const price   = candles4H[candles4H.length - 1].c;
    const candle4HId = candles4H[candles4H.length - 1].t;

    // ── CAPA 14 · FLIP DEL ARCO (independiente del score — dispara aunque el motor esté NEUTRAL) ──
    //   Va ANTES de las reglas de disparo del motor: el flip es su propia alerta, no la del score.
    try {
      if (candlesArc4H && candlesArc4H.length >= 110) {
        const arcFlips = detectArcFlipAlerts(candlesArc4H, ticker, '4H', ARC_STATE, ARC_OPTS);
        for (const fl of arcFlips) {
          await sendTelegram(fl.msg);
          hbSignal('crypto', `${ticker} ARCO ${fl.dir}`);   // señal real enviada (flip del arco)
          console.log(`[${ticker}] 🌀 ARCO FLIP ${fl.dir} @ $${fmt(fl.price, fl.price)} (CAPA 14, independiente del score)`);
        }
      }
    } catch (e) { console.error(`[${ticker}] ARCO flip error:`, e.message); }

    // ── PASO 2: Volume Profile sobre 4H ──────────────────
    const vp     = buildVolumeProfile(candles4H, 60);  // 60 = igual que el mapa (coherencia POC/VAH/VAL)
    const vwapData = calcRealVWAP(candles4H.slice(-80));
    const dynATR   = calcRealATR(candles4H, 14);

    // ── PASO 3: Motor neuronal — evaluar todas las capas ──
    const result = evaluateAllLayers({
      price, candles4H, candles1H, candles15m,
      fundingRate: fr, oiHistory, lsRatio, vp
    });

    const session  = getSession();
    const killZone = getKillZone();

    console.log(`[${ticker}] Dir=${result.direction} Score=${result.score}/10 BUY=${result.buyScore.toFixed(1)} SELL=${result.sellScore.toFixed(1)} KZ=${killZone?.name || '—'}`);

    // ── PASO 4: REGLAS DE DISPARO ─────────────────────────

    // REGLA 1: Sin dirección clara → silencio
    if (result.direction === 'NEUTRAL') {
      console.log(`[${ticker}] NEUTRAL — mercado indeciso, silencio`);
      return;
    }

    // REGLA 2: Score mínimo — calidad obligatoria
    let minScoreRequired = MIN_SCORE; // 6/10 base
    // En Kill Zone bajamos ligeramente el umbral — el timing es bueno
    if (killZone) minScoreRequired = Math.max(5, MIN_SCORE - 1);

    if (result.score < minScoreRequired) {
      console.log(`[${ticker}] Score insuficiente (${result.score}/${minScoreRequired}) — silencio`);
      return;
    }

    // ── ANTI-SPAM (FIX) ───────────────────────────────────
    // Antes: CUALQUIER scan con un CHoCH presente rompía el cooldown y
    // reenviaba (cada 5 min, por horas) → +1000 notificaciones repetidas.
    // Ahora: el CHoCH solo cuenta como NUEVO si cambió su tipo o su nivel,
    // y además solo se permite UNA señal por vela 4H por dirección
    // (el 4H casi no varía entre scans). Resultado: 1–2 señales por activo.

    // Firma del CHoCH actual (tipo + nivel). Si es igual a la última disparada,
    // NO se considera nuevo → no rompe el cooldown.
    // CHoCH actual (tipo + nivel). "Nuevo" (rompe cooldown) solo si cambió de dirección
    // o el nivel se movió ≥ MIN_CHOCH_ATR_MULT×ATR → mata el re-disparo por micro-giros (fix SOL).
    const chochNow    = (result.struct4H && result.struct4H.type.includes('CHOCH')) ? result.struct4H : null;
    const chochType   = chochNow ? chochNow.type : null;
    const chochLevel  = chochNow ? (chochNow.level || 0) : null;
    const atrForChoch = (dynATR && dynATR > 0) ? dynATR : price * 0.01;   // fallback 1% si no hay ATR
    const isNewChoch  = isNewChochATR(chochType, chochLevel, s.lastChochType, s.lastChochLevel, atrForChoch, MIN_CHOCH_ATR_MULT);

    const sameDir    = s.lastSignalDir === result.direction;
    const sameCandle = s.lastProcessedCandle4H === candle4HId;

    // REGLA 3: una señal por VELA 4H por dirección (mata el spam de 5-min)
    if (sameDir && sameCandle && !isNewChoch) {
      console.log(`[${ticker}] Ya señalado ${result.direction} en esta vela 4H — silencio (anti-spam)`);
      return;
    }

    // REGLA 4: Cooldown por tiempo (misma dirección), roto SOLO por CHoCH NUEVO
    const inCooldown = sameDir
                    && (Date.now() - s.lastSignalTs) < COOLDOWN_MS
                    && !isNewChoch;
    if (inCooldown) {
      const horasRestantes = ((COOLDOWN_MS - (Date.now() - s.lastSignalTs)) / 3600000).toFixed(1);
      console.log(`[${ticker}] Cooldown activo — misma dir sin CHoCH nuevo, ${horasRestantes}h restantes`);
      return;
    }

    // REGLA 5: Si hay CHoCH en dirección opuesta → contradice, silencio
    if (result.struct4H && result.struct4H.type.includes('CHOCH')) {
      const chochDir = result.struct4H.type.includes('BUY') ? 'BUY' : 'SELL';
      if (chochDir !== result.direction) {
        console.log(`[${ticker}] CHoCH contradice dirección — silencio`);
        return;
      }
    }

    // REGLA 6: Confluencia mínima de capas — al menos 3 capas deben concordar
    const layersInDirection = new Set(
      result.signals
        .filter(sig => sig.dir === result.direction)
        .map(sig => sig.layer)
    );
    if (layersInDirection.size < 3) {
      console.log(`[${ticker}] Solo ${layersInDirection.size} capas concordantes — necesita mínimo 3`);
      return;
    }

    // REGLA 7 · GUARDA HTF (opción B) — contra la tendencia mayor solo con BOS ──
    // Criterio de Gonzalo: el CHoCH marca cambio de carácter pero a menudo NO lo sigue
    // un movimiento sostenido; el BOS sí trae continuación violenta/prolongada. Por eso una
    // señal CONTRA el HTF (EMA200 4H) se permite SOLO si hay un BOS en su dirección. El CHoCH
    // NO se descarta (sigue sumando al score), pero por sí solo no habilita un disparo
    // contra la tendencia. Si no se puede calcular la EMA200 → NO silencia (no inventamos veto).
    {
      const ema200_4H = (candlesArc4H && candlesArc4H.length >= 200)
        ? emaLast(candlesArc4H.map(c => c.c), 200)
        : null;
      if (ema200_4H != null) {
        const againstHTF = (result.direction === 'BUY'  && price < ema200_4H) ||
                           (result.direction === 'SELL' && price > ema200_4H);
        if (againstHTF) {
          const st = result.struct4H;
          const bosInDir = !!st && st.type.includes('BOS') &&
            ((result.direction === 'BUY'  && st.type.includes('BUY')) ||
             (result.direction === 'SELL' && st.type.includes('SELL')));
          if (!bosInDir) {
            console.log(`[${ticker}] Contra HTF (EMA200 4H ${fmt(ema200_4H, price)}) sin BOS confirmando — solo CHoCH/sin estructura → silencio (REGLA 7 · opción B)`);
            return;
          }
        }
      }
    }

    // ── PASO 5: TODAS LAS REGLAS PASADAS → DISPARAR ───────
    console.log(`[${ticker}] ✅ SEÑAL NEURONAL VALIDADA: ${result.direction} score=${result.score}/10 capas=${layersInDirection.size}`);

    const msg = buildMessage(ticker, price, result, fr, oiHistory, lsRatio, session, killZone, dynATR);
    await sendTelegram(msg);
    hbSignal('crypto', `${ticker} ${result.direction} ${result.score}/10`);   // señal real enviada (neuronal)

    // Actualizar estado neuronal
    s.lastSignalDir = result.direction;
    s.lastSignalTs  = Date.now();
    s.lastSignalPrice = price;
    s.lastChochType  = chochType;    // tipo del CHoCH ya disparado (anti-flood ATR)
    s.lastChochLevel = chochLevel;   // nivel del CHoCH ya disparado (anti-flood ATR)
    s.lastStructure = result.direction;
    s.lastCVDDir    = result.cvd4H.bullish ? 'positive' : result.cvd4H.bearish ? 'negative' : 'neutral';
    s.lastOITrend   = oiHistory?.trend || 'neutral';
    s.lastProcessedCandle4H = candle4HId;

  } catch(e) {
    console.error(`[${ticker}] Error:`, e.message);
  }
}

// ── LOOP PRINCIPAL ────────────────────────────────────────────
async function runScan() {
  const now = new Date().toISOString();
  const kz  = getKillZone();
  console.log(`\n[SCAN] ${now} ${kz ? `· ⏰ ${kz.name}` : ''}`);
  hbBeat('crypto');                       // latido: el ciclo de scan disparó

  for (const ticker of CRYPTO_TICKERS) {
    await scanTicker(ticker);
    await new Promise(r => setTimeout(r, 1200));
  }
  console.log(`[SCAN] Completo.`);
}

// ── ARRANQUE ───────────────────────────────────────────────────
console.log('🧠 LiquidMap PRO Monitor v4 — SISTEMA NEURONAL INSTITUCIONAL');
console.log(`   Tickers  : ${CRYPTO_TICKERS.join(', ')}`);
console.log(`   Capas    : POC·CVD·OI·FR·CHoCH·BOS·SH·Zonas·Ballenas·L/S·15m`);
console.log(`   CAPA 14  : 🌀 ARCO FLIP [BOSWaves] 4H · confirmado VWAP · vela cerrada · independiente del score (UTC)`);
console.log(`   Score    : mínimo ${MIN_SCORE}/10 · mínimo 3 capas concordantes`);
console.log(`   Cooldown : 4H · roto solo por CHoCH NUEVO · 1 señal por vela 4H (anti-spam)`);
console.log(`   Kill Zones: London·NY·Overlap ponderadas`);
console.log(`   Data     : proxy Render → Bybit (klines/FR/OI/L-S)`);
console.log(`   Proxy    : ${PROXY} ${/127\.0\.0\.1|localhost/.test(PROXY) ? '(loopback local — no sale de la instancia)' : '(URL pública)'}`);
console.log(`   Scan     : cada 5 min — dispara solo cuando hay calidad real`);

hbBeat('crypto');                                // latido inmediato al arrancar (evita "unknown" hasta el 1er scan)
setInterval(() => hbBeat('crypto'), 60 * 1000);  // latido de proceso cada 60s (< stale 180s) — crypto 24/7, nunca en pausa

runScan();
setInterval(runScan, SCAN_INTERVAL);
