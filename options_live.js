// ════════════════════════════════════════════════════════════════════
//  options_live.js — capa REUSABLE: trae el dato real de Alpaca y calcula
//  GEX (griegas OPRA nativas) + Max Pain con options_metrics.js.
// ────────────────────────────────────────────────────────────────────
//  La usan el SERVER (ruta /alpaca-options-metrics) y el BOT (monitor),
//  así los dos muestran lo MISMO (nunca divergen).
//
//  · auto-selección de expiración: 'monthly' (mayor OI = la mensual líquida)
//    ó 'nearest' (la más próxima, 0DTE en SPY).
//  · caché en memoria (TTL 10 min): el GEX es de resolución diaria, no hace
//    falta recalcular a cada tick → ahorra llamadas a Alpaca.
//  · NADA sintético: gamma e IV NATIVAS de OPRA (Algo Trader Plus); el camino
//    Black-Scholes queda solo como fallback medido. OI real.
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

    // 4) Snapshot OPRA de cada opción (greeks + IV nativas · latestTrade/Quote) por lotes de 100
    //    feed=opra: consolidado real de todas las bolsas (Algo Trader Plus). Antes iba
    //    feed=indicative (degradado) y solo se tomaba el precio → griegas reconstruidas a mano.
    const snapshots = {};
    for (let i = 0; i < expSyms.length; i += 100) {
      const csv = expSyms.slice(i, i + 100).join(',');
      try {
        const rsn = await _fetch(`${ALPACA_DATA}/v1beta1/options/snapshots?symbols=${encodeURIComponent(csv)}&feed=opra&limit=100`, { headers: ALPACA_HEADERS, timeout: 12000 });
        diag.snapshots_status = rsn.status;
        const js = await rsn.json();
        if (js && js.snapshots) Object.assign(snapshots, js.snapshots);
      } catch (e) { diag.snapshots_err = e.message; }
    }

    // 5) Motor: contratos → Max Pain (OI) + GEX (gamma NATIVA OPRA · BS fallback)
    const built = M.buildContracts({ rawContracts: raw, snapshots, spot, expiration, r, nowMs: Date.now() });
    const mp  = M.computeMaxPain(built.oiContracts);
    const gex = M.aggregateGEX(built.gammaContracts, spot);

    const strikes = gex.rows.map(x => ({ strike: x.strike, callOI: x.callOI, putOI: x.putOI, netGEX_MM: +(x.netGEX / 1e6).toFixed(2) }));
    const tabla = [...strikes].sort((a, b) => Math.abs(b.netGEX_MM) - Math.abs(a.netGEX_MM)).slice(0, 12).sort((a, b) => a.strike - b.strike);

    const haveGEX = built.coverage.con_iv > 0, haveMP = mp.maxPain != null;
    const nat = built.coverage.con_native || 0, bs = built.coverage.con_bs || 0;
    const fuente_gamma = nat > 0 && bs === 0 ? 'OPRA nativa'
      : nat > 0 && bs > 0 ? `mixta (${nat} OPRA · ${bs} BS)`
      : bs > 0 ? 'BS fallback' : '—';
    const data = {
      ok: !!(haveGEX && haveMP), sym, spot, modo: mode || 'exp',
      expiration, dias_a_exp: +(built.T * 365.25).toFixed(1), banda: band, r,
      cobertura: built.coverage, fuente_gamma,
      maxPain: mp.maxPain,
      gex: haveGEX ? {
        total_MM: +(gex.totalGEX / 1e6).toFixed(2),
        regimen: gex.regime === 'LONG_GAMMA' ? 'LONG GAMMA (pin / baja vol)' : 'SHORT GAMMA (amplifica / alta vol)',
        regimeCode: gex.regime,
        callWall: gex.callWall, putWall: gex.putWall, gammaFlip: gex.gammaFlip,
      } : null,
      strikes, tabla,
      veredicto: (haveGEX && haveMP) ? `✅ GEX (gamma ${fuente_gamma}) + Max Pain con dato real`
        : haveMP ? '🟡 Max Pain OK, pero sin IV/gamma (revisá feed opra / banda / ventana)'
        : '❌ sin datos suficientes (revisá live/banda/ventana)',
      ms: Date.now() - t0,
    };
    if (ttl > 0) CACHE.set(cacheKey, { t: Date.now(), data });
    return data;
  } catch (e) {
    return { ok: false, error: e.message, diag, ms: Date.now() - t0 };
  }
}

// ════════════════════════════════════════════════════════════════════
//  getContractPick(sym, opts?, _fetch?) — FASE 3 en vivo (s70)
// ────────────────────────────────────────────────────────────────────
//  Le da de comer al selector: trae TODAS las expiraciones dentro de la
//  ventana de DTE del horizonte (buildContracts trabaja de a UNA expiración,
//  así que se llama por expiración y se concatenan las cadenas) y corre
//  M.pickContract sobre el conjunto.
//
//  opts: { side:'call'|'put', horizon:'scalp'|'swing'|'position',
//          targetDelta?, dteMin?, dteMax?, maxSpreadPct?, minOI?, band?, r?,
//          live?, ttl?, top?, maxExp? }
//  Caché propia (TTL 3 min por defecto): más corta que la del GEX porque el
//  spread y el delta se mueven intradía; el GEX es de resolución diaria.
// ════════════════════════════════════════════════════════════════════
async function getContractPick(sym, opts = {}, _fetch = nodeFetch) {
  sym = String(sym || 'SPY').toUpperCase();
  const side    = opts.side === 'put' ? 'put' : 'call';
  const horizon = M.SELECTOR_PRESETS[opts.horizon] ? opts.horizon : 'swing';
  const P       = M.SELECTOR_PRESETS[horizon];
  const dteMin  = opts.dteMin != null ? Number(opts.dteMin) : P.dteMin;
  const dteMax  = opts.dteMax != null ? Number(opts.dteMax) : P.dteMax;
  const band    = Math.min(0.5, Math.max(0.02, Number(opts.band) || 0.15));
  const r       = Number(opts.r) || 0.045;
  const maxExp  = Math.max(1, Number(opts.maxExp) || 4);   // techo de expiraciones a snapshotear
  const tradeBase = opts.live ? ALPACA_TRADE : ALPACA_PAPER;
  const ttl     = opts.ttl != null ? Number(opts.ttl) : 3 * 60 * 1000;
  const t0      = Date.now();

  if (!ALPACA_KEY_ID || !ALPACA_SECRET) return { ok: false, error: 'ALPACA keys no configuradas' };

  const cacheKey = `PICK|${sym}|${side}|${horizon}|${dteMin}-${dteMax}|${band}`;
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

    // 2) Contratos dentro de la VENTANA DE DTE del horizonte + banda de strikes
    const desde = new Date(Date.now() + dteMin * 864e5).toISOString().slice(0, 10);
    const hasta = new Date(Date.now() + dteMax * 864e5).toISOString().slice(0, 10);
    const lo = (spot * (1 - band)).toFixed(2), hi = (spot * (1 + band)).toFixed(2);
    let raw = [], pageToken = null, pages = 0;
    do {
      let url = `${tradeBase}/v2/options/contracts?underlying_symbols=${encodeURIComponent(sym)}&status=active`
        + `&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=10000`
        + `&expiration_date_gte=${desde}&expiration_date_lte=${hasta}&type=${side}`;
      if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
      const rc = await _fetch(url, { headers: ALPACA_HEADERS, timeout: 12000 });
      diag.contracts_status = rc.status;
      const jc = await rc.json();
      if (Array.isArray(jc.option_contracts)) raw = raw.concat(jc.option_contracts);
      pageToken = jc.next_page_token || null;
    } while (pageToken && ++pages < 5);
    if (!raw.length) return { ok: false, error: `sin contratos ${side} entre ${dteMin} y ${dteMax} DTE`, diag, spot, ms: Date.now() - t0 };

    // 3) Expiraciones presentes (las más próximas primero, con techo)
    const exps = [...new Set(raw.map(c => c.expiration_date))].sort().slice(0, maxExp);
    diag.expiraciones = exps;

    // 4) Snapshots OPRA de esas expiraciones (lotes de 100)
    const symsAll = raw.filter(c => exps.includes(c.expiration_date)).map(c => c.symbol);
    const snapshots = {};
    for (let i = 0; i < symsAll.length; i += 100) {
      const csv = symsAll.slice(i, i + 100).join(',');
      try {
        const rsn = await _fetch(`${ALPACA_DATA}/v1beta1/options/snapshots?symbols=${encodeURIComponent(csv)}&feed=opra&limit=100`, { headers: ALPACA_HEADERS, timeout: 12000 });
        diag.snapshots_status = rsn.status;
        const js = await rsn.json();
        if (js && js.snapshots) Object.assign(snapshots, js.snapshots);
      } catch (e) { diag.snapshots_err = e.message; }
    }

    // 5) Cadena multi-expiración: buildContracts filtra por UNA expiración → una vuelta por cada una
    const nowMs = Date.now();
    let chain = [];
    for (const exp of exps) {
      const b = M.buildContracts({ rawContracts: raw, snapshots, spot, expiration: exp, r, nowMs });
      chain = chain.concat(b.chain);
    }

    // 6) Selector
    const sel = M.pickContract(chain, {
      side, horizon, spot, nowMs,
      targetDelta: opts.targetDelta, dteMin, dteMax,
      maxSpreadPct: opts.maxSpreadPct, minOI: opts.minOI, top: opts.top,
    });

    const nat = chain.filter(c => c.src === 'opra').length;
    // fuente_gamma HONESTA (s72): se mide sobre los contratos que PASARON los
    // filtros (el elegido + las alternativas), NO sobre la cadena cruda. La
    // cadena incluye ilíquidos sin OI que nunca traen griegas y ensuciaban la
    // etiqueta a "mixta" aunque el pick real fuera 100% OPRA nativa.
    const _cand = [sel.elegido, ...(sel.alternativas || [])].filter(Boolean);
    const _candNat = _cand.filter(c => c.src === 'opra').length;
    const fuente_gamma = _cand.length
      ? (_candNat === _cand.length ? 'OPRA nativa' : (_candNat > 0 ? 'mixta' : 'BS fallback'))
      : (nat > 0 ? 'OPRA nativa' : 'sin griegas');
    const data = {
      ok: sel.ok, sym, spot, side, horizon,
      criterio: sel.criterio,
      elegido: sel.elegido, alternativas: sel.alternativas,
      motivo: sel.motivo, descartes: sel.descartes,
      cobertura: { contratos: chain.length, con_griegas_opra: nat, expiraciones: exps },
      fuente_gamma,
      nota: 'selector de contrato — NO decide si operar, sólo qué contrato para la dirección pedida',
      ms: Date.now() - t0,
    };
    if (ttl > 0) CACHE.set(cacheKey, { t: Date.now(), data });
    return data;
  } catch (e) {
    return { ok: false, error: e.message, diag, ms: Date.now() - t0 };
  }
}

module.exports = { getOptionsMetrics, getContractPick, _CACHE: CACHE };
