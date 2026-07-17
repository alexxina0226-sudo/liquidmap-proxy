// ─────────────────────────────────────────────────────────────────────────────
// arc_boswaves_v2.js — CAPA 14 · Arc VWAP Supertrend — PORT FIEL
//
// Port 1:1 a JavaScript del indicador Pine Script:
//   "Arc VWAP Supertrend [BOSWaves]" — © BOSWaves
//   Licencia original: Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/)
//   Este archivo es una obra derivada de ese código y conserva la MPL 2.0.
//
// POR QUÉ EXISTE ESTE PORT (sesión flip, 16/07/2026):
//   El clon anterior (arc_boswaves.js, CAPA 14) leía la dirección pero giraba
//   lejos del original, sobre todo en TF mayores. El original NO es un
//   supertrend de multiplicador fijo: es un ARCO ACELERADO — arranca lejos
//   (startMult × ATR-lento), acumula VELOCIDAD cada `smooth` velas, y acelera
//   más cuando el precio se estira lejos del VWAP. Esa mecánica (velocidad
//   acumulada + turbo por distancia a VWAP + ATR lento de 100) es lo que hace
//   que el giro caiga donde cae. Cualquier clon "a ojo" sin esos 3 motores
//   gira distinto. Este port replica la matemática exacta, en el mismo orden
//   de evaluación que Pine.
//
// EQUIVALENCIAS PINE → JS (documentadas para el diff):
//   ta.atr(14)          → RMA de Wilder sobre True Range, período 14
//   ta.sma(ta.tr, 100)  → SMA simple del True Range, período 100  (¡NO es ATR14!)
//   timeframe.change(D/W/M) → cambio de día/semana(lunes)/mes en UTC del open
//                             de la vela (exacto para crypto 24/7 en Bybit/UTC)
//   bar_index % smooth  → índice de vela DESDE EL INICIO DEL HISTORIAL cargado.
//                         Igual que en Pine, el arco depende de dónde arranca
//                         la historia. Cargar SIEMPRE la misma profundidad de
//                         velas para resultados reproducibles.
//   bar_index > 100     → el arco NO existe hasta la vela 101 con atrSlow listo.
//                         Alimentar con >100 velas o no hay arco (igual que TV).
//
// USO (streaming, una vela CONFIRMADA por llamada, en orden):
//   const arc = createArcVwapSupertrend({ accelRate:0.12, startMult:2.0,
//                                         smooth:3, filterPeriod:'Session',
//                                         vwapAccelBoost:1.5 });
//   for (const c of candles) out = arc.update(c);
//   // out = { ready, trend, arc, arcSmooth, rawFlipped, flipConfirmed,
//   //         flipFiltered, flipPrice, levels:[{price,bull,brokenAt|null}] }
//   Velas: { time(ms UTC del open), open, high, low, close, volume }
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const DEFAULTS = {
  accelRate: 0.12,       // "Arc Speed" — aceleración base
  startMult: 2.0,        // "Start Distance (ATR×)" — distancia inicial en atrSlow
  smooth: 3,             // "Smoothing" — cadencia de avance y ventana de SMA
  filterPeriod: 'Session', // 'Session' | 'Week' | 'Month' | 'Any' | 'All'
  vwapAccelBoost: 1.5,   // turbo de aceleración por distancia a VWAP (1.0 = sin turbo)
  maxLevels: 10,         // niveles de flip vivos como máximo (los viejos se van primero)
  initBars: 100,         // bar_index > 100 en el original — no tocar sin motivo
};

function createArcVwapSupertrend(opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);

  // ── estado VWAPs acumulados (hl2 × volumen, reset por período, como el Pine) ──
  let cumPvS = 0, cumVolS = 0;   // Session (día UTC)
  let cumPvW = 0, cumVolW = 0;   // Week (semana ISO, arranca lunes UTC)
  let cumPvM = 0, cumVolM = 0;   // Month (mes calendario UTC)
  let prevDayKey = null, prevWeekKey = null, prevMonthKey = null;

  // ── estado ATRs ──
  let prevClose = null;
  let atrRma = null;             // ta.atr(14) — RMA de Wilder
  const ATR_LEN = 14;
  let atrSeeded = 0, atrSeedSum = 0;
  const trWindow = [];           // para atrSlow = SMA(TR, 100)
  const ATR_SLOW_LEN = 100;
  let atrSlowSum = 0;

  // ── estado del arco (espejo exacto de las `var` del Pine) ──
  let trend = true;
  let arc = null;                // na hasta init
  let velocity = 0.0;
  let initDone = false;
  let barIndex = -1;

  // ── suavizados: SMA(arc, smooth) y niveles de flip ──
  const arcWindow = [];
  let arcWindowSum = 0;
  const levels = [];             // {price, bull, brokenAt|null}

  // día/semana/mes UTC de un timestamp (open de la vela)
  function periodKeys(tMs) {
    const d = new Date(tMs);
    const day = Math.floor(tMs / 86400000);            // día UTC
    // semana con arranque LUNES: corremos el epoch (jue 1/1/1970) 3 días
    const week = Math.floor((day + 3) / 7);
    const month = d.getUTCFullYear() * 12 + d.getUTCMonth();
    return { day, week, month };
  }

  function vwapAgrees(bullish, close, vS, vW, vM) {
    const s = bullish ? close >= vS : close <= vS;
    const w = bullish ? close >= vW : close <= vW;
    const m = bullish ? close >= vM : close <= vM;
    switch (cfg.filterPeriod) {
      case 'Session': return s;
      case 'Week':    return w;
      case 'Month':   return m;
      case 'Any':     return s || w || m;
      case 'All':     return s && w && m;
      default:        return true;
    }
  }

  function update(c) {
    barIndex += 1;
    const hl2 = (c.high + c.low) / 2;

    // ── 1) VWAPs: reset por cambio de período, luego acumular (orden Pine) ──
    const k = periodKeys(c.time);
    if (prevDayKey   !== null && k.day   !== prevDayKey)   { cumPvS = 0; cumVolS = 0; }
    if (prevWeekKey  !== null && k.week  !== prevWeekKey)  { cumPvW = 0; cumVolW = 0; }
    if (prevMonthKey !== null && k.month !== prevMonthKey) { cumPvM = 0; cumVolM = 0; }
    prevDayKey = k.day; prevWeekKey = k.week; prevMonthKey = k.month;
    cumPvS += hl2 * c.volume; cumVolS += c.volume;
    cumPvW += hl2 * c.volume; cumVolW += c.volume;
    cumPvM += hl2 * c.volume; cumVolM += c.volume;
    const vwapSession = cumVolS > 0 ? cumPvS / cumVolS : hl2;
    const vwapWeek    = cumVolW > 0 ? cumPvW / cumVolW : hl2;
    const vwapMonth   = cumVolM > 0 ? cumPvM / cumVolM : hl2;
    const refVwap = cfg.filterPeriod === 'Week'  ? vwapWeek
                  : cfg.filterPeriod === 'Month' ? vwapMonth
                  : vwapSession; // Session, Any, All → Session (igual que el Pine)

    // ── 2) True Range → ATR14 (RMA) y atrSlow (SMA100 del TR) ──
    const tr = prevClose === null
      ? (c.high - c.low)
      : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    prevClose = c.close;
    if (atrRma === null) {
      atrSeedSum += tr; atrSeeded += 1;
      if (atrSeeded === ATR_LEN) atrRma = atrSeedSum / ATR_LEN;
    } else {
      atrRma = (atrRma * (ATR_LEN - 1) + tr) / ATR_LEN; // Wilder
    }
    trWindow.push(tr); atrSlowSum += tr;
    if (trWindow.length > ATR_SLOW_LEN) atrSlowSum -= trWindow.shift();
    const atrSlow = trWindow.length === ATR_SLOW_LEN ? atrSlowSum / ATR_SLOW_LEN : null;

    // ── 3) turbo por distancia a VWAP (el motor que el clon no tenía) ──
    const atrSafe = (atrRma !== null && atrRma > 0) ? atrRma : 1;
    const vwapDistNorm = Math.min(Math.abs(c.close - refVwap) / (atrSafe * 4), 1.0);
    const effectiveAccel = cfg.accelRate * (1.0 + (cfg.vwapAccelBoost - 1.0) * vwapDistNorm);

    // ── 4) init: recién con atrSlow listo Y bar_index > initBars (fiel al Pine) ──
    if (!initDone && atrSlow !== null && barIndex > cfg.initBars) {
      arc = c.low - atrSlow * cfg.startMult;
      trend = true;
      initDone = true;
    }

    // ── 5) actualización de tendencia (mismo orden que el Pine) ──
    const prevTrend = trend;
    if (initDone) {
      if (c.close < arc) trend = false;
      if (c.close > arc) trend = true;
    }
    const rawFlipped = initDone && trend !== prevTrend;
    const flipConfirmed = rawFlipped && vwapAgrees(trend, c.close, vwapSession, vwapWeek, vwapMonth);
    const flipFiltered  = rawFlipped && !flipConfirmed;

    // ── 6) reset del arco en el flip: lejos del precio, velocidad a cero ──
    const slowSafe = (atrSlow !== null && atrSlow > 0) ? atrSlow : 1;
    let flipPrice = null;
    if (rawFlipped) {
      flipPrice = trend ? c.low : c.high; // nivel del flip (como los Flip Levels)
      arc = trend ? c.low - slowSafe * cfg.startMult
                  : c.high + slowSafe * cfg.startMult;
      velocity = 0.0;
      // registrar nivel de flip
      levels.push({ price: flipPrice, bull: trend, brokenAt: null });
      while (levels.filter(l => l.brokenAt === null).length > cfg.maxLevels) {
        const idx = levels.findIndex(l => l.brokenAt === null);
        if (idx >= 0) levels.splice(idx, 1); else break;
      }
    }

    // ── 7) avance del arco: SOLO cada `smooth` velas, con velocidad acumulada ──
    //      (el corazón de la precisión: curva parabólica, no trailing lineal)
    const stepSize = slowSafe * 0.15;
    if (initDone && barIndex % cfg.smooth === 0) {
      velocity += effectiveAccel;
      arc += (trend ? 1 : -1) * stepSize * velocity;
    }

    // ── 8) arcSmooth = SMA(arc, smooth) ──
    let arcSmooth = null;
    if (initDone) {
      arcWindow.push(arc); arcWindowSum += arc;
      if (arcWindow.length > cfg.smooth) arcWindowSum -= arcWindow.shift();
      arcSmooth = arcWindowSum / arcWindow.length;
    }

    // ── 9) romper niveles de flip con cierre confirmado (esta vela lo es) ──
    for (const l of levels) {
      if (l.brokenAt !== null) continue;
      const broken = l.bull ? c.close < l.price : c.close > l.price;
      if (broken) l.brokenAt = barIndex;
    }

    return {
      ready: initDone,
      barIndex, trend, arc, arcSmooth,
      rawFlipped, flipConfirmed, flipFiltered, flipPrice,
      vwapSession, vwapWeek, vwapMonth, refVwap,
      atr: atrRma, atrSlow, velocity, effectiveAccel,
      levels: levels.filter(l => l.brokenAt === null).map(l => ({ price: l.price, bull: l.bull })),
    };
  }

  return { update, config: cfg };
}

module.exports = { createArcVwapSupertrend, DEFAULTS };
