// bench_cvd_score.js — Banco del resolutor real-vs-estimado del score (FASE 3, etapa 3b).
'use strict';
const { resolveScoreCVD, DEFAULTS } = require('./cvd_score.js');

let pass=0, fail=0;
function ok(n,c){ if(c){pass++;console.log('  ✓ '+n);}else{fail++;console.log('  ✗ '+n);} }
function eq(n,a,b){ ok(n+' ('+a+'=='+b+')', a===b); }

const est = { cvd:-1000, buyV:400, sellV:1400 };   // estimado de referencia
const T0 = 1000000000000;
const clean = { sym:'AAPL', cvd:50000, buyV:520000, sellV:470000, cvdReal:true, partial:false, nTrades:22808, ts:T0 };

console.log('\n=== 1. REAL LIMPIO → usa el real ===');
{
  const r = resolveScoreCVD(est, clean, 'AAPL', { now:T0+1000 });
  eq('source real', r.source, 'real');
  eq('cvd = real', r.cvd, 50000);
  eq('buyV = real', r.buyV, 520000);
  eq('sellV = real', r.sellV, 470000);
  eq('cvdReal true', r.cvdReal, true);
  eq('signo del real (compra) domina', r.cvd>0, true);   // el estimado era venta (-1000); el real da compra
}

console.log('\n=== 2. FALLBACK al estimado (cada guarda) ===');
{
  const est2 = est;
  const noData = resolveScoreCVD(est2, null, 'AAPL', {now:T0});
  eq('sin agg → est', noData.source, 'est'); eq('  cvd = est', noData.cvd, -1000); eq('  reason', noData.reason, 'sin dato real');

  const notReal = resolveScoreCVD(est2, Object.assign({}, clean, {cvdReal:false}), 'AAPL', {now:T0});
  eq('agg no real → est', notReal.source, 'est'); eq('  reason', notReal.reason, 'agg no real');

  const partial = resolveScoreCVD(est2, Object.assign({}, clean, {partial:true}), 'AAPL', {now:T0});
  eq('agg parcial → est', partial.source, 'est'); ok('  reason parcial', /parcial/.test(partial.reason));

  const few = resolveScoreCVD(est2, Object.assign({}, clean, {nTrades:5}), 'AAPL', {now:T0});
  eq('pocos trades → est', few.source, 'est'); ok('  reason pocos', /pocos trades/.test(few.reason));

  const stale = resolveScoreCVD(est2, clean, 'AAPL', {now:T0 + 6*60000});   // 6 min > 5 min
  eq('cache viejo → est', stale.source, 'est'); eq('  reason', stale.reason, 'cache viejo');

  const otherSym = resolveScoreCVD(est2, clean, 'MSFT', {now:T0});
  eq('cache de otro símbolo → est', otherSym.source, 'est'); ok('  reason otro símbolo', /otro símbolo/.test(otherSym.reason));
}

console.log('\n=== 3. BORDES ===');
{
  // exactamente minTrades y borde de edad = LIMPIO (usa real)
  const atMin = resolveScoreCVD(est, Object.assign({}, clean, {nTrades:DEFAULTS.minTrades}), 'AAPL', {now:T0});
  eq('nTrades == minTrades → real', atMin.source, 'real');
  const atAge = resolveScoreCVD(est, clean, 'AAPL', {now:T0 + DEFAULTS.maxAgeMs});
  eq('edad == maxAgeMs (borde) → real', atAge.source, 'real');
  // sin curSym provisto: no descarta por símbolo
  const noCur = resolveScoreCVD(est, clean, null, {now:T0});
  eq('sin curSym → no descarta por símbolo', noCur.source, 'real');
  // real con neto negativo se respeta
  const neg = resolveScoreCVD(est, Object.assign({}, clean, {cvd:-99999}), 'AAPL', {now:T0});
  eq('real negativo se respeta', neg.cvd, -99999); eq('  source real', neg.source, 'real');
  // est faltante → ceros seguros
  const noEst = resolveScoreCVD(null, null, 'AAPL', {now:T0});
  eq('est nulo → cvd 0', noEst.cvd, 0); eq('  source est', noEst.source, 'est');
}

console.log('\n=== 4. NO MUTA las entradas ===');
{
  const estCopy = { cvd:-1000, buyV:400, sellV:1400 };
  const aggCopy = Object.assign({}, clean);
  resolveScoreCVD(estCopy, aggCopy, 'AAPL', {now:T0});
  eq('est intacto', estCopy.cvd, -1000);
  eq('agg intacto', aggCopy.cvd, 50000);
}

console.log('\n──────────────────────────────');
console.log(`RESULTADO: ${pass}/${pass+fail} verde` + (fail? `  (${fail} en rojo)`:' — TODO VERDE'));
process.exit(fail ? 1 : 0);
