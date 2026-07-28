// ════════════════════════════════════════════════════════════════════
//  bench_joya_v2.js — s76 · 28-jul-2026
//  Banco de la JOYA v2 — proyección de la PRIMA en los TP/SL REALES del
//  mapa (en vez de la grilla de breakeven estándar).
//  El mapa corre en el browser y NO puede require() options_metrics.js,
//  así que projPremAt es un ESPEJO de projectExit. Este banco es
//  DIFERENCIAL (mismo patrón que diff_poc_pine_mapa): extrae projPremAt
//  del HTML real, y prueba que da IDÉNTICO a projectExit del server para
//  los mismos insumos → una sola verdad garantizada.
//   A) PARIDAD projPremAt (mapa) == projectExit (server) — call y put.
//   B) UNIT: clamp a 0, convexidad del gamma, dirección del put, guards.
//   C) ESTRUCTURAL: el popup arma el bloque con getTargets + projPremAt.
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');
const M = require('./options_metrics.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

// ── projPremAt REAL extraída del HTML ──
const src = html.match(/function projPremAt\(mid, delta, gamma, thetaDragAbs, spot, target\)\{[\s\S]*?\n\}/)[0];
const projPremAt = new Function('return (' + src.replace('function projPremAt', 'function') + ')')();

// reconstruye los targets EXACTOS que usa projectExit (mismo step y dir) para
// enfrentar projPremAt contra cada nivel del server sin ruido de redondeo.
function exactTargets(elegido, spot) {
  const isPut = elegido.type === 'put';
  const dir = isPut ? -1 : 1;
  const step = (elegido.breakevenMov && elegido.breakevenMov > 0) ? elegido.breakevenMov : spot * 0.01;
  return [0.5, 1.0, 1.5].map(k => spot + dir * (k * step));
}

console.log('── A) paridad projPremAt (mapa) == projectExit (server) ──');
const escenarios = [
  { nom: 'CALL swing ATM',  elegido: { type:'call', mid:5.42, delta:0.39, gamma:0.0196, theta:0.4033, breakevenMov:13.90 }, spot:338.36, horizon:'swing' },
  { nom: 'CALL scalp corto',elegido: { type:'call', mid:2.10, delta:0.52, gamma:0.041,  theta:0.31,   breakevenMov:4.04 },  spot:100.00, horizon:'scalp' },
  { nom: 'PUT swing',       elegido: { type:'put',  mid:6.63, delta:-0.41, gamma:0.028, theta:0.58,   breakevenMov:16.17 }, spot:305.00, horizon:'swing' },
  { nom: 'PUT position',    elegido: { type:'put',  mid:9.00, delta:-0.30, gamma:0.012, theta:0.20,   breakevenMov:30.00 }, spot:300.00, horizon:'position' },
  { nom: 'CALL sin gamma',  elegido: { type:'call', mid:4.00, delta:0.45, gamma:undefined, theta:0.25, breakevenMov:8.89 }, spot:100.00, horizon:'swing' },
];
for (const sc of escenarios) {
  const s = M.projectExit(sc.elegido, sc.spot, sc.horizon);
  const tgs = exactTargets(sc.elegido, sc.spot);
  let allMatch = true, det = '';
  s.niveles.forEach((n, i) => {
    const pr = projPremAt(sc.elegido.mid, sc.elegido.delta, sc.elegido.gamma, s.thetaDragAbs, sc.spot, tgs[i]);
    if (pr.projPremium !== n.projPremium || pr.pctGain !== n.pctGain) {
      allMatch = false;
      det += ` L${i}: mapa(${pr.projPremium},${pr.pctGain}%) vs server(${n.projPremium},${n.pctGain}%)`;
    }
  });
  ok(`A · ${sc.nom}: 3 niveles idénticos server↔mapa`, allMatch, det);
}

console.log('\n── B) unit (comportamiento de projPremAt) ──');
// clamp a 0: put con el subyacente subiendo fuerte (adverso) + theta → prima piso 0
const clamp = projPremAt(2.0, -0.40, 0.02, 0.5, 100, 130); // dS=+30 adverso para un put
ok('B1 clamp a 0: nunca devuelve prima negativa', clamp.projPremium === 0 && clamp.pctGain === -100, JSON.stringify(clamp));
// convexidad: con gamma la prima proyectada supera la lineal (mid+delta*dS−drag)
const conG = projPremAt(5, 0.4, 0.05, 0, 100, 110);   // dS=+10, gamma on
const sinG = projPremAt(5, 0.4, undefined, 0, 100, 110);
const lineal = +(5 + 0.4 * 10).toFixed(2);
ok('B2 gamma agrega convexidad (proj con gamma > lineal)', conG.projPremium > lineal && sinG.projPremium === lineal, `conG=${conG.projPremium} sinG=${sinG.projPremium} lineal=${lineal}`);
// dirección del put: target por DEBAJO del spot → la prima SUBE (ganancia positiva)
const putUp = projPremAt(6, -0.4, 0.02, 0.3, 100, 90);  // dS=-10 favorable
ok('B3 put gana cuando el subyacente baja (target < spot)', putUp.projPremium > 6 && putUp.pctGain > 0, JSON.stringify(putUp));
// theta drag: mismo target, más drag → menos prima
const drag0 = projPremAt(5, 0.4, 0.02, 0,   100, 108);
const drag2 = projPremAt(5, 0.4, 0.02, 1.5, 100, 108);
ok('B4 más theta drag → menos prima proyectada', drag2.projPremium < drag0.projPremium, `${drag2.projPremium} < ${drag0.projPremium}`);
// guards
ok('B5 mid<=0 → null', projPremAt(0, 0.4, 0.02, 0, 100, 110) === null);
ok('B6 spot<=0 → null', projPremAt(5, 0.4, 0.02, 0, 0, 110) === null);
ok('B7 target null → null', projPremAt(5, 0.4, 0.02, 0, 100, null) === null);
ok('B8 delta no finito → null', projPremAt(5, NaN, 0.02, 0, 100, 110) === null);

console.log('\n── C) estructural (el popup arma el bloque v2 sobre el HTML real) ──');
ok('C1 usa getTargets(j.spot, …) para los TP reales del mapa', /getTargets\(j\.spot, sigForTps, tf, sym\)/.test(html), 'getTargets');
ok('C2 lado del contrato → señal (call→BUY / put→SELL)', /sigForTps = side==='call' \? 'BUY' : 'SELL'/.test(html), 'sig');
ok('C3 proyecta con las griegas del elegido + spot + thetaDrag del server',
   /projPremAt\(e\.mid, e\.delta, e\.gamma, s\.thetaDragAbs, j\.spot, target\)/.test(html), 'projPremAt call');
ok('C4 rotula TP1/TP2/TP3 y el SL', /etqs=\['TP1','TP2','TP3'\]/.test(html) && /filaLvl\('SL '/.test(html), 'labels');
ok('C5 fallback a la grilla breakeven cuando no hay TP (ej. NEUTRAL)', /grilla breakeven/.test(html) && /s\.niveles\|\|\[\]/.test(html), 'fallback');
ok('C6 etiqueta honesta "guía, no promesa"', /guía, no promesa/.test(html), 'honesta');
ok('C7 projPremAt existe y se expone (window.projPremAt)', /window\.projPremAt = projPremAt/.test(html), 'expuesta');

console.log(`\n${fail === 0 ? '✅' : '❌'} bench_joya_v2: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
