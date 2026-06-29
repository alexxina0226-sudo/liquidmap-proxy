// ════════════════════════════════════════════════════════════════════
//  options_live.js — capa REUSABLE: trae el dato real de Alpaca y calcula
//  GEX (Black-Scholes) + Max Pain con options_metrics.js.
// ────────────────────────────────────────────────────────────────────
//  La usan el SERVER (ruta /alpaca-options-metrics) y el BOT (monitor),
//  así los dos muestran lo MISMO (nunca divergen).
//
//  · auto-selección de expiración: 'monthly' (mayor OI = la mensual líquida)
//    ó 'nearest' (la más próxima, 0DTE en SPY).
//  · caché en memoria (TTL 10 min): el GEX es de resolución diaria, no hace
//    falta recalcular a cada tick → ahorra llamadas a Alpaca.
//  · NADA sintético: gamma = BS sobre IV de precios reales; OI real.
// ════════════════════════════════════════════════════════════════════
'use strict';
let nodeFetch;
try { nodeFetch = require('node-fetch'); }            // producción (Render lo tiene)
catch { nodeFetch = (typeof fetch !== 'undefined') ? fetch : null; }
const M = require('./options_metrics');

const ALPACA_KEY_ID  = process.env.ALPACA_KEY_ID  || '';
const ALPACA_SECRET  = process.env.ALPACA_SECRET_KEY || '';
const ALPACA_DATA    = process.env.ALPACA_DATA_BASE  || 'https://data.alpaca.markets';
const ALPACA_TRADE   = process.env.ALPACA_TRADE_BASE || 'https://api.alpaca.markets';
const ALPACA_PAPER   = 'https://paper-api.alpaca.markets';
const ALPACA_HEADERS = {
  'Accept': 'application/json',
  'Accept-Encoding': 'identity',
  'APCA-API-KEY-ID': ALPACA_KEY_ID,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
};

const CACHE = new Map();                 // key → { t, data }
const TTL_MS = 10 * 60 * 1000;           // 10 min

// getOptionsMetrics(sym, opts?, _fetch?)
//   opts: { mode:'monthly'|'nearest', exp?:'YYYY-MM-DD', band?, days?, r?, live?, ttl? }
//   _fetch: inyectable para test (default node-fetch)
async function getOptionsMetrics(sym, opts = {}, _fetch = nodeFetch) {
  sym = String(sym || 'SPY').toUpperCase();
  const mode = opts.exp ? null : (opts.mode === 'nearest' ? 'nearest' : 'monthly');
  const band = Math.min(0.5, Math.max(0.02, Number(opts.band) || 0.12));
  const r    = Number(opts.r) || 0.045;
  const days = Number(opts.days) || (mode === 'nearest' ? 8 : 45);
  const expReq    = opts.exp ? String(opts.exp) : null;
  const tradeBase = opts.live ? ALPACA_TRADE : ALPACA_PAPER;   // keys paper por defecto
  const ttl  = opts.ttl != null ? Number(opts.ttl) : TTL_MS;
  const t0   = Date.now();

  if (!ALPACA_KEY_ID || !ALPACA_SECRET) return { ok: false, error: 'ALPACA keys no configuradas' };

  const cacheKey = `${sym}|${mode || 'exp'}|${expReq || ''}|${band}`;
  if (ttl > 0) {
    const hit = CACHE.get(cacheKey);
    if (hit && (Date.now() - hit.t) < ttl) return { ...hit.data, cached: true };
  }

  const diag = {};
  try {
    // 1) Spot real (SIP)
    let spot = null;
    try {
      const rs = await _fetch(`${ALPACA_DATA}/v2/stocks/${encodeURIComponent(sym)}/trades/latest?feed=sip`, { headers: ALPACA_HEADERS, timeout: 10000 });
      const jb = await rs.json();
      spot = jb && jb.trade && Number(jb.trade.p) > 0 ? Number(jb.trade.p) : null;
      diag.spot_status = rs.status;
    } catch (e) { diag.spot_err = e.message; }
    if (!(spot > 0)) return { ok: false, error: 'no se pudo leer el spot de ' + sym, diag, ms: Date.now() - t0 };

    // 2) Contratos (OI + precio + exp) dentro de ventana + banda de strikes
    const today = new Date().toISOString().slice(0, 10);
    const to    = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
    const lo    = (spot * (1 - band)).toFixed(2), hi = (spot * (1 + band)).toFixed(2);
    let raw = [], pageToken = null, pages = 0;
    do {
      let url = `${tradeBase}/v2/options/contracts?underlying_symbols=${encodeURIComponent(sym)}&status=active`
        + `&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=10000`;
      url += expReq ? `&expiration_date=${expReq}` : `&expiration_date_gte=${today}&expiration_date_lte=${to}`;
      if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
      const rc = await _fetch(url, { headers: ALPACA_HEADERS, timeout: 12000 });
      diag.contracts_status = rc.status;
      const jc = await rc.json();
      if (Array.isArray(jc.option_contracts)) raw = raw.concat(jc.option_contracts);
      pageToken = jc.next_page_token || null;
    } while (pageToken && ++pages < 5);
    if (!raw.length) return { ok: false, error: 'sin contratos (revisá live/banda/ventana)', diag, ms: Date.now() - t0 };

    // 3) Expiración objetivo: la pedida, o auto (monthly = mayor OI · nearest = más próxima)
    const expiration = expReq || M.pickExpiration(raw, mode, today);
    const expSyms = raw.filter(c => c.expiration_date === expiration).map(c => c.symbol);

    // 4) Precio de cada opción (dailyBar.c) vía snapshots por símbolo (lotes de 100)
    const snapshots = {};
    for (let i = 0; i < expSyms.length; i += 100) {
      const csv = expSyms.slice(i, i + 100).join(',');
      try {
        const rsn = await _fetch(`${ALPACA_DATA}/v1beta1/options/snapshots?symbols=${encodeURIComponent(csv)}&feed=indicative&limit=100`, { headers: ALPACA_HEADERS, timeout: 12000 });
        diag.snapshots_status = rsn.status;
        const js = await rsn.json();
        if (js && js.snapshots) Object.assign(snapshots, js.snapshots);
      } catch (e) { diag.snapshots_err = e.message; }
    }

    // 5) Motor: contratos → Max Pain (OI) + GEX (gamma BS)
    const built = M.buildContracts({ rawContracts: raw, snapshots, spot, expiration, r, nowMs: Date.now() });
    const mp  = M.computeMaxPain(built.oiContracts);
    const gex = M.aggregateGEX(built.gammaContracts, spot);

    const strikes = gex.rows.map(x => ({ strike: x.strike, callOI: x.callOI, putOI: x.putOI, netGEX_MM: +(x.netGEX / 1e6).toFixed(2) }));
    const tabla = [...strikes].sort((a, b) => Math.abs(b.netGEX_MM) - Math.abs(a.netGEX_MM)).slice(0, 12).sort((a, b) => a.strike - b.strike);

    const haveGEX = built.coverage.con_iv > 0, haveMP = mp.maxPain != null;
    const data = {
      ok: !!(haveGEX && haveMP), sym, spot, modo: mode || 'exp',
      expiration, dias_a_exp: +(built.T * 365.25).toFixed(1), banda: band, r,
      cobertura: built.coverage,
      maxPain: mp.maxPain,
      gex: haveGEX ? {
        total_MM: +(gex.totalGEX / 1e6).toFixed(2),
        regimen: gex.regime === 'LONG_GAMMA' ? 'LONG GAMMA (pin / baja vol)' : 'SHORT GAMMA (amplifica / alta vol)',
        regimeCode: gex.regime,
        callWall: gex.callWall, putWall: gex.putWall, gammaFlip: gex.gammaFlip,
      } : null,
      strikes, tabla,
      veredicto: (haveGEX && haveMP) ? '✅ GEX (BS real) + Max Pain calculados con dato real'
        : haveMP ? '🟡 Max Pain OK, pero sin IV/gamma (revisá precios de opción)'
        : '❌ sin datos suficientes (revisá live/banda/ventana)',
      ms: Date.now() - t0,
    };
    if (ttl > 0) CACHE.set(cacheKey, { t: Date.now(), data });
    return data;
  } catch (e) {
    return { ok: false, error: e.message, diag, ms: Date.now() - t0 };
  }
}

module.exports = { getOptionsMetrics, _CACHE: CACHE };
