// ════════════════════════════════════════════════════════════════════
//  bench_monitor_filtro.js — s80 · 30-jul-2026
//  Banco del FILTRO DE CALIDAD del monitor (el bot solo emite señales de
//  VERDAD buenas). Corre sobre el CÓDIGO REAL: extrae passesQualityFilter /
//  govGradeForMonitor / buildGovSig de monitor_bolsa_v1.js por llaves
//  balanceadas y los ata al módulo canónico conviction_governor.js.
//  No reimplementa nada.
//
//  Reglas del filtro: (1) score >= QUALITY_MIN_SCORE, (2) estructura
//  BOS/CHoCH a favor, (3) Governor inteligente — bloquea DÉBIL SALVO que el
//  único cap sea ADX-lateral (el oro temprano, ej HOOD), pero SÍ bloquea la
//  debilidad real (datos parciales, data vieja, pocos pilares).
//  Anti-regresión permanente: WMT 10/10 · ADX 13.2 lateral · SIN estructura.
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

const monSrc = fs.readFileSync(path.join(HERE, 'monitor_bolsa_v1.js'), 'utf8');
const govMod = require(path.join(HERE, 'conviction_governor.js'));

// ── Montar el filtro REAL en un scope con el Governor canónico inyectado ──
const body = [
  grabConst(monSrc, 'SCORE_GAIN'),
  grabConst(monSrc, 'MON_RAWMAX'),
  grabConst(monSrc, 'MON_LAYER_NAME'),
  grabConst(monSrc, 'MON_LAYERS'),
  grabConst(monSrc, 'QUALITY_FILTER'),
  grabConst(monSrc, 'QUALITY_MIN_SCORE'),
  grabConst(monSrc, 'QUALITY_REQUIRE_STRUCT'),
  grabConst(monSrc, 'QUALITY_GOV_SMART'),
  grab(monSrc, 'function buildGovSig'),
  grab(monSrc, 'function govGradeForMonitor'),
  grab(monSrc, 'function passesQualityFilter'),
  'return { passesQualityFilter, govGradeForMonitor, buildGovSig, ' +
  'K:{QUALITY_FILTER,QUALITY_MIN_SCORE,QUALITY_REQUIRE_STRUCT,QUALITY_GOV_SMART} };'
].join('\n');
const M = (new Function('governConviction', 'govLabel', body))(govMod.governConviction, govMod.govLabel);
const F = M.passesQualityFilter;

// ── Fábrica de results sintéticos (contrato real del motor) ──────────
const WEIGHTS = { 1: 2, 2: 1.5, 3: 1.5, 4: 3, 5: 3, 8: 1.5, 13: 1, 14: 2 };
const ALL_LAYERS = [1, 2, 3, 4, 5, 8, 13, 14];
function mkResult(o) {
  o = o || {};
  const dir = o.dir || 'BUY';
  const live = o.liveLayers != null ? o.liveLayers : 8;
  const signals = ALL_LAYERS.slice(0, live).map(l => ({ layer: l, dir, weight: WEIGHTS[l] }));
  const struct4H = ('struct' in o)
    ? o.struct
    : { type: dir === 'BUY' ? 'BOS_BUY' : 'BOS_SELL', label: 'BOS', plus: false };
  return {
    direction: dir,
    score: o.score != null ? o.score : 9,
    buyScore: dir === 'BUY' ? 9 : 0,
    sellScore: dir === 'SELL' ? 9 : 0,
    signals,
    adx4H: o.adx || null,
    struct4H
  };
}
const ADX_STRONG_BUY  = { adx: 35,   strong: true,  bull: true,  bear: false };
const ADX_STRONG_SELL = { adx: 35,   strong: true,  bull: false, bear: true  };
const ADX_MID_BUY     = { adx: 25,   strong: true,  bull: true,  bear: false }; // válida-no-fuerte
const ADX_LATERAL     = { adx: 13.2, strong: false, bull: false, bear: false, lateral: true };

// ── SANITY: perillas y extracción ───────────────────────────────────
console.log('\n── perillas extraídas del código real ──');
ok('QUALITY_MIN_SCORE = 8', M.K.QUALITY_MIN_SCORE === 8, 'es ' + M.K.QUALITY_MIN_SCORE);
ok('QUALITY_REQUIRE_STRUCT = true', M.K.QUALITY_REQUIRE_STRUCT === true);
ok('QUALITY_GOV_SMART = true', M.K.QUALITY_GOV_SMART === true);
ok('QUALITY_FILTER = true (activo)', M.K.QUALITY_FILTER === true);

// ── GATE 1 · SCORE ──────────────────────────────────────────────────
console.log('\n── piso de score ──');
{
  const r = F(mkResult({ score: 7, adx: ADX_STRONG_BUY }));
  ok('score 7 con estructura y FUERTE → RECHAZA', r.pass === false && /score/.test(r.why), r.why);
}
ok('score 8 con estructura y FUERTE → PASA', F(mkResult({ score: 8, adx: ADX_STRONG_BUY })).pass === true);
ok('score 9 con estructura y FUERTE → PASA', F(mkResult({ score: 9, adx: ADX_STRONG_BUY })).pass === true);

// ── GATE 2 · ESTRUCTURA A FAVOR (el gatillo) ────────────────────────
console.log('\n── estructura a favor ──');
{
  const r = F(mkResult({ score: 9, adx: ADX_STRONG_BUY, struct: null }));
  ok('sin estructura → RECHAZA', r.pass === false && /sin estructura/.test(r.why), r.why);
}
{
  const r = F(mkResult({ score: 9, adx: ADX_STRONG_BUY, struct: { type: 'BOS_SELL', label: 'x' } }));
  ok('estructura OPUESTA a la señal → RECHAZA', r.pass === false && /no confirma/.test(r.why), r.why);
}
ok('CHoCH a favor cuenta como estructura → PASA',
   F(mkResult({ score: 9, adx: ADX_STRONG_BUY, struct: { type: 'CHOCH_BUY', label: 'x', plus: true } })).pass === true);
ok('BOS a favor → PASA',
   F(mkResult({ score: 9, adx: ADX_STRONG_BUY, struct: { type: 'BOS_BUY', label: 'x' } })).pass === true);

// ── GATE 3 · GOVERNOR INTELIGENTE ───────────────────────────────────
console.log('\n── Governor inteligente (el oro vs la debilidad real) ──');
ok('DÉBIL SOLO por ADX-lateral + estructura → PASA (el oro temprano)',
   F(mkResult({ score: 9, adx: ADX_LATERAL, liveLayers: 8 })).pass === true);
{
  const r = F(mkResult({ score: 9, adx: ADX_LATERAL, liveLayers: 3 }));
  ok('DÉBIL por DATOS PARCIALES (aunque haya ADX-lateral) → RECHAZA',
     r.pass === false && /Governor/.test(r.why) && /PARCIALES/.test(r.why), r.why);
}
{
  const r = F(mkResult({ score: 8, adx: ADX_STRONG_BUY, liveLayers: 3 }));
  ok('DÉBIL por DATOS PARCIALES con ADX fuerte → RECHAZA',
     r.pass === false && /Governor/.test(r.why), r.why);
}
ok('ADX 25 (válida-no-fuerte, cap suave) + estructura → PASA (no es DÉBIL)',
   F(mkResult({ score: 9, adx: ADX_MID_BUY })).pass === true);

// ── ANTI-REGRESIÓN · el caso madre WMT (10/10 · ADX 13.2 lateral · SIN estructura) ──
console.log('\n── anti-regresión WMT (el junk que Gonzalo no se fiaba) ──');
{
  const r = F(mkResult({ score: 10, adx: ADX_LATERAL, struct: null }));
  ok('WMT 10/10 ADX 13.2 lateral SIN estructura → RECHAZA (antes emitía)',
     r.pass === false, r.why);
  ok('  ...y el motivo es la falta de estructura (el gatillo faltante)',
     /sin estructura/.test(r.why), r.why);
}

// ── SIMETRÍA SELL ───────────────────────────────────────────────────
console.log('\n── simetría SELL ──');
ok('SELL score 9 + BOS_SELL + FUERTE → PASA',
   F(mkResult({ dir: 'SELL', score: 9, adx: ADX_STRONG_SELL, struct: { type: 'BOS_SELL', label: 'x' } })).pass === true);
{
  const r = F(mkResult({ dir: 'SELL', score: 9, adx: ADX_STRONG_SELL, struct: { type: 'BOS_BUY', label: 'x' } }));
  ok('SELL con estructura ALCISTA (opuesta) → RECHAZA', r.pass === false && /no confirma/.test(r.why), r.why);
}

// ── 'why' informativo (para el log de consola) ──────────────────────
console.log('\n── el motivo del bloqueo es legible ──');
ok('pasa → why "ok"', F(mkResult({ score: 9, adx: ADX_STRONG_BUY })).why === 'ok');

console.log('\n════════════════════════════════════════');
console.log(`  RESULTADO: ${pass} ✓ · ${fail} ✗`);
console.log('════════════════════════════════════════');
process.exit(fail ? 1 : 0);
