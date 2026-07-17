// ════════════════════════════════════════════════════════════════════════════
//  ARC VWAP SUPERTREND — PORT JAVASCRIPT PARA LIQUIDMAP PRO
//  Original: "Arc VWAP Supertrend [BOSWaves]" · Pine Script v6 · © BOSWaves
//  Licencia del original: Mozilla Public License 2.0 (open source)
//  https://mozilla.org/MPL/2.0/ — portado con atribución. No es copia del
//  archivo Pine: es una reimplementación del algoritmo en JS para nuestro
//  motor (bot bolsa + futuro RADAR), manteniendo la matemática exacta.
//
//  QUÉ ES (anatomía leída del código fuente, 12-jun-2026):
//  No es un SuperTrend clásico. Es un trailing ACELERADO tipo parabólico:
//  · El arco nace a startMult×ATRlento del precio y lo persigue acelerando:
//    cada `smooth` velas, velocity += accel y el arco avanza ATRlento×0.15×velocity.
//  · La aceleración se potencia hasta `vwapAccelBoost`× cuando el precio está
//    extendido del VWAP (distancia normalizada por 4×ATR14) → cierra los giros
//    justo cuando el movimiento se agota lejos del valor.
//  · Flip = el cierre cruza el arco. CONFIRMADO = el cierre además está del
//    lado correcto del VWAP elegido (Session por defecto — el par que usamos).
//  · Los flips dejan NIVELES (low del flip bull / high del flip bear) que
//    viven como S/R hasta que un cierre los rompe.
//
//  FIDELIDAD Y LÍMITES (honestidad ante todo):
//  · ATR lento = SMA(TR,100) — igual al Pine (ta.sma(ta.tr,100)), NO Wilder.
//  · ATR rápido = RMA(TR,14) — igual a ta.atr(14).
//  · Init: tras la barra 100 con ATR lento listo (bar_index > 100 del Pine).
//    ⇒ NECESITA 110+ velas; con ~190 velas 4H de sesión (120 días de 15m) el
//    arco pasa por varios flips y converge — estado independiente del inicio.
//  · El paso de aceleración usa i % smooth (índice local); TV usa bar_index
//    global → puede haber desfase de 1-2 velas en el instante exacto del paso.
//    El flip en sí NO depende de eso (usa el arco crudo), pero velas límite
//    pueden flipear ±1 vela vs TV. Documentado, no oculto.
//  · VWAPs anclados en hora ET (America/New_York): sesión = día ET,
//    semana = lunes ET, mes = mes ET — equivalente a timeframe.change().
//  · El flip usa el ARCO CRUDO (como el Pine); arcSmooth es solo visual.
//
//  USO:
//    const { computeArc } = require('./arc_boswaves.js');
//    const arc = computeArc(candles);            // candles: [{t,o,h,l,c,v}] en ms
//    // arc.trend 'BULL'|'BEAR' · arc.lastFlip {index,t,price,bull,confirmed,live}
//    // arc.levels niveles vivos · arc.vwapSession/Week/Month · arc.initialized
//  TEST:  node arc_boswaves.js  → corre la batería de autovalidación.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const ARC_DEFAULTS = {
  accelRate:      0.12,      // Arc Speed (Pine default)
  startMult:      2.0,       // Start Distance ATR× (Pine default)
  smooth:         3,         // Smoothing (Pine default)
  vwapAccelBoost: 1.5,       // VWAP Distance Speed Boost (Pine default)
  filterPeriod:   'Session', // 'Session' | 'Week' | 'Month' | 'Any' | 'All'
  initBars:       100,       // bar_index > 100 del Pine
  maxLevels:      10,        // Max Levels (Pine default)
  anchorTz:       'America/New_York', // anclaje de sesión/semana/mes:
  //   'America/New_York' → BOLSA (velas diarias TV de equities cierran en ET)
  //   'UTC'              → CRYPTO (BTC/Bybit/Binance: el diario de TV cierra 00:00 UTC)
  //   Visto en los charts BTCUSDT de Gonzalo (12-jun): para clonar el arco en el
  //   monitor crypto hay que anclar en UTC o los VWAPs resetean 4-5h corridos.
};

// ── Fecha anclada (ET o UTC) → claves de sesión/semana/mes ──────────────────
const _fmtCache = new Map();
function _tzFmt(tz) {
  if (!_fmtCache.has(tz)) {
    _fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }));
  }
  return _fmtCache.get(tz);
}
function _tzParts(tMs, tz) {
  if (tz === 'UTC') {
    const d = new Date(tMs);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  const p = _tzFmt(tz).formatToParts(new Date(tMs));
  const g = t => p.find(x => x.type === t).value;
  return { y: +g('year'), m: +g('month'), d: +g('day') };
}
function _dayKey(tMs, tz)   { const e = _tzParts(tMs, tz); return `${e.y}-${e.m}-${e.d}`; }
function _monthKey(tMs, tz) { const e = _tzParts(tMs, tz); return `${e.y}-${e.m}`; }
function _weekKey(tMs, tz) {
  // Semana ISO sobre la fecha anclada (lunes inicia semana, como timeframe.change("W"))
  const e = _tzParts(tMs, tz);
  const d = new Date(Date.UTC(e.y, e.m - 1, e.d));
  const dayNum = (d.getUTCDay() + 6) % 7;            // lunes=0
  d.setUTCDate(d.getUTCDate() - dayNum + 3);         // jueves de la semana
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

// ── Núcleo: recorrido vela a vela, estado idéntico al Pine ──────────────────
function computeArc(candles, opts = {}) {
  const o = { ...ARC_DEFAULTS, ...opts };
  const n = candles ? candles.length : 0;
  const minBars = o.initBars + 10;
  if (n < minBars) {
    return { initialized: false, bars: n, reason: `necesita ${minBars}+ velas (hay ${n})` };
  }

  // Series de TR para ATR rápido (RMA 14) y lento (SMA 100)
  const tr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    tr[i] = i === 0 ? (c.h - c.l)
      : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c));
  }

  // Estado del arco (var del Pine)
  let trend = true, arc = NaN, velocity = 0, initDone = false;
  let atr14 = null;                       // RMA Wilder
  let trSum100 = 0;                       // ventana móvil para SMA(TR,100)
  let atrSlow = null;

  // VWAPs anclados (cum reset al cambiar período, como timeframe.change)
  let cumPvS = 0, cumVolS = 0, vwapSession = NaN, dayK = null;
  let cumPvW = 0, cumVolW = 0, vwapWeek = NaN,   weekK = null;
  let cumPvM = 0, cumVolM = 0, vwapMonth = NaN,  monthK = null;

  const flips = [];
  const levels = [];      // { price, bull, t, index } — vivos hasta rotura

  const vwapAgrees = (bullish, close) => {
    const s = bullish ? close >= vwapSession : close <= vwapSession;
    const w = bullish ? close >= vwapWeek    : close <= vwapWeek;
    const m = bullish ? close >= vwapMonth   : close <= vwapMonth;
    switch (o.filterPeriod) {
      case 'Session': return s;
      case 'Week':    return w;
      case 'Month':   return m;
      case 'Any':     return s || w || m;
      case 'All':     return s && w && m;
      default:        return true;
    }
  };

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const hl2 = (c.h + c.l) / 2;
    const vol = c.v || 0;
    const isLast = i === n - 1;

    // ── VWAPs (reset ANTES de sumar la vela del período nuevo, como el Pine) ──
    const dk = _dayKey(c.t, o.anchorTz), wk = _weekKey(c.t, o.anchorTz), mk = _monthKey(c.t, o.anchorTz);
    if (dk !== dayK)   { cumPvS = 0; cumVolS = 0; dayK = dk; }
    if (wk !== weekK)  { cumPvW = 0; cumVolW = 0; weekK = wk; }
    if (mk !== monthK) { cumPvM = 0; cumVolM = 0; monthK = mk; }
    cumPvS += hl2 * vol; cumVolS += vol; vwapSession = cumVolS > 0 ? cumPvS / cumVolS : hl2;
    cumPvW += hl2 * vol; cumVolW += vol; vwapWeek    = cumVolW > 0 ? cumPvW / cumVolW : hl2;
    cumPvM += hl2 * vol; cumVolM += vol; vwapMonth   = cumVolM > 0 ? cumPvM / cumVolM : hl2;

    // ── ATRs ──
    atr14 = (i < 14)
      ? (i === 13 ? tr.slice(0, 14).reduce((a, b) => a + b, 0) / 14 : atr14)
      : (atr14 * 13 + tr[i]) / 14;                       // RMA Wilder = ta.atr(14)
    trSum100 += tr[i];
    if (i >= 100) trSum100 -= tr[i - 100];
    atrSlow = i >= 99 ? trSum100 / 100 : null;           // SMA(TR,100) = ta.sma(ta.tr,100)
    const safeSlow = atrSlow !== null && atrSlow > 0 ? atrSlow : 1;
    const safeAtr  = atr14 !== null && atr14 > 0 ? atr14 : 1;

    // ── Init (Pine: not initDone and not na(atrSlow) and bar_index > 100) ──
    if (!initDone && atrSlow !== null && i > o.initBars) {
      arc = c.l - safeSlow * o.startMult;
      trend = true;
      initDone = true;
      // Fix fidelidad 17-jul-2026: SIN `continue`. El Pine en la barra de init
      // sigue de largo: evalúa flip (no-op, el arco nace bajo el low) y avanza
      // si toca cadencia. El continue viejo corría la fase 1 avance en mesetas.
    }
    if (!initDone) continue;

    // ── Detección de flip (cierre cruza el arco CRUDO) ──
    const prevTrend = trend;
    if (c.c < arc) trend = false;
    if (c.c > arc) trend = true;
    const rawFlipped    = trend !== prevTrend;
    const flipConfirmed = rawFlipped && vwapAgrees(trend, c.c);

    if (rawFlipped) {
      // Reposicionar el arco al otro lado con aire de startMult×ATRlento
      if (trend) { arc = c.l - safeSlow * o.startMult; }
      else       { arc = c.h + safeSlow * o.startMult; }
      velocity = 0;
      const lvlPrice = trend ? c.l : c.h;
      flips.push({ index: i, t: c.t, price: lvlPrice, bull: trend, confirmed: flipConfirmed, live: isLast });
      levels.push({ price: lvlPrice, bull: trend, t: c.t, index: i });
      while (levels.length > o.maxLevels) levels.shift();
    }

    // ── Rotura de niveles (cierre confirmado a través del nivel) ──
    if (!isLast || true) {   // los cierres históricos son confirmados; el live se evalúa igual y se re-evalúa en el próximo scan
      for (let k = levels.length - 1; k >= 0; k--) {
        const L = levels[k];
        if (L.index === i) continue;                     // no romper el nivel recién nacido con su propia vela
        const broken = L.bull ? c.c < L.price : c.c > L.price;
        if (broken && !isLast) levels.splice(k, 1);      // el live no borra niveles (puede arrepentirse)
      }
    }

    // ── Aceleración del arco (cada `smooth` velas, índice local) ──
    // Fix fidelidad 17-jul-2026: el Pine normaliza contra refVwap (según
    // filterPeriod), no siempre contra Session. Con 'Session' es idéntico.
    const refVwap = o.filterPeriod === 'Week'  ? vwapWeek
                  : o.filterPeriod === 'Month' ? vwapMonth
                  : vwapSession;
    const vwapDistNorm   = Math.min(Math.abs(c.c - refVwap) / (safeAtr * 4), 1.0);
    const effectiveAccel = o.accelRate * (1.0 + (o.vwapAccelBoost - 1.0) * vwapDistNorm);
    if (i % o.smooth === 0) {
      velocity += effectiveAccel;
      const stepSize = safeSlow * 0.15;
      arc += (trend ? 1 : -1) * stepSize * velocity;
    }
  }

  const last = candles[n - 1];
  const lastFlip = flips.length ? flips[flips.length - 1] : null;
  return {
    initialized: initDone,
    bars: n,
    activeBars: initDone ? n - 1 - o.initBars : 0,
    trend: trend ? 'BULL' : 'BEAR',
    arc,
    velocity,
    atr14, atrSlow,
    vwapSession, vwapWeek, vwapMonth,
    vwapAgreesNow: vwapAgrees(trend, last.c),
    flips,
    lastFlip,
    flipAgeBars: lastFlip ? (n - 1 - lastFlip.index) : null,
    levels: levels.slice(),     // niveles S/R vivos
    price: last.c,
  };
}

module.exports = { computeArc, ARC_DEFAULTS };

// ════════════════════════════════════════════════════════════════════════════
//  AUTOVALIDACIÓN — node arc_boswaves.js
//  Fixtures sintéticos SOLO para test unitario (jamás datos de producto).
// ════════════════════════════════════════════════════════════════════════════
if (require.main === module) {
  const mk = (price, i, vol = 1e6) => ({
    t: Date.UTC(2026, 0, 5) + i * 4 * 3600 * 1000,   // velas "4H" consecutivas
    o: price, h: price * 1.004, l: price * 0.996, c: price, v: vol,
  });

  // 1) Tendencia alcista sostenida → arco BULL, sin flip bajista al final
  let up = []; let p = 100;
  for (let i = 0; i < 200; i++) { up.push(mk(p, i)); p *= 1.004; }
  const A = computeArc(up);
  console.log(`T1 alcista   → init:${A.initialized} trend:${A.trend} flips:${A.flips.length} activeBars:${A.activeBars}`);

  // 2) Subida fuerte y luego desplome → el último flip debe ser BEAR
  let vshape = []; p = 100;
  for (let i = 0; i < 150; i++) { vshape.push(mk(p, i)); p *= 1.005; }
  for (let i = 150; i < 200; i++) { vshape.push(mk(p, i)); p *= 0.99; }
  const B = computeArc(vshape);
  const lfB = B.lastFlip;
  console.log(`T2 giro BEAR → trend:${B.trend} lastFlip:${lfB ? (lfB.bull ? 'BULL' : 'BEAR') + ' idx ' + lfB.index + ' conf:' + lfB.confirmed : 'ninguno'}`);

  // 3) Desplome y recuperación → último flip BULL confirmado (precio sobre VWAP al girar)
  let rec = []; p = 200;
  for (let i = 0; i < 150; i++) { rec.push(mk(p, i)); p *= 0.995; }
  for (let i = 150; i < 210; i++) { rec.push(mk(p, i)); p *= 1.012; }
  const C = computeArc(rec);
  const lfC = C.lastFlip;
  console.log(`T3 giro BULL → trend:${C.trend} lastFlip:${lfC ? (lfC.bull ? 'BULL' : 'BEAR') + ' idx ' + lfC.index + ' conf:' + lfC.confirmed : 'ninguno'} niveles vivos:${C.levels.length}`);

  // 4) Datos insuficientes → fail-open limpio
  const D = computeArc(up.slice(0, 50));
  console.log(`T4 pocos datos → init:${D.initialized} (${D.reason})`);

  const ok = A.initialized && A.trend === 'BULL'
        && B.trend === 'BEAR' && lfB && !lfB.bull
        && C.trend === 'BULL' && lfC && lfC.bull && lfC.confirmed
        && !D.initialized;
  console.log(ok ? '✅ ARCO VALIDADO — las 4 pruebas pasan' : '❌ FALLO en la batería');
  process.exit(ok ? 0 : 1);
}
