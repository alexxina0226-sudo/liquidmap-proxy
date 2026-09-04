// bench_layer_census.js — verifica la instrumentación del censo por capa (autopsia del score).
// Aditivo y backward-compatible: makeRecord persiste `layers` cuando viene, null si no;
// captureSignal lo pasa; dedupe/resolve lo ignoran (no afectan el desenlace).
const { makeRecord, dedupeSignals } = require('./ledger_core.js');
const { captureSignal } = require('./ledger_capture.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '\u2713' : '\u2717') + ' ' + n); };

const census = [{n:1,d:1,w:3.5},{n:2,d:-1,w:1.5},{n:3,d:1,w:2},{n:4,d:1,w:2.5},
                {n:5,d:0,w:0},{n:8,d:1,w:0.5},{n:13,d:1,w:1},{n:14,d:0,w:0}];

// makeRecord persiste el censo
const r1 = makeRecord({ ts:1, sym:'SPY', tf:'4H', type:'BUY', score:10, grade:'FUERTE',
                        setup:'CHOCH_BUY', horizon:'swing', entry:100, sl:99, tp1:103, layers:census });
ok('makeRecord persiste layers (8 capas)', Array.isArray(r1.layers) && r1.layers.length === 8);
ok('layers conserva {n,d,w} de la capa 1', r1.layers[0].n === 1 && r1.layers[0].d === 1 && r1.layers[0].w === 3.5);
ok('layers conserva capa silenciosa (d 0)', r1.layers[4].n === 5 && r1.layers[4].d === 0);

// backward-compatible: sin layers → null
const r2 = makeRecord({ ts:2, sym:'QQQ', tf:'4H', type:'SELL', entry:200, sl:202, tp1:194 });
ok('sin layers → null (registros viejos)', r2.layers === null);
ok('layers basura (no-array) → null', makeRecord({ ts:3, sym:'X', tf:'4H', type:'BUY', entry:1, sl:0.5, layers:'xx' }).layers === null);

// captureSignal pasa el censo
let saved = null;
const store = { upsert: rec => { saved = rec; return rec; } };
captureSignal(store, { ts:4, sym:'NVDA', tf:'4H', direction:'BUY', score:9, grade:'DÉBIL',
                       setup:'BOS_BUY', horizon:'swing', entry:220, sl:217, tp1:225, layers:census });
ok('captureSignal pasa layers al registro', saved && Array.isArray(saved.layers) && saved.layers.length === 8);

// no rompe dedupe (el censo no entra en la clave; señales gemelas colapsan igual)
const a = makeRecord({ ts:5, sym:'SPY', tf:'4H', type:'BUY', setup:'CHOCH_BUY', entry:100, sl:99, tp1:103, status:'ACTIVA', layers:census });
const b = makeRecord({ ts:6, sym:'SPY', tf:'4H', type:'BUY', setup:'CHOCH_BUY', entry:100, sl:99, tp1:103, status:'ACTIVA', layers:null });
ok('dedupe ignora layers (gemelas colapsan a 1)', dedupeSignals([a, b]).length === 1);

console.log('\nRESULTADO: ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
