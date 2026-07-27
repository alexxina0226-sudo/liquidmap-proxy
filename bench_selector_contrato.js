// ════════════════════════════════════════════════════════════════════
//  bench_selector_contrato.js — s69 · 26-jul-2026
//  Banco de la FASE 3: selector de contrato (pickContract). Corre sobre el
//  módulo REAL options_metrics.js. Prueba: presets por horizonte, filtros
//  duros de liquidez con conteo de descartes, puntaje delta-manda/spread-
//  desempata, métricas derivadas (theta%/día, breakeven), calls vs puts,
//  parametrización, y que la cadena salga de buildContracts con bid/ask.
// ════════════════════════════════════════════════════════════════════
const M = require('./options_metrics');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

const NOW = Date.parse('2026-07-26T14:00:00Z');
const SPOT = 100;
// expiraciones a distintos DTE desde NOW
const EXP_3D  = '2026-07-29';
const EXP_14D = '2026-08-09';
const EXP_40D = '2026-09-04';

// helper: contrato de cadena (formato buildContracts().chain)
const ct = (o) => Object.assign({
  symbol: 'X', strike: 100, type: 'call', oi: 5000, price: 2.0, bid: 1.95, ask: 2.05,
  iv: 0.25, delta: 0.5, gamma: 0.03, theta: -0.05, vega: 0.1, src: 'opra', expiration: EXP_14D,
}, o);

console.log('\n── CONTRATO / exports ──');
{
  ok('pickContract exportado', typeof M.pickContract === 'function');
  ok('SELECTOR_PRESETS exportado con los 3 horizontes', !!M.SELECTOR_PRESETS && ['scalp','swing','position'].every(k => M.SELECTOR_PRESETS[k]));
  ok('preset scalp: delta más alto que position', M.SELECTOR_PRESETS.scalp.targetDelta > M.SELECTOR_PRESETS.position.targetDelta);
  ok('preset scalp: DTE más corto que position', M.SELECTOR_PRESETS.scalp.dteMax < M.SELECTOR_PRESETS.position.dteMin);
  ok('swing queda en el medio (regla: más tiempo del que sostenés)', M.SELECTOR_PRESETS.swing.dteMin >= 7);
  const r = M.pickContract([], { side: 'call', spot: SPOT, nowMs: NOW });
  ok('cadena vacía → ok:false con motivo, sin romper', r.ok === false && !!r.motivo);
  ok('horizonte por defecto = swing', r.criterio.horizon === 'swing');
  ok('horizonte inválido cae a swing', M.pickContract([], { horizon: 'jaja' }).criterio.horizon === 'swing');
}

console.log('\n── ELECCIÓN POR DELTA (el delta manda) ──');
{
  // misma expiración y liquidez; sólo cambia el delta
  const chain = [
    ct({ symbol: 'D20', strike: 108, delta: 0.20 }),
    ct({ symbol: 'D40', strike: 103, delta: 0.40 }),
    ct({ symbol: 'D65', strike: 96,  delta: 0.65 }),
  ];
  const swing = M.pickContract(chain, { side: 'call', horizon: 'swing', spot: SPOT, nowMs: NOW });
  ok('swing (Δ objetivo 0.40) elige el de Δ0.40', swing.ok && swing.elegido.symbol === 'D40', swing.elegido && swing.elegido.symbol);
  const scalp = M.pickContract(chain, { side: 'call', horizon: 'scalp', spot: SPOT, nowMs: NOW, dteMax: 30 });
  ok('scalp (Δ objetivo 0.50) elige el Δ0.40 (|0.40-0.50|=0.10 < |0.65-0.50|=0.15)', scalp.ok && scalp.elegido.symbol === 'D40', scalp.elegido && scalp.elegido.symbol);
  // y con un Δ0.55 en la mesa, el scalp SÍ se corre al más pegado a 0.50
  const chain2 = chain.concat([ct({ symbol: 'D55', strike: 99, delta: 0.55 })]);
  const scalp2 = M.pickContract(chain2, { side: 'call', horizon: 'scalp', spot: SPOT, nowMs: NOW, dteMax: 30 });
  ok('scalp prefiere Δ0.55 sobre Δ0.40 cuando existe (más cerca de 0.50)', scalp2.elegido.symbol === 'D55', scalp2.elegido.symbol);
  const pos = M.pickContract(chain, { side: 'call', horizon: 'position', spot: SPOT, nowMs: NOW, dteMin: 1, dteMax: 60 });
  ok('position (Δ objetivo 0.30) elige el Δ0.20', pos.ok && pos.elegido.symbol === 'D20', pos.elegido && pos.elegido.symbol);
  ok('devuelve alternativas ordenadas por puntaje', swing.alternativas.length === 2 && swing.alternativas[0].puntaje <= swing.alternativas[1].puntaje);
}

console.log('\n── EL SPREAD DESEMPATA (a igual delta) ──');
{
  const chain = [
    ct({ symbol: 'ANCHO',   strike: 103, delta: 0.40, bid: 1.80, ask: 2.20 }),  // ~20% spread → se cae
    ct({ symbol: 'MEDIO',   strike: 103, delta: 0.40, bid: 1.94, ask: 2.06 }),  // ~6%
    ct({ symbol: 'ANGOSTO', strike: 103, delta: 0.40, bid: 1.99, ask: 2.01 }),  // ~1%
  ];
  const r = M.pickContract(chain, { side: 'call', horizon: 'swing', spot: SPOT, nowMs: NOW });
  ok('a igual delta gana el spread más angosto', r.elegido.symbol === 'ANGOSTO', r.elegido.symbol);
  ok('el spread ancho se descarta por filtro duro', r.descartes.spread === 1);
  ok('spreadPct se reporta calculado', r.elegido.spreadPct === 1);
}

console.log('\n── FILTROS DUROS (nada se cae en silencio) ──');
{
  const chain = [
    ct({ symbol: 'PUT',       type: 'put' }),                        // tipo
    ct({ symbol: 'SINGRIEGA', delta: null }),                        // sin delta
    ct({ symbol: 'SINQUOTE',  bid: 0, ask: 0 }),                     // sin quote vivo
    ct({ symbol: 'DTECORTO',  expiration: EXP_3D }),                 // fuera de DTE swing
    ct({ symbol: 'DTELARGO',  expiration: EXP_40D }),                // fuera de DTE swing
    ct({ symbol: 'ILIQUIDO',  oi: 5 }),                              // OI bajo
    ct({ symbol: 'ANCHO',     bid: 1.0, ask: 3.0 }),                 // spread
    ct({ symbol: 'BUENO',     delta: 0.40, strike: 103 }),           // sobrevive
  ];
  const r = M.pickContract(chain, { side: 'call', horizon: 'swing', spot: SPOT, nowMs: NOW });
  ok('sobrevive sólo el bueno', r.ok && r.elegido.symbol === 'BUENO', r.elegido && r.elegido.symbol);
  ok('descarta por tipo', r.descartes.tipo === 1);
  ok('descarta sin griegas (sin delta no hay brújula)', r.descartes.sin_griegas === 1);
  ok('descarta sin quote vivo', r.descartes.sin_quote === 1);
  ok('descarta por DTE (corto y largo)', r.descartes.dte === 2);
  ok('descarta por OI', r.descartes.oi === 1);
  ok('descarta por spread', r.descartes.spread === 1);
  const suma = Object.values(r.descartes).reduce((a, b) => a + b, 0);
  ok('los descartes suman todo lo que no entró (auditable)', suma === chain.length - 1, `suma=${suma}`);
}

console.log('\n── PUTS (lado corto) ──');
{
  const chain = [
    ct({ symbol: 'P40', type: 'put', strike: 97, delta: -0.40 }),
    ct({ symbol: 'P20', type: 'put', strike: 92, delta: -0.20 }),
    ct({ symbol: 'C40', type: 'call', strike: 103, delta: 0.40 }),
  ];
  const r = M.pickContract(chain, { side: 'put', horizon: 'swing', spot: SPOT, nowMs: NOW });
  ok('side=put elige un put', r.ok && r.elegido.type === 'put');
  ok('usa |delta| (el put de Δ-0.40 gana con objetivo 0.40)', r.elegido.symbol === 'P40', r.elegido.symbol);
  ok('el call queda descartado por tipo', r.descartes.tipo === 1);
}

console.log('\n── MÉTRICAS DERIVADAS (theta y breakeven) ──');
{
  const chain = [ct({ symbol: 'A', delta: 0.40, strike: 103, bid: 1.99, ask: 2.01, theta: -0.10 })];
  const r = M.pickContract(chain, { side: 'call', horizon: 'swing', spot: SPOT, nowMs: NOW });
  const e = r.elegido;
  ok('mid calculado', e.mid === 2);
  ok('theta %/día = |theta|/mid*100 (0.10/2 = 5%)', e.thetaPctDia === 5, 'thetaPctDia=' + e.thetaPctDia);
  ok('breakeven ≈ mid/|delta| (2/0.40 = $5 de movimiento)', e.breakevenMov === 5, 'be=' + e.breakevenMov);
  ok('el motivo explica la elección en texto', /Δ0\.40/.test(r.motivo) && /spread/.test(r.motivo), r.motivo);
  ok('conserva la fuente de las griegas (src)', e.src === 'opra');
}

console.log('\n── PARAMETRIZACIÓN (ajustable sin tocar código) ──');
{
  const chain = [
    ct({ symbol: 'D25', strike: 106, delta: 0.25 }),
    ct({ symbol: 'D55', strike: 98,  delta: 0.55 }),
  ];
  const r = M.pickContract(chain, { side: 'call', horizon: 'swing', targetDelta: 0.25, spot: SPOT, nowMs: NOW });
  ok('opts.targetDelta pisa el preset', r.elegido.symbol === 'D25', r.elegido.symbol);
  ok('el criterio devuelto refleja el override', r.criterio.targetDelta === 0.25);
  const r2 = M.pickContract([ct({ symbol: 'ILQ', oi: 10, delta: 0.40, strike: 103 })], { side: 'call', minOI: 1, spot: SPOT, nowMs: NOW });
  ok('opts.minOI pisa el preset (deja pasar OI bajo)', r2.ok && r2.elegido.symbol === 'ILQ');
  const r3 = M.pickContract(chain, { side: 'call', top: 1, spot: SPOT, nowMs: NOW });
  ok('opts.top limita las alternativas', r3.alternativas.length === 0);
}

console.log('\n── INTEGRACIÓN: buildContracts entrega la cadena con bid/ask ──');
{
  const raw = [{ symbol: 'O1', strike_price: '103', type: 'call', open_interest: '5000',
                 close_price: '2', expiration_date: EXP_14D }];
  const snap = { O1: { greeks: { delta: 0.40, gamma: 0.03, theta: -0.05, vega: 0.1, rho: 0.02 },
                       impliedVolatility: 0.25, latestQuote: { bp: 1.98, ap: 2.02 } } };
  const b = M.buildContracts({ rawContracts: raw, snapshots: snap, spot: SPOT, expiration: EXP_14D, r: 0.045, nowMs: NOW });
  ok('buildContracts ahora devuelve chain', Array.isArray(b.chain) && b.chain.length === 1);
  ok('la cadena trae bid y ask del quote', b.chain[0].bid === 1.98 && b.chain[0].ask === 2.02);
  ok('la cadena trae símbolo y expiración (para operar)', b.chain[0].symbol === 'O1' && b.chain[0].expiration === EXP_14D);
  const r = M.pickContract(b.chain, { side: 'call', horizon: 'swing', spot: SPOT, nowMs: NOW });
  ok('pickContract funciona end-to-end sobre la cadena real', r.ok && r.elegido.symbol === 'O1');
  ok('gammaContracts sigue intacto (GEX no se rompió)', b.gammaContracts.length === 1 && b.gammaContracts[0].gamma === 0.03);
}

console.log('\n── ANTI-REGRESIÓN ──');
{
  const chain = [ct({ symbol: 'A', delta: 0.40, strike: 103 })];
  const r1 = M.pickContract(chain, { side: 'call', spot: SPOT, nowMs: NOW });
  const r2 = M.pickContract(chain, { side: 'call', spot: SPOT, nowMs: NOW });
  ok('determinista', JSON.stringify(r1) === JSON.stringify(r2));
  ok('no muta la cadena de entrada', chain[0].delta === 0.40 && !('puntaje' in chain[0]));
  ok('null/undefined no rompen', M.pickContract(null).ok === false && M.pickContract(undefined).ok === false);
}

console.log('\n' + (fail === 0 ? '✅' : '❌') + '  bench_selector_contrato: ' + pass + '/' + (pass + fail) + '  (fail=' + fail + ')');
process.exit(fail === 0 ? 0 : 1);
