// bench_layer_census.js — verifica la INSTRUMENTACIÓN del ledger (autopsia del score + gate de régimen).
// Todo aditivo y backward-compatible: makeRecord persiste `layers` y `gate` cuando vienen, null si no;
// captureSignal los pasa; dedupe/resolve los ignoran (no afectan el desenlace).
const { makeRecord, dedupeSignals } = require('./ledger_core.js');
const { captureSignal } = require('./ledger_capture.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '\u2713' : '\u2717') + ' ' + n); };

const census = [{n:1,d:1,w:3.5},{n:2,d:-1,w:1.5},{n:3,d:1,w:2},{n:4,d:1,w:2.5},
                {n:5,d:0,w:0},{n:8,d:1,w:0.5},{n:13,d:1,w:1},{n:14,d:0,w:0}];
const gateEmit = { pass:true,  dir:'up',   eff:'tendencia',    er:0.62 };
const gateSil  = { pass:false, dir:'down', eff:'no-tendencia', er:0.21 };

// ── CENSO DE CAPAS ──
const r1 = makeRecord({ ts:1, sym:'SPY', tf:'4H', type:'BUY', score:10, grade:'FUERTE',
                        setup:'CHOCH_BUY', horizon:'swing', entry:100, sl:99, tp1:103, layers:census, gate:gateEmit });
ok('makeRecord persiste layers (8 capas)', Array.isArray(r1.layers) && r1.layers.length === 8);
ok('layers conserva {n,d,w} de la capa 1', r1.layers[0].n === 1 && r1.layers[0].d === 1 && r1.layers[0].w === 3.5);
ok('layers conserva capa silenciosa (d 0)', r1.layers[4].n === 5 && r1.layers[4].d === 0);

// ── VEREDICTO DEL GATE ──
ok('makeRecord persiste gate (emitida)', r1.gate && r1.gate.pass === true && r1.gate.dir === 'up' && r1.gate.er === 0.62);
const rSil = makeRecord({ ts:2, sym:'AMZN', tf:'4H', type:'SELL', entry:250, sl:253, tp1:245, gate:gateSil });
ok('gate conserva silenciada (pass false)', rSil.gate && rSil.gate.pass === false && rSil.gate.eff === 'no-tendencia');

// ── backward-compatible ──
const r2 = makeRecord({ ts:3, sym:'QQQ', tf:'4H', type:'SELL', entry:200, sl:202, tp1:194 });
ok('sin layers ni gate → ambos null (registros viejos)', r2.layers === null && r2.gate === null);
ok('layers basura → null', makeRecord({ ts:4, sym:'X', tf:'4H', type:'BUY', entry:1, sl:0.5, layers:'xx' }).layers === null);
ok('gate basura (no-objeto) → null', makeRecord({ ts:5, sym:'X', tf:'4H', type:'BUY', entry:1, sl:0.5, gate:'xx' }).gate === null);

// ── captureSignal pasa ambos ──
let saved = null;
const store = { upsert: rec => { saved = rec; return rec; } };
captureSignal(store, { ts:6, sym:'NVDA', tf:'4H', direction:'BUY', score:9, grade:'DÉBIL',
                       setup:'BOS_BUY', horizon:'swing', entry:220, sl:217, tp1:225, layers:census, gate:gateEmit });
ok('captureSignal pasa layers y gate', saved && Array.isArray(saved.layers) && saved.gate && saved.gate.pass === true);

// ── no rompe dedupe (ni layers ni gate entran en la clave) ──
const a = makeRecord({ ts:7, sym:'SPY', tf:'4H', type:'BUY', setup:'CHOCH_BUY', entry:100, sl:99, tp1:103, status:'ACTIVA', layers:census, gate:gateEmit });
const b = makeRecord({ ts:8, sym:'SPY', tf:'4H', type:'BUY', setup:'CHOCH_BUY', entry:100, sl:99, tp1:103, status:'ACTIVA', layers:null, gate:gateSil });
ok('dedupe ignora layers/gate (gemelas colapsan a 1)', dedupeSignals([a, b]).length === 1);

console.log('\nRESULTADO: ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
