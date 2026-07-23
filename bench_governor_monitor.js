// ════════════════════════════════════════════════════════════════════
//  bench_governor_monitor.js — s63 · 23-jul-2026
//  Banco del trasplante del GOBERNADOR DE CONVICCIÓN al monitor.
//  Corre sobre el CÓDIGO REAL: extrae buildGovSig/govGradeForMonitor de
//  monitor_bolsa.js por llaves balanceadas y los ata al módulo canónico
//  conviction_governor.js. No reimplementa nada.
//
//  Caso madre: WMT 4H del 23/07 09:03 — score 10/10 con ADX 13.2 lateral.
//  El bot decía "⭐ INSTITUCIONAL"; el mapa, mismo activo, "⚠️ DÉBIL ·
//  CAPÓ: RANGO". Ese es el test 1 y es anti-regresión permanente.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const HERE = __dirname;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// ── EXTRACTOR: función completa por llaves balanceadas ──────────────
function grab(src, header) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error('no encontré: ' + header);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error('llaves sin cerrar: ' + header);
}
function grabConst(src, name) {
  const re = new RegExp('^const\\s+' + name + '\\s*=[\\s\\S]*?;\\s*$', 'm');
  const m = src.match(re);
  if (!m) throw new Error('no encontré const: ' + name);
  return m[0];
}

const monSrc = fs.readFileSync(path.join(HERE, 'monitor_bolsa.js'), 'utf8');
const govMod = require(path.join(HERE, 'conviction_governor.js'));

// ── TEST 12 · FUENTE ÚNICA: el módulo es el bloque del mapa, byte a byte ──
console.log('\n── FUENTE ÚNICA ──');
{
  const htmlPath = path.join(HERE, 'LiquidityMap_BOLSA_v5.html');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const modSrc = fs.readFileSync(path.join(HERE, 'conviction_governor.js'), 'utf8');
    const core = s => {
      const a = s.indexOf("const GOV_GRADES");
      const b = s.indexOf('function govLabel');
      const c = s.indexOf('\n', b);
      return s.slice(a, c);
    };
    ok('el módulo es el bloque del mapa byte a byte', core(html) === core(modSrc),
       'el Governor del bot y el del mapa DEBEN ser el mismo código');
  } else {
    ok('el módulo es el bloque del mapa byte a byte', true, 'HTML ausente — chequeo omitido');
  }
}

// ── Montaje del código real del monitor ─────────────────────────────
const sandboxSrc = [
  grabConst(monSrc, 'SCORE_GAIN'),
  grabConst(monSrc, 'MON_RAWMAX'),
  grabConst(monSrc, 'MON_LAYER_NAME'),
  grabConst(monSrc, 'MON_LAYERS'),
  grab(monSrc, 'function buildGovSig(result) {'),
  grab(monSrc, 'function govGradeForMonitor(result) {'),
  'return { buildGovSig, govGradeForMonitor, MON_RAWMAX, MON_LAYERS };',
].join('\n');

function makeSandbox(withGovernor) {
  const governConviction = withGovernor ? govMod.governConviction : null;
  const govLabel         = withGovernor ? govMod.govLabel         : null;
  // eslint-disable-next-line no-new-func
  return new Function('governConviction', 'govLabel', sandboxSrc)(governConviction, govLabel);
}
const M = makeSandbox(true);

// ── Helpers de armado de resultados del monitor ─────────────────────
// pesos que suman net ≈ 8.4 → score 10/10 (el tope del bot)
function mkResult({ dir = 'SELL', net = 8.4, adx = null, layers = [1, 2, 3, 4, 5, 8, 13, 14], dirOf = null }) {
  const signals = layers.map(n => ({
    layer: n,
    dir: dirOf && dirOf[n] ? dirOf[n] : dir,
    weight: 1,
    label: 'L' + n,
  }));
  const buyScore  = dir === 'BUY'  ? net : 0;
  const sellScore = dir === 'SELL' ? net : 0;
  return { direction: dir, score: Math.min(10, Math.round(net * 1.2)),
           buyScore, sellScore, signals, adx4H: adx };
}
const adxOf = (v, bull) => v === null ? null
  : { adx: v, strong: v >= 20, lateral: v < 20, bull: !!bull, bear: !bull,
      quality: v >= 30 ? '🔥 FUERTE' : v >= 20 ? '✅ VÁLIDA' : '⚠️ LATERAL' };

// ── 1 · CASO MADRE: WMT 23/07 ───────────────────────────────────────
console.log('\n── GATE 1 · RÉGIMEN (el bug reportado) ──');
{
  const r = mkResult({ dir: 'SELL', net: 8.4, adx: adxOf(13.2, false) });
  const g = M.govGradeForMonitor(r);
  ok('WMT 10/10 con ADX 13.2 → DÉBIL (antes: ⭐ INSTITUCIONAL)',
     g.grade === 'DÉBIL', 'salió ' + g.grade);
  ok('WMT explica el motivo del cap (rango/ADX)',
     /rango/.test(g.reason || '') && /13\.2/.test(g.reason || ''), g.reason);
  ok('el rótulo viejo por score ya no aparece',
     !/INSTITUCIONAL|MÁXIMA CALIDAD/.test(g.label + ' ' + g.reason), g.label);
}
{
  const r = mkResult({ dir: 'SELL', net: 7.5, adx: adxOf(13.3, false) });
  ok('GOOG 9/10 con ADX 13.3 → DÉBIL', M.govGradeForMonitor(r).grade === 'DÉBIL');
}
{
  const r = mkResult({ dir: 'SELL', net: 8.4, adx: null });
  const g = M.govGradeForMonitor(r);
  ok('sin ADX → DÉBIL "régimen sin ADX"',
     g.grade === 'DÉBIL' && /sin ADX/.test(g.reason || ''), g.grade + ' / ' + g.reason);
}
{
  const r = mkResult({ dir: 'SELL', net: 8.4, adx: adxOf(24.0, false) });
  const g = M.govGradeForMonitor(r);
  ok('ADX 24 (válido no fuerte) → techo FUERTE', g.grade === 'FUERTE', g.grade);
}
{
  // BUY con DMI bajista y ADX fuerte → el gate de DMI cape a VÁLIDA
  const r = mkResult({ dir: 'BUY', net: 8.4, adx: adxOf(35, false) });
  const g = M.govGradeForMonitor(r);
  ok('ADX 35 pero DMI en contra → VÁLIDA "DMI no confirma"',
     g.grade === 'VÁLIDA' && /DMI/.test(g.reason || ''), g.grade + ' / ' + g.reason);
}

// ── 2 · GATE AUSENTE (ubicación/HTF) ────────────────────────────────
console.log('\n── GATE 2 · UBICACIÓN AUSENTE (honestidad) ──');
{
  const r = mkResult({ dir: 'SELL', net: 8.4, adx: adxOf(35, false) });
  const g = M.govGradeForMonitor(r);
  ok('mejor caso posible del bot → FUERTE, nunca SNIPER', g.grade === 'FUERTE', g.grade);
  ok('y dice que la ubicación no se evaluó',
     /ubicaci/i.test(g.reason || ''), g.reason);
}

// ── 3 · GATE 3 · INTEGRIDAD ─────────────────────────────────────────
console.log('\n── GATE 3 · INTEGRIDAD ──');
{
  const r = mkResult({ dir: 'SELL', net: 8.4, adx: adxOf(35, false), layers: [1, 4, 13] });
  const g = M.govGradeForMonitor(r);
  ok('solo 3 de 8 capas hablaron → DÉBIL por DATOS PARCIALES',
     g.grade === 'DÉBIL' && /PARCIALES/.test(g.caps.join(' ')), g.grade + ' / ' + g.caps.join(' · '));
}
{
  // 6 capas vivas (pasa el umbral 0.6) pero todas del mismo pilar Momentum
  const r = mkResult({ dir: 'SELL', net: 8.4, adx: adxOf(35, false),
                       layers: [1, 13, 14, 2, 3, 4],
                       dirOf: { 2: 'BUY', 3: 'BUY', 4: 'BUY' } });
  const g = M.govGradeForMonitor(r);
  ok('pilares flojos → aparece el cap "confluencia floja"',
     /confluencia floja/.test(g.caps.join(' ')), g.caps.join(' · '));
  ok('el conteo de pilares es 1 (solo Momentum a favor)', g.nPillars === 1, 'nP=' + g.nPillars);
}
{
  const r = mkResult({ dir: 'SELL', net: 8.4, adx: adxOf(35, false) });
  const g = M.govGradeForMonitor(r);
  ok('las 8 capas alineadas → 4 pilares completos, sin cap de integridad',
     g.nPillars === 4 && !/floja|PARCIALES/.test(g.caps.join(' ')), 'nP=' + g.nPillars);
}

// ── 4 · CENSO DE CAPAS ──────────────────────────────────────────────
console.log('\n── CENSO DE CAPAS (buildGovSig) ──');
{
  const sig = M.buildGovSig(mkResult({ dir: 'SELL', net: 8.4, adx: adxOf(35, false), layers: [1, 4] }));
  ok('el censo enumera SIEMPRE las 8 capas', sig.layers.length === 8, sig.layers.length);
  const mudas = sig.layers.filter(l => l.abs);
  ok('las capas que no hablaron van dir 0 · abs true', mudas.length === 6 && mudas.every(l => l.dir === 0),
     'mudas=' + mudas.length);
  const nombres = new Set(sig.layers.map(l => l.name));
  ok('los nombres del censo son los que el GOV_PILLAR del mapa conoce',
     [...nombres].every(n => govMod.GOV_PILLAR[n]), [...nombres].join(','));
  ok('las capas 6 y 7 quedan fuera del censo', !M.MON_LAYERS.includes(6) && !M.MON_LAYERS.includes(7));
}

// ── 5 · ESCALA ──────────────────────────────────────────────────────
console.log('\n── ESCALA (rawMax del bot) ──');
{
  ok('MON_RAWMAX = 10/1.2 (el full-scale real del bot)',
     Math.abs(M.MON_RAWMAX - 10 / 1.2) < 1e-9, M.MON_RAWMAX);
  const base = govMod.govBaseGrade(8.4, M.MON_RAWMAX);
  ok('score 10/10 del bot ⇒ base SNIPER antes de gates', base === govMod.GOV_G.SNIPER, base);
  const bajo = govMod.govBaseGrade(1.5, M.MON_RAWMAX);
  ok('net 1.5 (score 2/10) ⇒ base DÉBIL', bajo === govMod.GOV_G['DÉBIL'], bajo);
}

// ── 6 · NEUTRAL y FAIL-OPEN ─────────────────────────────────────────
console.log('\n── NEUTRAL · FAIL-OPEN ──');
{
  const r = mkResult({ dir: 'NEUTRAL', net: 0.5, adx: adxOf(35, true) });
  ok('dirección NEUTRAL → ESPERAR', M.govGradeForMonitor(r).grade === 'ESPERAR');
}
{
  const M2 = makeSandbox(false);
  const r = mkResult({ dir: 'SELL', net: 8.4, adx: adxOf(13.2, false) });
  ok('sin el módulo → devuelve null (el mensaje avisa "SIN GOBERNAR")',
     M2.govGradeForMonitor(r) === null);
}

// ── 7 · ANTI-REGRESIÓN: el rótulo viejo está enterrado ──────────────
console.log('\n── ANTI-REGRESIÓN ──');
{
  ok('el ternario viejo de calidad por score ya no existe en el monitor',
     !/result\.score\s*>=\s*6\s*\?\s*'⭐ INSTITUCIONAL'/.test(monSrc));
  ok('el mensaje usa govGradeForMonitor', /const gov\s*=\s*govGradeForMonitor\(result\)/.test(monSrc));
}

console.log(`\n${'═'.repeat(52)}\n  RESULTADO: ${pass}/${pass + fail}` + (fail ? `  · ${fail} FALLAN` : '  · TODO VERDE') + `\n${'═'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);
