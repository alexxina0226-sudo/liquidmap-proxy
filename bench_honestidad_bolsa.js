// bench_honestidad_bolsa.js — banco de HONESTIDAD DE DATOS del motor bolsa (s57)
// Extrae computeNeuralScore REAL del HTML y verifica que cada capa distinga:
// ✓/✗ (dato con dirección) · ◦ (dato presente, lee plano) · ∅ (feed sin dato).
// Mentiras corregidas: CVD 0/sin-vol leía VENTA · Presión sin flujo leía VENTA ·
// VWAP binario sin banda (p===vwap leía VENTA) con fallback silencioso a POC ·
// SuperTrend sin serie leía NEUTRAL en vez de ∅.
'use strict';
const fs = require('fs');
const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');

// extractor por llaves balanceadas (código real, sin copiar a mano)
function extract(name){
  const i = html.indexOf('function ' + name);
  if(i < 0) throw new Error('no encontré ' + name);
  let d = 0, j = html.indexOf('{', i);
  for(let k = j; k < html.length; k++){
    if(html[k] === '{') d++;
    else if(html[k] === '}'){ d--; if(d === 0) return html.slice(i, k + 1); }
  }
  throw new Error('llaves sin cerrar en ' + name);
}
const src = [
  "const ADX_LEN = 14, ADX_MIN = 20, ADX_FUERTE = 30;",
  extract('calcADX'), extract('getVWAP'), extract('sessionBars'),
  extract('buildVP'), extract('getPOC'), extract('getVA'),
  // KillZone APAGADA a propósito: multiplica el score según la hora del reloj real →
  // rompería el determinismo del banco y es irrelevante para la honestidad de feeds.
  "function getKillZone(){ return { active:false }; }",
  extract('computeNeuralScore'), extract('computeSemaforoBolsa')
].join('\n');

// fábrica: inyecta los globales que el motor lee y devuelve computeNeuralScore(p)
const run = (g) => new Function('g', `
  let vp=g.vp, candles=g.candles, stResult=g.stResult, tf=g.tf, cvd=g.cvd,
      struct=g.struct, buyV=g.buyV, sellV=g.sellV, vpBars=g.vpBars||[];
  ${src}
  const sig = computeNeuralScore(g.p);
  return { sig, sem: computeSemaforoBolsa(sig.layers) };
`)(g);

// velas sintéticas: zigzag leve alrededor de base (TR>0, ADX computable)
function mk(n, base, vol){
  const out = [];
  for(let i = 0; i < n; i++){
    const c = base + Math.sin(i * 0.7) * 0.15;
    out.push({ t: 1700000000 + i * 3600, o: c - 0.05, h: c + 0.2, l: c - 0.2, c, v: vol });
  }
  return out;
}
const layer = (r, name) => r.sig.layers.find(l => l.name === name);
const base = () => {
  const candles = mk(40, 100, 50000);
  return { candles, vp: (new Function(src + ';return buildVP;')())(candles, 60),
    stResult: [{ trend: 1 }], tf: '60', cvd: 5e5, buyV: 7e6, sellV: 3e6,
    struct: { bos: { dir: 'BULL' }, choch: null, swings: [] }, p: 0 };
};
// vwap real de las velas base, para posicionar p con precisión quirúrgica vs la banda
const helpers = new Function(src + ';return {getVWAP, sessionBars};')();
const B = base();
const vw = helpers.getVWAP(helpers.sessionBars(B.candles, '60', 60)).vwap;
const trs = []; for(let i = B.candles.length - 14; i < B.candles.length; i++){ const pc = B.candles[i-1].c, b = B.candles[i]; trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc))); }
const band = 0.1 * (trs.reduce((a, v) => a + v, 0) / trs.length);

let pass = 0, fail = 0;
const check = (n, c) => { if(c){ pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ FALLA: ' + n); } };
console.log('BENCH HONESTIDAD BOLSA — feeds ausentes/planos no mienten dirección (código real)');

// 1) REGRESIÓN: todo sano y alcista → las 4 capas votan ✓ como siempre
let g = base(); g.p = vw + band * 4;
let r = run(g);
check('regresión sana: ST✓ CVD✓ VWAP✓ Presión✓ y score>0',
  layer(r,'SuperTrend').dir === 1 && layer(r,'CVD').dir === 1 &&
  layer(r,'VWAP').dir === 1 && layer(r,'Presión').dir === 1 && r.sig.rawScore > 0);

// 2) CVD === 0 con volumen presente → ◦ neutral (ANTES: leía VENTA -1.5)
g = base(); g.p = vw + band * 4; g.cvd = 0;
r = run(g);
check('cvd=0 con volumen → CVD ◦ (antes ✗ venta)', layer(r,'CVD').dir === 0 && !layer(r,'CVD').abs);

// 3) cvd<0 real → ✗ (regresión: la venta legítima se sigue leyendo)
g = base(); g.p = vw + band * 4; g.cvd = -5e5;
r = run(g);
check('cvd<0 real → CVD ✗ (regresión)', layer(r,'CVD').dir === -1);

// 4) Presión sin flujo (buyV=sellV=0), resto sano → ∅ (ANTES: leía VENTA -1)
g = base(); g.p = vw + band * 4; g.buyV = 0; g.sellV = 0;
r = run(g);
const rawSinFlujo = r.sig.rawScore;
check('sin flujo → Presión ∅ (antes ✗ venta)', layer(r,'Presión').abs === true && layer(r,'Presión').dir === 0);
g = base(); g.p = vw + band * 4;
check('el ∅ de Presión no resta: score igual al sano sin su voto', Math.abs(run(g).sig.rawScore - 1 - rawSinFlujo) < 1e-9);

// 5) VWAP: p exactamente en el vwap → ◦ (ANTES: leía VENTA -1.5)
g = base(); g.p = vw;
r = run(g);
check('p===vwap exacto → VWAP ◦ (antes ✗ venta)', layer(r,'VWAP').dir === 0 && !layer(r,'VWAP').abs);

// 6) VWAP: p dentro de la banda ±0.1×ATR → ◦ (antes votaba ±1.5 pleno)
g = base(); g.p = vw + band * 0.4;
r = run(g);
check('p dentro de banda → VWAP ◦', layer(r,'VWAP').dir === 0);

// 7) VWAP: p fuera de la banda hacia arriba/abajo → vota (regresión)
g = base(); g.p = vw + band * 4;
check('p sobre banda → VWAP ✓', layer(run(g),'VWAP').dir === 1);
g = base(); g.p = vw - band * 4;
check('p bajo banda → VWAP ✗', layer(run(g),'VWAP').dir === -1);

// 8) SuperTrend sin serie → ∅ (ANTES: leía ◦ neutral como si hubiera declarado plano)
g = base(); g.p = vw + band * 4; g.stResult = [];
r = run(g);
check('stResult vacío → SuperTrend ∅ (antes ◦)', layer(r,'SuperTrend').abs === true);

// 9) FEED CIEGO TOTAL: velas sin volumen + sin ST + sin flujo → CVD ∅, VWAP ∅ (getVWAP
//    null, SIN fallback a POC), Presión ∅, ST ∅, Value Area ∅ (perfil vacío no vota
//    fantasma — cazado en el diff antes/después) → semáforo BAJA·ciego
g = base(); g.candles = mk(40, 100, 0); g.stResult = []; g.buyV = 0; g.sellV = 0; g.cvd = 0;
g.vp = (new Function(src + ';return buildVP;')())(g.candles, 60); g.p = 100;
r = run(g);
check('ciego total → CVD∅ VWAP∅ Presión∅ ST∅ VA∅',
  layer(r,'CVD').abs && layer(r,'VWAP').abs && layer(r,'Presión').abs &&
  layer(r,'SuperTrend').abs && layer(r,'Value Area').abs);
check('ciego total → semáforo BAJA · ciego (5∅)', r.sem.label === 'BAJA · ciego' && r.sem.abs >= 5);
check('ciego total → ningún voto fantasma: rawScore de esas capas = 0',
  ['CVD','VWAP','Presión','SuperTrend','Value Area'].every(n => layer(r, n).dir === 0));
// 10) VA con volumen real sigue votando (regresión del fix nuevo)
g = base(); g.p = vw + band * 4;
check('VA con perfil real sigue votando (regresión)', layer(run(g),'Value Area').dir !== 0 || layer(run(g),'Value Area').abs === false);

console.log(`\nRESULTADO: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
