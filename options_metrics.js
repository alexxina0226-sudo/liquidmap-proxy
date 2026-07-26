// ════════════════════════════════════════════════════════════════════
//  options_metrics.js — GEX + Max Pain REALES (Algo Trader Plus · OPRA)
// ────────────────────────────────────────────────────────────────────
//  Pieza de matemática PURA (sin I/O, sin fetch) → testeable en banco.
//  El server le pasa el snapshot OPRA de cada contrato (greeks + IV nativas,
//  latestTrade/latestQuote) + el OI del endpoint de contratos + el subyacente
//  S real (SIP).
//
//  s68 — GRIEGAS NATIVAS: la gamma y la IV se leen DIRECTO del snapshot de
//  Alpaca (OPRA), precomputadas. El camino Black-Scholes (invertir el precio
//  de la opción → IV → gamma por bisección) queda como FALLBACK para cuando
//  el feed no trae griegas (contrato ilíquido / snapshot vacío). La cobertura
//  reporta el split nativo vs BS.
//
//  HONESTIDAD del modelo (lo que es real vs lo que es supuesto):
//   · gamma/IV → REAL (griegas OPRA nativas; BS solo como respaldo medido)
//   · OI       → REAL (Alpaca contracts, T+1, igual que todo proveedor de GEX)
//   · signo dealer → SUPUESTO estándar "naive": dealers LARGOS en calls,
//     CORTOS en puts. Es la convención pública (SqueezeMetrics/SpotGamma).
//     Por eso el GEX es un MODELO honesto, no una verdad absoluta — y así
//     se etiqueta en el mapa.
// ════════════════════════════════════════════════════════════════════
'use strict';

// ── Normal estándar ──────────────────────────────────────────────────
const SQRT2PI_INV = 0.3989422804014327;
const normPdf = x => SQRT2PI_INV * Math.exp(-x * x / 2);
function normCdf(x) {                              // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = SQRT2PI_INV * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

// ── Black-Scholes precio y gamma ─────────────────────────────────────
function bsD1(S, K, T, r, sig) {
  return (Math.log(S / K) + (r + sig * sig / 2) * T) / (sig * Math.sqrt(T));
}
function bsPrice(type, S, K, T, r, sig) {
  if (T <= 0 || sig <= 0) return Math.max(0, type === 'call' ? S - K : K - S);
  const d1 = bsD1(S, K, T, r, sig), d2 = d1 - sig * Math.sqrt(T);
  return type === 'call'
    ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
    : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}
// gamma es idéntica para call y put
function bsGamma(S, K, T, r, sig) {
  if (T <= 0 || sig <= 0 || S <= 0) return 0;
  const d1 = bsD1(S, K, T, r, sig);
  return normPdf(d1) / (S * sig * Math.sqrt(T));
}

// ── IV implícita por bisección (invierte el precio real de la opción) ─
// Devuelve la IV (σ) que hace bsPrice = precio de mercado, o null si el
// precio está fuera de rango (por debajo del intrínseco / arbitraje).
function impliedVol(type, price, S, K, T, r) {
  if (!(price > 0) || T <= 0 || S <= 0 || K <= 0) return null;
  const f = s => bsPrice(type, S, K, T, r, s) - price;   // creciente en σ
  let lo = 0.005, hi = 5.0;
  if (f(lo) > 0 || f(hi) < 0) return null;               // sin bracket → fuera de rango
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (Math.abs(fm) < 1e-6) return mid;
    if (fm > 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// ── MAX PAIN (solo necesita OI — robusto aunque falte el precio) ──────
// Para cada precio candidato de liquidación S* (cada strike), suma el cash
// que pagarían los writers a los holders al vencimiento. El Max Pain es el
// S* que MINIMIZA ese total (donde los compradores cobran lo menos posible).
function computeMaxPain(contracts) {
  const calls = contracts.filter(c => c.type === 'call' && c.oi > 0);
  const puts  = contracts.filter(c => c.type === 'put'  && c.oi > 0);
  const strikes = [...new Set(contracts.filter(c => c.oi > 0).map(c => c.strike))].sort((a, b) => a - b);
  if (!strikes.length) return { maxPain: null, table: [] };
  let best = null;
  const table = strikes.map(S => {
    let pain = 0;
    for (const c of calls) if (c.strike < S) pain += c.oi * (S - c.strike);
    for (const p of puts)  if (p.strike > S) pain += p.oi * (p.strike - S);
    pain *= 100;                                          // multiplicador de contrato
    if (best === null || pain < best.pain) best = { strike: S, pain };
    return { strike: S, pain };
  });
  return { maxPain: best.strike, totalPain: best.pain, table };
}

// ── GEX por strike + paredes + régimen ───────────────────────────────
// contracts: [{strike, type, oi, gamma}]  ·  S: subyacente real
// GEX(strike) = (γcall·OIcall − γput·OIput) · 100 · S² · 0.01   [$ por 1% de movimiento]
// (convención naive: dealers largos calls / cortos puts)
function aggregateGEX(contracts, S) {
  const byStrike = new Map();
  for (const c of contracts) {
    if (!(c.oi > 0) || !(c.gamma > 0)) continue;
    let row = byStrike.get(c.strike);
    if (!row) { row = { strike: c.strike, callOI: 0, putOI: 0, callGEX: 0, putGEX: 0 }; byStrike.set(c.strike, row); }
    const dollar = c.gamma * c.oi * 100 * S * S * 0.01;
    if (c.type === 'call') { row.callOI += c.oi; row.callGEX += dollar; }
    else                   { row.putOI  += c.oi; row.putGEX  += dollar; }
  }
  const rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  let totalGEX = 0, callWall = null, putWall = null;
  for (const r of rows) {
    r.netGEX = r.callGEX - r.putGEX;
    totalGEX += r.netGEX;
    if (callWall === null || r.callGEX > callWall.callGEX) callWall = r;
    if (putWall  === null || r.putGEX  > putWall.putGEX)   putWall  = r;
  }
  // Gamma flip: strike donde el GEX POR STRIKE cruza de negativo a positivo,
  // el más cercano al spot. Debajo del flip mandan los puts (short gamma / volátil);
  // arriba mandan los calls (long gamma / pin). Útil incluso en mensuales put-heavy
  // donde el acumulado no cruza dentro de la banda.
  let flip = null, flipDist = Infinity;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].netGEX < 0 && rows[i].netGEX >= 0) {
      const lvl = rows[i].strike, d = Math.abs(lvl - S);
      if (d < flipDist) { flipDist = d; flip = lvl; }
    }
  }
  return {
    totalGEX,
    regime: totalGEX >= 0 ? 'LONG_GAMMA' : 'SHORT_GAMMA',   // long=pin/baja-vol · short=amplifica/alta-vol
    callWall: callWall ? callWall.strike : null,
    putWall:  putWall  ? putWall.strike  : null,
    gammaFlip: flip,
    rows,
  };
}

// ── Tiempo a vencimiento (16:00 ET del día de exp, robusto en TZ UTC) ─
function etCloseMs(dateStr) {
  // offset ET para esa fecha vía Intl: a las 16:00 UTC, ¿qué hora ET es?
  const at16UTC = new Date(dateStr + 'T16:00:00Z');
  const etHour  = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' }).format(at16UTC), 10) % 24;
  const offset  = etHour - 16;                       // -4 (EDT) ó -5 (EST)
  const utcHour = 16 - offset;                        // 16:00 ET en UTC (20 ó 21)
  return Date.parse(dateStr + 'T' + String(utcHour).padStart(2, '0') + ':00:00Z');
}
function yearsToExpiry(dateStr, nowMs) {
  const yr = (etCloseMs(dateStr) - nowMs) / (365.25 * 24 * 3600 * 1000);
  return Math.max(yr, 1 / (365.25 * 24));            // piso de 1 hora (evita 0DTE → ∞)
}

// ── Arma contratos desde el payload CRUDO de Alpaca (testeable) ───────
// rawContracts: array del endpoint /v2/options/contracts (strike_price, type,
//   open_interest, close_price, expiration_date, symbol — todos string).
// snapshots: mapa symbol→snapshot de /v1beta1/options/snapshots (feed=opra).
//   Cada snapshot trae greeks{delta,gamma,theta,vega,rho} e impliedVolatility
//   NATIVOS (Algo Trader Plus · OPRA), + latestTrade/latestQuote. OJO: el snapshot
//   de OPCIONES NO trae dailyBar (eso es del snapshot de ACCIONES) → el precio de
//   referencia sale del mid del quote / last trade / close_price.
//
// CAMINO NATIVO (s68): si el snapshot trae gamma+IV, se usan DIRECTO — exactas, sin
//   reconstruir. FALLBACK Black-Scholes: si faltan (feed sin dato / contrato ilíquido),
//   se invierte el precio de opción por bisección, como antes. La cobertura reporta el
//   split nativo vs BS para medir cuánto entra por cada camino.
// Devuelve los contratos para Max Pain (oi) y para GEX (gamma) + cobertura.
function buildContracts({ rawContracts, snapshots, spot, expiration, r, nowMs }) {
  const T = yearsToExpiry(expiration, nowMs);
  const snap = snapshots || {};
  const oiContracts = [], gammaContracts = [];
  let con_oi = 0, con_precio = 0, con_iv = 0, con_native = 0, con_bs = 0, total = 0;
  for (const c of rawContracts) {
    if (c.expiration_date !== expiration) continue;
    total++;
    const type = c.type === 'call' ? 'call' : (c.type === 'put' ? 'put' : null);
    const strike = Number(c.strike_price);
    const oi = Number(c.open_interest);
    if (!type || !(strike > 0)) continue;
    if (oi > 0) { oiContracts.push({ strike, type, oi }); con_oi++; }
    const s = snap[c.symbol] || null;

    // 1) NATIVO — griegas + IV de Alpaca (OPRA), sin reconstruir nada
    let gamma = null, iv = null, delta = null, theta = null, vega = null, src = null;
    const g = s && s.greeks;
    if (g && Number(g.gamma) > 0 && Number(s.impliedVolatility) > 0) {
      gamma = Number(g.gamma); iv = Number(s.impliedVolatility);
      delta = Number(g.delta); theta = Number(g.theta); vega = Number(g.vega);
      src = 'opra';
    }

    // precio de referencia: mid del quote → last trade → dailyBar (por si acaso) → close_price
    let price = null;
    if (s) {
      const q = s.latestQuote;
      if (q && Number(q.bp) > 0 && Number(q.ap) > 0) price = (Number(q.bp) + Number(q.ap)) / 2;
      else if (s.latestTrade && Number(s.latestTrade.p) > 0) price = Number(s.latestTrade.p);
      else if (s.dailyBar && Number(s.dailyBar.c) > 0) price = Number(s.dailyBar.c);
    }
    if (!(price > 0) && Number(c.close_price) > 0) price = Number(c.close_price);
    if (price > 0) con_precio++;

    // 2) FALLBACK Black-Scholes — solo si el nativo NO vino (bisección sobre el precio)
    if (gamma === null && oi > 0 && price > 0) {
      const ivBS = impliedVol(type, price, spot, strike, T, r);
      if (ivBS !== null) {
        const gBS = bsGamma(spot, strike, T, r, ivBS);
        if (gBS > 0) { gamma = gBS; iv = ivBS; src = 'bs'; }
      }
    }

    if (oi > 0 && gamma > 0) {
      gammaContracts.push({ strike, type, oi, gamma, iv, delta, theta, vega, src, price });
      con_iv++;
      if (src === 'opra') con_native++; else if (src === 'bs') con_bs++;
    }
  }
  return { T, oiContracts, gammaContracts, coverage: { total, con_oi, con_precio, con_iv, con_native, con_bs } };
}

// ── Elige la expiración objetivo desde el payload crudo de contratos ──
// mode 'nearest'  → la más próxima (>= hoy)         [0DTE en SPY]
// mode 'monthly'  → la de MAYOR open interest total  [auto-encuentra la mensual,
//                   que es la más líquida, sin depender del 3er-viernes]
// Devuelve 'YYYY-MM-DD' o null. today = 'YYYY-MM-DD'.
function pickExpiration(rawContracts, mode, today) {
  const byExp = new Map();                           // exp → OI total
  for (const c of rawContracts) {
    const e = c.expiration_date;
    if (!e || (today && e < today)) continue;
    byExp.set(e, (byExp.get(e) || 0) + (Number(c.open_interest) || 0));
  }
  const exps = [...byExp.keys()].sort();
  if (!exps.length) return null;
  if (mode === 'monthly') {
    let best = exps[0], bestOI = -1;
    for (const e of exps) { const oi = byExp.get(e); if (oi > bestOI) { bestOI = oi; best = e; } }
    return best;
  }
  return exps[0];                                    // 'nearest' por defecto
}

module.exports = {
  normPdf, normCdf, bsD1, bsPrice, bsGamma, impliedVol,
  computeMaxPain, aggregateGEX,
  etCloseMs, yearsToExpiry, buildContracts, pickExpiration,
};
