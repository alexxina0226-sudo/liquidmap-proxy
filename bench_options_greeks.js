// ════════════════════════════════════════════════════════════════════
//  bench_options_greeks.js — s68 · 26-jul-2026
//  Banco de la Fase 1 de opciones: griegas + IV NATIVAS de Alpaca (OPRA)
//  con Black-Scholes como FALLBACK. Corre sobre el módulo REAL
//  options_metrics.js (require directo) + chequeo estructural del
//  feed=opra en options_live.js. No reimplementa nada.
//
//  Prueba: (1) camino NATIVO usa greeks.gamma + impliedVolatility del
//  snapshot sin reconstruir; (2) FALLBACK BS entra solo si faltan; (3)
//  nativo y BS coinciden en gamma (round-trip); (4) cobertura native/bs;
//  (5) cadena de precio quote→trade→dailyBar→close_price; (6) el snapshot
//  de opciones NO trae dailyBar y aun así funciona; (7) delta/theta/vega
//  capturadas para Fase 3; (8) GEX/Max Pain intactos.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const M = require('./options_metrics');
const liveSrc = fs.readFileSync(path.join(__dirname, 'options_live.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

const EXP = '2026-09-19';
const NOW = Date.parse('2026-07-26T14:00:00Z');
const S = 100, R = 0.045;
const T = M.yearsToExpiry(EXP, NOW);

// helper: contrato crudo estilo Alpaca /v2/options/contracts
const rc = (symbol, strike, type, oi, close) => ({
  symbol, strike_price: String(strike), type, open_interest: String(oi),
  close_price: String(close), expiration_date: EXP,
});

console.log('\n── CONTRATO / estructura del cambio ──');
{
  // el fetch REAL de snapshots debe usar feed=opra (el comentario de arriba puede citar 'indicative' al documentar el cambio)
  ok('options_live.js: el fetch de snapshots usa feed=opra', /options\/snapshots\?symbols=\$\{encodeURIComponent\(csv\)\}&feed=opra&limit=100/.test(liveSrc));
  ok('no queda ningún _fetch con feed=indicative activo', !/_fetch\(`[^`]*feed=indicative/.test(liveSrc));
  ok('buildContracts exportado', typeof M.buildContracts === 'function');
  ok('cobertura declara con_native y con_bs', (() => {
    const b = M.buildContracts({ rawContracts: [], snapshots: {}, spot: S, expiration: EXP, r: R, nowMs: NOW });
    return 'con_native' in b.coverage && 'con_bs' in b.coverage;
  })());
}

console.log('\n── CAMINO NATIVO (griegas OPRA directas) ──');
{
  const snap = { O1: { greeks: { delta: 0.55, gamma: 0.0231, theta: -0.041, vega: 0.128, rho: 0.06 }, impliedVolatility: 0.2734, latestQuote: { bp: 2.0, ap: 2.2 } } };
  const b = M.buildContracts({ rawContracts: [rc('O1', 100, 'call', 500, 2.1)], snapshots: snap, spot: S, expiration: EXP, r: R, nowMs: NOW });
  const g = b.gammaContracts[0];
  ok('usa la gamma NATIVA del snapshot (0.0231), no reconstruye', g && g.gamma === 0.0231, g && ('gamma=' + g.gamma));
  ok('usa la IV NATIVA (0.2734)', g && g.iv === 0.2734);
  ok('marca src=opra', g && g.src === 'opra');
  ok('captura delta/theta/vega para Fase 3', g && g.delta === 0.55 && g.theta === -0.041 && g.vega === 0.128);
  ok('cobertura: con_native=1, con_bs=0', b.coverage.con_native === 1 && b.coverage.con_bs === 0);
}

console.log('\n── FALLBACK BLACK-SCHOLES (snapshot sin griegas) ──');
{
  // precio de opción que corresponde a una IV conocida → la bisección debe recuperarla
  const iv0 = 0.30, K = 100;
  const price = M.bsPrice('call', S, K, T, R, iv0);
  const snap = { O2: { latestQuote: { bp: +(price - 0.02).toFixed(2), ap: +(price + 0.02).toFixed(2) } } }; // sin greeks
  const b = M.buildContracts({ rawContracts: [rc('O2', K, 'call', 500, price)], snapshots: snap, spot: S, expiration: EXP, r: R, nowMs: NOW });
  const g = b.gammaContracts[0];
  ok('entra por BS cuando no hay griegas (src=bs)', g && g.src === 'bs');
  ok('la IV reconstruida ~ IV real (round-trip)', g && Math.abs(g.iv - iv0) < 0.02, g && ('iv=' + g.iv.toFixed(4)));
  ok('la gamma BS ~ gamma real', g && Math.abs(g.gamma - M.bsGamma(S, K, T, R, iv0)) < 1e-4, g && ('gamma=' + g.gamma.toFixed(6)));
  ok('cobertura: con_bs=1, con_native=0', b.coverage.con_bs === 1 && b.coverage.con_native === 0);
}

console.log('\n── NATIVO vs BS coinciden (misma verdad, dos caminos) ──');
{
  const iv0 = 0.28, K = 105;
  const gNat = M.bsGamma(S, K, T, R, iv0);
  const price = M.bsPrice('call', S, K, T, R, iv0);
  // nativo: snapshot con esa gamma/IV
  const bNat = M.buildContracts({ rawContracts: [rc('N', K, 'call', 300, price)], snapshots: { N: { greeks: { delta: 0.4, gamma: gNat, theta: -0.03, vega: 0.1, rho: 0.05 }, impliedVolatility: iv0, latestQuote: { bp: price - 0.02, ap: price + 0.02 } } }, spot: S, expiration: EXP, r: R, nowMs: NOW });
  // BS: mismo precio, sin griegas
  const bBS = M.buildContracts({ rawContracts: [rc('B', K, 'call', 300, price)], snapshots: { B: { latestQuote: { bp: price - 0.02, ap: price + 0.02 } } }, spot: S, expiration: EXP, r: R, nowMs: NOW });
  const dev = Math.abs(bNat.gammaContracts[0].gamma - bBS.gammaContracts[0].gamma);
  ok('gamma nativa ≈ gamma BS (desvío < 1e-4)', dev < 1e-4, 'desvío=' + dev.toExponential(2));
}

console.log('\n── CADENA DE PRECIO (quote → trade → dailyBar → close) ──');
{
  const mk = (snapObj, close) => {
    const b = M.buildContracts({ rawContracts: [rc('P', 100, 'call', 500, close)], snapshots: { P: snapObj }, spot: S, expiration: EXP, r: R, nowMs: NOW });
    return b.gammaContracts[0] ? b.gammaContracts[0].price : null;
  };
  ok('mid del quote gana (bp+ap)/2', mk({ latestQuote: { bp: 2.0, ap: 2.2 } }, 9) === 2.1);
  ok('last trade si no hay quote', mk({ latestTrade: { p: 3.0 } }, 9) === 3.0);
  ok('dailyBar si no hay quote ni trade', mk({ dailyBar: { c: 4.0 } }, 9) === 4.0);
  ok('close_price del contrato si el snapshot no trae nada', mk({}, 5.5) === 5.5);
  // el hallazgo: el snapshot de opciones NO trae dailyBar y aun así funciona
  ok('funciona sin dailyBar en el snapshot (hallazgo OPRA)', mk({ greeks: { gamma: 0.02 }, impliedVolatility: 0.25, latestQuote: { bp: 1.0, ap: 1.2 } }, 9) === 1.1);
}

console.log('\n── INTEGRACIÓN: GEX + Max Pain intactos con contratos nativos ──');
{
  const snaps = {}, raws = [];
  for (let k = 90; k <= 110; k += 5) {
    for (const ty of ['call', 'put']) {
      const sym = ty[0].toUpperCase() + k;
      const iv = 0.25, gm = M.bsGamma(S, k, T, R, iv);
      snaps[sym] = { greeks: { delta: 0.5, gamma: gm, theta: -0.03, vega: 0.1, rho: 0.05 }, impliedVolatility: iv, latestQuote: { bp: 1.0, ap: 1.2 } };
      raws.push(rc(sym, k, ty, 1000, 1.1));
    }
  }
  const b = M.buildContracts({ rawContracts: raws, snapshots: snaps, spot: S, expiration: EXP, r: R, nowMs: NOW });
  const mp = M.computeMaxPain(b.oiContracts);
  const gex = M.aggregateGEX(b.gammaContracts, S);
  ok('todos los contratos entran por NATIVO', b.coverage.con_native === raws.length && b.coverage.con_bs === 0, `nat=${b.coverage.con_native}/${raws.length}`);
  ok('Max Pain calcula (usa solo OI)', mp.maxPain != null);
  ok('GEX agrega con la gamma nativa (totalGEX finito)', Number.isFinite(gex.totalGEX) && gex.rows.length > 0);
  ok('aggregateGEX recibe las claves que necesita (oi/gamma/type/strike)', b.gammaContracts.every(c => c.oi > 0 && c.gamma > 0 && c.type && c.strike > 0));
}

console.log('\n── ANTI-REGRESIÓN ──');
{
  // Max Pain no depende de griegas: sigue saliendo aunque no haya un solo snapshot
  const raws = [rc('C1', 95, 'call', 1000, 3), rc('P1', 105, 'put', 1200, 3)];
  const b = M.buildContracts({ rawContracts: raws, snapshots: {}, spot: S, expiration: EXP, r: R, nowMs: NOW });
  const mp = M.computeMaxPain(b.oiContracts);
  ok('Max Pain robusto sin snapshots (solo OI)', mp.maxPain != null && b.coverage.con_oi === 2);
  // determinismo
  const b2 = M.buildContracts({ rawContracts: raws, snapshots: {}, spot: S, expiration: EXP, r: R, nowMs: NOW });
  ok('determinista', JSON.stringify(b) === JSON.stringify(b2));
}

console.log('\n' + (fail === 0 ? '✅' : '❌') + '  bench_options_greeks: ' + pass + '/' + (pass + fail) + '  (fail=' + fail + ')');
process.exit(fail === 0 ? 0 : 1);
