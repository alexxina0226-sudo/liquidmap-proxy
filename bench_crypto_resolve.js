// bench_crypto_resolve.js — verifica el RESOLVER cripto end-to-end: un registro cripto ACTIVA
// se sella a CUMPLIDA/FALLIDA/EXPIRADA con velas sintéticas, usando los mismos opts (4h) que el
// monitor. Reusa resolvePending (cerebro de bolsa) → prueba la INTEGRACIÓN cripto, no re-testea el cerebro.
const { resolvePending } = require('./ledger_resolver.js');
const { makeRecord }     = require('./ledger_core.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '\u2713' : '\u2717') + ' ' + n); };

const H4 = 14400000;
const opts = { tfToAlpaca: () => '4h', barMs: () => H4 };

// store falso: load() + update(id, patch) — como el real
function fakeStore(recs) {
  const map = new Map(recs.map(r => [r.id, r]));
  return { load: () => [...map.values()],
           update: (id, patch) => { const r = map.get(id); if (r) Object.assign(r, patch); },
           get: id => map.get(id) };
}
// velas 4h {t:ISO,o,h,l,c} POSTERIORES al emit
function bars(emitMs, seq) { return seq.map((b, i) => ({ t: new Date(emitMs + (i + 1) * H4).toISOString(), o:b[0], h:b[1], l:b[2], c:b[3] })); }

const emit = 1788000000000;
// BTCUSDT BUY: entry 80000, sl 78500 (R=1500), tp1 82000. Vela 2 toca 82000 → CUMPLIDA.
const rBuy = makeRecord({ ts:emit, sym:'BTCUSDT', tf:'4H', type:'BUY', score:8, setup:'CHOCH_BUY',
  entry:80000, sl:78500, tp1:82000, tp2:83000, tp3:85000, horizonBars:30 });
// SELL que se stopea: entry 3000, sl 3060 (R=60), vela toca 3060 → FALLIDA.
const rSell = makeRecord({ ts:emit, sym:'ETHUSDT', tf:'4H', type:'SELL', score:7, setup:'BOS_SELL',
  entry:3000, sl:3060, tp1:2900, horizonBars:30 });
// EXPIRADA: precio no toca nada y pasa el horizonte (2 barras, horizonBars:2).
const rExp = makeRecord({ ts:emit, sym:'SOLUSDT', tf:'4H', type:'BUY', score:6, setup:'CHOCH_BUY',
  entry:150, sl:147, tp1:156, horizonBars:2 });

const store = fakeStore([rBuy, rSell, rExp]);
const now = emit + 40 * H4;   // muy después → horizonte cumplido para todos

const fetchBars = async (sym) => {
  if (sym === 'BTCUSDT') return bars(emit, [[80000,80500,79800,80200],[80200,82100,80100,81900]]); // toca 82000 en vela 2
  if (sym === 'ETHUSDT') return bars(emit, [[3000,3070,2990,3050]]);                                  // toca 3060 (SL) en vela 1
  if (sym === 'SOLUSDT') return bars(emit, [[150,151,149,150.5],[150.5,151.2,149.5,150.8]]);          // nunca toca, 2 barras
  return [];
};

(async () => {
  const res = await resolvePending(store, fetchBars, { ...opts, now });
  ok('selló 3 registros', res.resolved === 3);
  ok('BTCUSDT BUY → CUMPLIDA (tocó TP1)', store.get(rBuy.id).status === 'CUMPLIDA' && store.get(rBuy.id).hitTP === 1);
  ok('BTCUSDT rMultiple > 0', store.get(rBuy.id).rMultiple > 0);
  ok('ETHUSDT SELL → FALLIDA (tocó SL)', store.get(rSell.id).status === 'FALLIDA' && store.get(rSell.id).rMultiple === -1);
  ok('SOLUSDT → EXPIRADA (horizonte sin tocar)', store.get(rExp.id).status === 'EXPIRADA');
  ok('sella mfeR/maeR (excursión medida)', store.get(rBuy.id).mfeR != null && store.get(rBuy.id).maeR != null);

  // guarda: registro joven sin horizonte cumplido → NO se sella (queda ACTIVA)
  const young = makeRecord({ ts: now - 2 * H4, sym:'BTCUSDT', tf:'4H', type:'BUY', entry:80000, sl:78500, tp1:82000, horizonBars:30 });
  const s2 = fakeStore([young]);
  const r2 = await resolvePending(s2, async () => bars(young.ts, [[80000,80500,79900,80100]]), { ...opts, now });
  ok('registro joven no se sella prematuro (sigue ACTIVA)', s2.get(young.id).status === 'ACTIVA' && r2.resolved === 0);

  console.log('\nRESULTADO: ' + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
