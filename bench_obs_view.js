// bench_obs_view.js — juez de obs_view.buildObsView (pestaña 🧠 LECTURAS del mapa).
// Verifica que el payload lea FIEL el poder predictivo de las lecturas:
//  (a) counts (raw/resolved/open/dropped)
//  (b) scorecard global (hitRate + retorno firmado sobre resueltos sanos)
//  (c) por TIPO de lectura (ballena/darkpool/juez)
//  (d) por TIPO × DIRECCIÓN (ballena↑ vs ballena↓ — el caso SNOW)
//  (e) bloques por ticker (SNOW: ballena compradora que falla)
//  (f) bad-print residual (|signedRetPct|>25) excluido de agregado y listas
//  (g) guardas: vacío / null
const { buildObsView } = require('./obs_view.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '\u2713' : '\u2717') + ' ' + n); };
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e == null ? 0.01 : e);

const OBS = [
  // SNOW — ballena COMPRADORA que NO acierta (el precio cae). El caso de Gonzalo.
  { id:'ballena|SNOW|100', kind:'ballena', sym:'SNOW', ts:100, dir:'up',   status:'resolved', dirHit:false, signedRetPct:-0.8, mfePct:0.3, strength:1.4 },
  { id:'ballena|SNOW|200', kind:'ballena', sym:'SNOW', ts:200, dir:'up',   status:'resolved', dirHit:false, signedRetPct:-0.5, mfePct:0.2, strength:1.1 },
  // SNOW — ballena VENDEDORA que sí acierta (el precio baja)
  { id:'ballena|SNOW|300', kind:'ballena', sym:'SNOW', ts:300, dir:'down', status:'resolved', dirHit:true,  signedRetPct:0.6,  mfePct:0.9, strength:1.6 },
  // PYPL — ballena compradora que acierta (el caso que Gonzalo vio andar)
  { id:'ballena|PYPL|400', kind:'ballena', sym:'PYPL', ts:400, dir:'up',   status:'resolved', dirHit:true,  signedRetPct:1.2,  mfePct:1.5, strength:2.0 },
  // PYPL — dark pool up que acierta
  { id:'darkpool|PYPL|410', kind:'darkpool', sym:'PYPL', ts:410, dir:'up', status:'resolved', dirHit:true,  signedRetPct:0.9,  mfePct:1.1, strength:0.94 },
  // SPY — juez neutral que acierta (se quedó quieto)
  { id:'juez|SPY|500', kind:'juez', sym:'SPY', ts:500, dir:'neutral', status:'resolved', dirHit:true, signedRetPct:-0.1, mfePct:0.15 },
  // SNOW — ballena up TODAVÍA open (no cuenta en stats)
  { id:'ballena|SNOW|600', kind:'ballena', sym:'SNOW', ts:600, dir:'up', status:'open' },
  // SNOW — bad-print residual (retorno absurdo) → excluido del agregado y de las listas
  { id:'ballena|SNOW|700', kind:'ballena', sym:'SNOW', ts:700, dir:'up', status:'resolved', dirHit:true, signedRetPct:30, mfePct:31 },
];

const v = buildObsView(OBS);

// (a) COUNTS
ok('counts.raw = 8', v.counts.raw === 8);
ok('counts.resolved = 7 · open = 1', v.counts.resolved === 7 && v.counts.open === 1);
ok('counts.dropped = 1 (el bad-print)', v.counts.dropped === 1);

// (b) SCORECARD GLOBAL (6 resueltos sanos: rec1-6; hits = rec3,4,5,6 = 4)
ok('overall.n = 6 (sanos, sin bad-print)', v.overall.n === 6);
ok('overall.hitRate ≈ 0.667 (4 de 6)', near(v.overall.hitRate, 0.667, 0.01));
ok('overall.avgSignedRetPct presente', v.overall.avgSignedRetPct != null);

// (c) POR TIPO
const byK = {}; v.byKind.forEach(r => byK[r.k] = r);
ok('ballena: n 4, hits 2, hitRate 0.5', byK.ballena && byK.ballena.n === 4 && byK.ballena.hits === 2 && near(byK.ballena.hitRate, 0.5));
ok('darkpool: hitRate 1 (n1)', byK.darkpool && near(byK.darkpool.hitRate, 1) && byK.darkpool.n === 1);
ok('juez: presente (neutral acierta)', byK.juez && byK.juez.hits === 1);
ok('byKind ordenado por n desc (ballena primero)', v.byKind[0].k === 'ballena');

// (d) POR TIPO × DIRECCIÓN — el corte que responde el caso SNOW
const kd = {}; v.byKindDir.forEach(r => kd[r.kind + ' ' + r.dir] = r);
ok('ballena↑: n 3, hitRate ≈ 0.333 (compradora falla seguido)', kd['ballena up'] && kd['ballena up'].n === 3 && near(kd['ballena up'].hitRate, 0.333, 0.01));
ok('ballena↓: hitRate 1 (vendedora acierta)', kd['ballena down'] && near(kd['ballena down'].hitRate, 1));
ok('cada fila expone kind y dir separados', v.byKindDir.every(r => r.kind && r.dir));

// (e) BLOQUES POR TICKER
const bySym = {}; v.tickers.forEach(t => bySym[t.sym] = t);
ok('SNOW: n 3 resueltos, open 1', bySym.SNOW.n === 3 && bySym.SNOW.open === 1);
ok('SNOW: hitRate ≈ 0.333 (1 de 3 — mala lectura acá)', near(bySym.SNOW.hitRate, 0.333, 0.01));
ok('SNOW: ballena dentro del ticker n 3, hits 1', bySym.SNOW.kinds[0].k === 'ballena' && bySym.SNOW.kinds[0].n === 3 && bySym.SNOW.kinds[0].hits === 1);
ok('SNOW: recent 3 obs (sin el bad-print)', bySym.SNOW.recent.length === 3);
ok('SNOW: recent[0] es la más nueva (ts 300, ballena↓, acierto)', bySym.SNOW.recent[0].ts === 300 && bySym.SNOW.recent[0].dir === 'down' && bySym.SNOW.recent[0].dirHit === true);
ok('PYPL: n 2, hitRate 1 (acá la ballena SÍ paga)', bySym.PYPL.n === 2 && near(bySym.PYPL.hitRate, 1));
ok('orden por movimiento: SNOW primero (n+open mayor)', v.tickers[0].sym === 'SNOW');

// (f) BAD-PRINT EXCLUIDO
ok('SNOW no infla a n4 por el bad-print (queda en 3)', bySym.SNOW.n === 3);
ok('ninguna obs reciente tiene |signedRet| > 25', v.tickers.every(t => t.recent.every(r => r.signedRetPct == null || Math.abs(r.signedRetPct) <= 25)));

// (g) GUARDAS
const e1 = buildObsView([]);
ok('vacío → ok, counts 0, tickers []', e1.ok && e1.counts.raw === 0 && e1.overall.n === 0 && e1.tickers.length === 0);
const e2 = buildObsView(null);
ok('null → no tira', e2.ok && e2.counts.raw === 0);
const e3 = buildObsView([{ junk:true }, null, 7, { kind:'ballena', sym:'X', ts:1, dir:'up', status:'resolved', dirHit:true, signedRetPct:0.5, mfePct:0.6 }]);
ok('mezcla con basura → filtra, 1 ticker', e3.ok && e3.tickers.length === 1 && e3.tickers[0].sym === 'X');

console.log('\nRESULTADO: ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
