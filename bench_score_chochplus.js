// bench_score_chochplus.js — juez del bump de score al CHoCH+ (s60)
// Extrae la CAPA 4 (ESTRUCTURA) del HTML REAL modificado y la corre con eventos controlados.
// Reglas certificadas: BOS ±3 · CHoCH solo ±1.5 · CHoCH+ solo ±2.0 · junto a BOS confirma ±0.5 (con o sin +).
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/LiquidityMap_BOLSA_v5.html', 'utf8');

// extraer desde "// CAPA 4" hasta la línea anterior a "// CAPA 5"
const ini = html.indexOf('// CAPA 4');
const fin = html.indexOf('// CAPA 5');
if (ini < 0 || fin < 0 || fin <= ini) { console.error('No pude extraer la CAPA 4'); process.exit(1); }
const capa4 = html.slice(ini, fin);

function runCapa4(struct){
  let score = 0; const conf = []; const layers = [];
  const addL = (name, val, dir, nd) => layers.push({ name, val, dir, nd: !!nd });
  eval(capa4); // código real del HTML, sin copias
  const L = n => layers.find(x => x.name === n) || { val: 0, dir: 0 };
  return { score, conf, choch: L('CHoCH'), bos: L('BOS') };
}

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  \u2713 ' : '  \u2717 ') + name); };
const CH  = (dir, plus) => ({ choch: { dir, plus: !!plus }, bos: null });
const BOS = (dir, ch)   => ({ bos: { dir }, choch: ch || null });

let r;
r = runCapa4(CH('BULL', false));
ok('CHoCH solo alcista → +1.5, chip 1.5, texto sin +', r.score === 1.5 && r.choch.val === 1.5 && r.choch.dir === 1 && r.conf[0].includes('CHoCH ') && !r.conf[0].includes('CHoCH+'));
r = runCapa4(CH('BEAR', false));
ok('CHoCH solo bajista → -1.5 (regresión)', r.score === -1.5 && r.choch.val === 1.5 && r.choch.dir === -1);
r = runCapa4(CH('BULL', true));
ok('CHoCH+ solo alcista → +2.0, chip 2.0, texto CHoCH+', r.score === 2.0 && r.choch.val === 2.0 && r.choch.dir === 1 && r.conf[0].includes('CHoCH+'));
r = runCapa4(CH('BEAR', true));
ok('CHoCH+ solo bajista → -2.0, texto CHoCH+', r.score === -2.0 && r.choch.val === 2.0 && r.choch.dir === -1 && r.conf[0].includes('CHoCH+'));
r = runCapa4(BOS('BULL', { dir: 'BULL', plus: false }));
ok('BOS + CHoCH confirma → 3 + 0.5', r.score === 3.5 && r.bos.val === 3 && r.choch.val === 0.5);
r = runCapa4(BOS('BULL', { dir: 'BULL', plus: true }));
ok('BOS + CHoCH+ confirma → 3 + 0.5 (no duplica, sin bump)', r.score === 3.5 && r.bos.val === 3 && r.choch.val === 0.5);
r = runCapa4(BOS('BEAR', null));
ok('BOS solo bajista → -3, chip CHoCH en 0', r.score === -3 && r.bos.val === 3 && r.bos.dir === -1 && r.choch.val === 0);
r = runCapa4({ choch: null, bos: null });
ok('Sin eventos → 0, ambos chips en 0', r.score === 0 && r.bos.val === 0 && r.choch.val === 0);

// verificación de maxW del chip (tope 2 para la barra)
ok('maxW del chip CHoCH actualizado a 2', /'CHoCH':2[,\s}]/.test(html));

console.log('\nRESULTADO: ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
