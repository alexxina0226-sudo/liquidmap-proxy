// ════════════════════════════════════════════════════════════════════
//  bench_salida.js — s74 · 27-jul-2026
//  Banco del motor de SALIDA theta-aware (projectExit en options_metrics).
//  Traduce movimientos del subyacente a PRIMA de la opcion elegida
//  (delta+gamma−theta). A) matematica pura, con un caso CALCULADO A MANO;
//  B) estructural: options_live lo cablea a la respuesta y el HTML lo
//  muestra en el popup del /contrato.
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const M = require('./options_metrics');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };
const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;

// elegido base: PUT 305, prima 6.63, Δ-0.42, γ0.02, θ-0.5/día, breakeven 15.0
const PUT = { type: 'put', mid: 6.63, delta: -0.42, gamma: 0.02, theta: -0.5, breakevenMov: 15.0 };
const CALL = { type: 'call', mid: 6.63, delta: 0.42, gamma: 0.02, theta: -0.5, breakevenMov: 15.0 };
const SPOT = 309;

console.log('\n── A) matematica pura (projectExit) ──');

// A1: PUT → direccion favorable "baja", objetivos por debajo del spot
{
  const s = M.projectExit(PUT, SPOT, 'swing');
  ok('A1 put: dir="baja"', s.dir === 'baja', s.dir);
  ok('A1 put: todos los objetivos < spot', s.niveles.every(n => n.target < SPOT), JSON.stringify(s.niveles.map(n => n.target)));
  ok('A1 put: prima sube con el movimiento favorable (monotona en k)', s.niveles[0].projPremium < s.niveles[1].projPremium && s.niveles[1].projPremium < s.niveles[2].projPremium, JSON.stringify(s.niveles.map(n => n.projPremium)));
}

// A2: CALL → direccion "sube", objetivos por encima
{
  const s = M.projectExit(CALL, SPOT, 'swing');
  ok('A2 call: dir="sube"', s.dir === 'sube', s.dir);
  ok('A2 call: todos los objetivos > spot', s.niveles.every(n => n.target > SPOT), JSON.stringify(s.niveles.map(n => n.target)));
}

// A3: hold por horizonte (scalp 1 · swing 3 · position 10) y theta drag = |theta|*dias
{
  ok('A3 scalp → hold 1d', M.projectExit(PUT, SPOT, 'scalp').daysHeld === 1);
  ok('A3 swing → hold 3d', M.projectExit(PUT, SPOT, 'swing').daysHeld === 3);
  ok('A3 position → hold 10d', M.projectExit(PUT, SPOT, 'position').daysHeld === 10);
  const s = M.projectExit(PUT, SPOT, 'swing');
  ok('A3 theta drag = |theta|*dias = 0.5*3 = 1.5', near(s.thetaDragAbs, 1.5), String(s.thetaDragAbs));
  ok('A3 theta drag % = 1.5/6.63 = 22.6%', near(s.thetaDragPct, 22.6, 0.11), String(s.thetaDragPct));
}

// A4: CASO CALCULADO A MANO (put, swing, hold 3d, drag 1.5, breakeven 15)
//   k=0.5 move 7.5 target 301.5 → 6.63 + 0.42*7.5 + 0.5*0.02*56.25 − 1.5 = 8.84 (+33%)
//   k=1.0 move 15  target 294   → 6.63 + 6.3 + 2.25 − 1.5 = 13.68 (+106%)
//   k=1.5 move 22.5 target 286.5→ 6.63 + 9.45 + 5.0625 − 1.5 = 19.64 (+196%)
{
  const n = M.projectExit(PUT, SPOT, 'swing').niveles;
  ok('A4 k=0.5: target 301.5', near(n[0].target, 301.5), String(n[0].target));
  ok('A4 k=0.5: prima ~8.84', near(n[0].projPremium, 8.84), String(n[0].projPremium));
  ok('A4 k=0.5: +33%', n[0].pctGain === 33, String(n[0].pctGain));
  ok('A4 k=1.0: target 294', near(n[1].target, 294), String(n[1].target));
  ok('A4 k=1.0: prima ~13.68 (la prima ~duplica en el breakeven)', near(n[1].projPremium, 13.68), String(n[1].projPremium));
  ok('A4 k=1.0: +106%', n[1].pctGain === 106, String(n[1].pctGain));
  ok('A4 k=1.5: target 286.5', near(n[2].target, 286.5), String(n[2].target));
  ok('A4 k=1.5: prima ~19.64', near(n[2].projPremium, 19.64), String(n[2].projPremium));
  ok('A4 k=1.5: +196%', n[2].pctGain === 196, String(n[2].pctGain));
}

// A5: gamma agrega convexidad (con gamma da mas prima que sin gamma, mismo movimiento)
{
  const conG = M.projectExit(PUT, SPOT, 'swing').niveles[2].projPremium;
  const sinG = M.projectExit({ ...PUT, gamma: 0 }, SPOT, 'swing').niveles[2].projPremium;
  ok('A5 gamma>0 sube la prima proyectada (convexidad)', conG > sinG, conG + ' vs ' + sinG);
}

// A6: la prima nunca es negativa (theta gigante → clamp a 0, −100%)
{
  const s = M.projectExit({ type: 'put', mid: 1, delta: -0.4, gamma: 0.01, theta: -100, breakevenMov: 5 }, SPOT, 'swing');
  ok('A6 theta gigante → prima clamp a 0', s.niveles[0].projPremium === 0, String(s.niveles[0].projPremium));
  ok('A6 clamp → −100%', s.niveles[0].pctGain === -100, String(s.niveles[0].pctGain));
}

// A7: guardas → null cuando falta dato
{
  ok('A7 sin elegido → null', M.projectExit(null, SPOT, 'swing') === null);
  ok('A7 spot<=0 → null', M.projectExit(PUT, 0, 'swing') === null);
  ok('A7 mid<=0 → null', M.projectExit({ ...PUT, mid: 0 }, SPOT, 'swing') === null);
  ok('A7 delta NaN → null', M.projectExit({ ...PUT, delta: NaN }, SPOT, 'swing') === null);
}

// A8: grilla anclada al breakeven (0.5/1/1.5); sin breakeven usa 1% del spot
{
  const s = M.projectExit(PUT, SPOT, 'swing');
  ok('A8 grilla k = 0.5/1/1.5', s.niveles.map(n => n.k).join(',') === '0.5,1,1.5', s.niveles.map(n => n.k).join(','));
  const s2 = M.projectExit({ ...PUT, breakevenMov: null }, SPOT, 'swing');
  ok('A8 sin breakeven → paso = 1% del spot (3.09)', near(s2.niveles[1].move, SPOT * 0.01, 0.02), String(s2.niveles[1].move));
}

// A9: etiqueta de honestidad presente (es guia, no promesa)
{
  const s = M.projectExit(PUT, SPOT, 'swing');
  ok('A9 metodo declara la estimacion (ignora IV, guia no promesa)', /estimacion/.test(s.metodo) && /IV/.test(s.metodo), s.metodo);
}

// ── B) estructural (cableado + display) ──
console.log('\n── B) cableado y display ──');
const live = fs.readFileSync('./options_live.js', 'utf8');
const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');
ok('B1 getContractPick calcula salida solo si ok', /const salida = sel\.ok \? M\.projectExit\(sel\.elegido, spot, horizon\) : null/.test(live));
ok('B2 salida va en el objeto de respuesta', /fuente_gamma, salida,/.test(live));
ok('B3 projectExit exportada por options_metrics', typeof M.projectExit === 'function');
ok('B4 el popup del /contrato muestra el bloque SALIDA', /SALIDA \(theta-aware/.test(html) && /j\.salida/.test(html));
ok('B5 el popup lee target/projPremium/pctGain de cada nivel', /n\.target/.test(html) && /n\.projPremium/.test(html) && /n\.pctGain/.test(html));
ok('B6 el popup muestra el theta drag del hold', /thetaDragAbs/.test(html) && /thetaDragPct/.test(html));

console.log(`\n${fail === 0 ? '✅' : '❌'} bench_salida: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
