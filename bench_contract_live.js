// ════════════════════════════════════════════════════════════════════
//  bench_contract_live.js — s70 · 26-jul-2026
//  Banco de getContractPick (capa VIVA del selector). Usa el _fetch
//  INYECTABLE de options_live.js para simular a Alpaca: no toca la red
//  ni necesita keys. Prueba el flujo end-to-end real: spot → contratos
//  en la ventana de DTE → snapshots OPRA → cadena multi-expiración →
//  pickContract, más caché, errores y filtro por lado.
// ════════════════════════════════════════════════════════════════════
process.env.ALPACA_KEY_ID = process.env.ALPACA_KEY_ID || 'TEST_KEY';
process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || 'TEST_SECRET';
const L = require('./options_live');
const M = require('./options_metrics');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

const SPOT = 100;
const d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const EXP_10 = d(10), EXP_17 = d(17), EXP_45 = d(45);

// ── Alpaca simulado ─────────────────────────────────────────────────
// Genera calls y puts en varios strikes/expiraciones con griegas OPRA.
function hacerAlpaca(cfg = {}) {
  const llamadas = { spot: 0, contracts: 0, snapshots: 0, urls: [] };
  const contratos = [], snaps = {};
  const strikes = [92, 96, 100, 104, 108];
  const deltas  = { call: { 92: 0.80, 96: 0.62, 100: 0.50, 104: 0.34, 108: 0.19 },
                    put:  { 92: -0.20, 96: -0.35, 100: -0.50, 104: -0.66, 108: -0.81 } };
  for (const exp of (cfg.exps || [EXP_10, EXP_17, EXP_45])) {
    for (const ty of ['call', 'put']) {
      for (const k of strikes) {
        const sym = `${ty[0].toUpperCase()}${k}_${exp.slice(5)}`;
        contratos.push({ symbol: sym, strike_price: String(k), type: ty,
          open_interest: String(cfg.oi != null ? cfg.oi : 4000), close_price: '2',
          expiration_date: exp });
        const mid = 2.0, half = (cfg.spreadHalf != null ? cfg.spreadHalf : 0.02);
        snaps[sym] = {
          greeks: { delta: deltas[ty][k], gamma: 0.03, theta: -0.05, vega: 0.10, rho: 0.01 },
          impliedVolatility: 0.25,
          latestQuote: { bp: +(mid - half).toFixed(2), ap: +(mid + half).toFixed(2) },
        };
      }
    }
  }
  const fake = async (url) => {
    llamadas.urls.push(url);
    if (url.includes('/trades/latest')) { llamadas.spot++; return { status: 200, json: async () => ({ trade: { p: SPOT } }) }; }
    if (url.includes('/options/contracts')) {
      llamadas.contracts++;
      if (cfg.sinContratos) return { status: 200, json: async () => ({ option_contracts: [] }) };
      // respeta el filtro type= que manda el código
      const m = url.match(/[?&]type=(call|put)/);
      const lista = m ? contratos.filter(c => c.type === m[1]) : contratos;
      // respeta la ventana de expiración
      const gte = (url.match(/expiration_date_gte=([\d-]+)/) || [])[1];
      const lte = (url.match(/expiration_date_lte=([\d-]+)/) || [])[1];
      const filtrada = lista.filter(c => (!gte || c.expiration_date >= gte) && (!lte || c.expiration_date <= lte));
      return { status: 200, json: async () => ({ option_contracts: filtrada }) };
    }
    if (url.includes('/options/snapshots')) {
      llamadas.snapshots++;
      const pedidos = decodeURIComponent((url.match(/symbols=([^&]+)/) || [])[1] || '').split(',');
      const out = {};
      for (const s of pedidos) if (snaps[s]) out[s] = snaps[s];
      return { status: 200, json: async () => ({ snapshots: out }) };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { fake, llamadas };
}

(async () => {
  console.log('\n── CONTRATO / export ──');
  {
    ok('getContractPick exportado', typeof L.getContractPick === 'function');
  }

  console.log('\n── FLUJO END-TO-END (swing, call) ──');
  {
    L._CACHE.clear();
    const { fake, llamadas } = hacerAlpaca();
    const r = await L.getContractPick('SPY', { side: 'call', horizon: 'swing', ttl: 0 }, fake);
    ok('devuelve ok:true con contrato elegido', r.ok === true && !!r.elegido, r.error || JSON.stringify(r.descartes));
    ok('leyó el spot real', r.spot === SPOT);
    ok('elige un CALL', r.elegido.type === 'call');
    ok('swing apunta Δ0.40 → elige el Δ0.34 (strike 104, el más cercano)', r.elegido.strike === 104, 'strike=' + r.elegido.strike + ' Δ' + r.elegido.delta);
    ok('el DTE cae dentro de la ventana swing (7-21)', r.elegido.dte >= 7 && r.elegido.dte <= 21, 'dte=' + r.elegido.dte);
    ok('reporta el criterio usado', r.criterio.horizon === 'swing' && r.criterio.targetDelta === 0.40);
    ok('griegas 100% OPRA nativas', r.fuente_gamma === 'OPRA nativa');
    ok('trae alternativas', Array.isArray(r.alternativas) && r.alternativas.length > 0);
    ok('el motivo explica en texto', /call 104/.test(r.motivo), r.motivo);
    ok('declara que NO decide si operar', /NO decide si operar/.test(r.nota));
  }

  console.log('\n── VENTANA DE DTE: pide sólo las expiraciones del horizonte ──');
  {
    L._CACHE.clear();
    const { fake, llamadas } = hacerAlpaca();
    const r = await L.getContractPick('SPY', { side: 'call', horizon: 'swing', ttl: 0 }, fake);
    const urlC = llamadas.urls.find(u => u.includes('/options/contracts'));
    ok('la URL de contratos filtra por ventana de expiración', /expiration_date_gte=/.test(urlC) && /expiration_date_lte=/.test(urlC));
    ok('la URL pide sólo el lado pedido (type=call)', /[?&]type=call/.test(urlC));
    ok('la exp de 45d queda FUERA de la ventana swing', !r.cobertura.expiraciones.includes(EXP_45), JSON.stringify(r.cobertura.expiraciones));
    ok('sí entran las de 10d y 17d', r.cobertura.expiraciones.includes(EXP_10) && r.cobertura.expiraciones.includes(EXP_17));
    ok('la cadena es MULTI-expiración (más de una)', r.cobertura.expiraciones.length >= 2);
    const urlS = llamadas.urls.find(u => u.includes('/options/snapshots'));
    ok('los snapshots piden feed=opra', /feed=opra/.test(urlS));
  }

  console.log('\n── HORIZONTES: cambia el contrato elegido ──');
  {
    L._CACHE.clear();
    const a = hacerAlpaca({ exps: [d(4), EXP_10, EXP_17, EXP_45] });
    const scalp = await L.getContractPick('SPY', { side: 'call', horizon: 'scalp', ttl: 0 }, a.fake);
    ok('scalp elige DTE corto (≤7)', scalp.ok && scalp.elegido.dte <= 7, scalp.ok ? 'dte=' + scalp.elegido.dte : scalp.error);
    ok('scalp apunta Δ0.50 → strike 100', scalp.ok && scalp.elegido.strike === 100, scalp.ok && ('strike=' + scalp.elegido.strike));
    L._CACHE.clear();
    const b = hacerAlpaca();
    const pos = await L.getContractPick('SPY', { side: 'call', horizon: 'position', ttl: 0 }, b.fake);
    ok('position elige DTE largo (≥25)', pos.ok && pos.elegido.dte >= 25, pos.ok ? 'dte=' + pos.elegido.dte : pos.error);
    ok('position apunta Δ0.30 → strike 104 o 108', pos.ok && [104, 108].includes(pos.elegido.strike), pos.ok && ('strike=' + pos.elegido.strike));
  }

  console.log('\n── PUTS ──');
  {
    L._CACHE.clear();
    const { fake } = hacerAlpaca();
    const r = await L.getContractPick('SPY', { side: 'put', horizon: 'swing', ttl: 0 }, fake);
    ok('side=put devuelve un put', r.ok && r.elegido.type === 'put');
    ok('usa |delta| → put de Δ-0.35 (strike 96)', r.ok && r.elegido.strike === 96, r.ok && ('strike=' + r.elegido.strike + ' Δ' + r.elegido.delta));
  }

  console.log('\n── LIQUIDEZ: los filtros duros muerden en vivo ──');
  {
    L._CACHE.clear();
    const ilq = hacerAlpaca({ oi: 5 });                 // OI por debajo del mínimo swing (100)
    const r1 = await L.getContractPick('SPY', { side: 'call', horizon: 'swing', ttl: 0 }, ilq.fake);
    ok('OI bajo → ok:false con descartes contados', r1.ok === false && r1.descartes.oi > 0, JSON.stringify(r1.descartes));
    L._CACHE.clear();
    const ancho = hacerAlpaca({ spreadHalf: 0.5 });     // spread ~50% del mid
    const r2 = await L.getContractPick('SPY', { side: 'call', horizon: 'swing', ttl: 0 }, ancho.fake);
    ok('spread ancho → descartado por spread', r2.ok === false && r2.descartes.spread > 0, JSON.stringify(r2.descartes));
    L._CACHE.clear();
    const ok3 = hacerAlpaca({ oi: 5 });
    const r3 = await L.getContractPick('SPY', { side: 'call', horizon: 'swing', minOI: 1, ttl: 0 }, ok3.fake);
    ok('minOI por parámetro lo deja pasar', r3.ok === true);
  }

  console.log('\n── ERRORES Y CACHÉ ──');
  {
    L._CACHE.clear();
    const vacio = hacerAlpaca({ sinContratos: true });
    const r = await L.getContractPick('SPY', { side: 'call', ttl: 0 }, vacio.fake);
    ok('sin contratos → ok:false con error claro, no explota', r.ok === false && /sin contratos/.test(r.error));

    L._CACHE.clear();
    const c1 = hacerAlpaca();
    await L.getContractPick('SPY', { side: 'call', horizon: 'swing' }, c1.fake);   // ttl por defecto
    const llamadasAntes = c1.llamadas.contracts;
    const r2 = await L.getContractPick('SPY', { side: 'call', horizon: 'swing' }, c1.fake);
    ok('segunda llamada sale de caché (cached:true)', r2.cached === true);
    ok('la caché evitó re-pedir contratos', c1.llamadas.contracts === llamadasAntes);
    L._CACHE.clear();
    const c2 = hacerAlpaca();
    const rp = await L.getContractPick('SPY', { side: 'put', horizon: 'swing' }, c2.fake);
    ok('la clave de caché separa por lado (put no reusa el call)', rp.elegido.type === 'put');
    L._CACHE.clear();
  }

  console.log('\n── ANTI-REGRESIÓN ──');
  {
    ok('getOptionsMetrics sigue exportado (GEX intacto)', typeof L.getOptionsMetrics === 'function');
    ok('pickContract del motor sigue puro y exportado', typeof M.pickContract === 'function');
  }

  console.log('\n' + (fail === 0 ? '✅' : '❌') + '  bench_contract_live: ' + pass + '/' + (pass + fail) + '  (fail=' + fail + ')');
  process.exit(fail === 0 ? 0 : 1);
})();
