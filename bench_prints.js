// bench_prints.js — banco de prints.js (puro) + prints_live.js (I/O con fetch mock).
// Correr: node bench_prints.js  →  debe imprimir "PRINTS OK N/N".
'use strict';
const assert = require('assert');
const { filterLargePrints, summarizePrints, dedupTrades, isOffExchange, isAuction } = require('./prints.js');
const { fetchLargePrints, mapTradesFull } = require('./prints_live.js');

let pass = 0, total = 0;
function t(name, fn){ total++; return fn().then(()=>{ pass++; console.log('  ✓', name); })
  .catch(e=>{ console.log('  ✗', name, '\n     ', e.message); }); }
function sync(name, fn){ total++; try{ fn(); pass++; console.log('  ✓', name); }
  catch(e){ console.log('  ✗', name, '\n     ', e.message); } }

const RTH_A = '2026-08-10T14:00:00Z';   // 10:00 ET
const RTH_B = '2026-08-10T19:30:00Z';   // 15:30 ET
const PRE   = '2026-08-10T12:00:00Z';   // 08:00 ET (fuera RTH)

// ── 1) filterLargePrints: umbral, orden, guardas ──
sync('filter: pasa solo notional >= $1M', ()=>{
  const trades = [
    { ts:1, price:773, size:2000 },   // 1.546M ✓
    { ts:2, price:773, size:500  },   // 386.5k ✗
    { ts:3, price:774, size:5000 },   // 3.87M  ✓ (mayor)
    { ts:4, price:772, size:100  },   // 77.2k  ✗
  ];
  const r = filterLargePrints(trades, 1e6);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].notional, 774*5000);
  assert.strictEqual(r[1].notional, 773*2000);
});
sync('filter: umbral configurable', ()=>{
  const trades = [{ts:1,price:773,size:500}, {ts:2,price:773,size:2000}];
  assert.strictEqual(filterLargePrints(trades, 5e5).length, 1);
  assert.strictEqual(filterLargePrints(trades, 3e5).length, 2);
});
sync('filter: default 1e6 con umbral invalido', ()=>{
  const trades = [{ts:1,price:100,size:5000}]; // 500k
  assert.strictEqual(filterLargePrints(trades, null).length, 0);
  assert.strictEqual(filterLargePrints(trades, -5).length, 0);
});
sync('filter: descarta basura (price/size null/<=0)', ()=>{
  const trades = [
    { ts:1, price:null, size:5000 }, { ts:2, price:773, size:0 },
    { ts:3, price:773, size:-10 },   { ts:4, price:0, size:9999 },
    { ts:5, price:773, size:2000 },
  ];
  const r = filterLargePrints(trades, 1e6);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].ts, 5);
});
sync('filter: no-array -> []', ()=>{
  assert.deepStrictEqual(filterLargePrints(null, 1e6), []);
});

// ── 2) DEDUP (el bug del opening cross O/Q) ──
sync('dedup: mismo ts+price+size+exchange, distinto conditions -> 1 (conditions merged)', ()=>{
  const trades = [
    { ts:1786455000487, price:774.61, size:112233, exchange:'P', conditions:[' ','O'] },
    { ts:1786455000487, price:774.61, size:112233, exchange:'P', conditions:[' ','Q'] },
  ];
  const d = dedupTrades(trades);
  assert.strictEqual(d.length, 1, 'colapsa el opening cross duplicado');
  assert.ok(d[0].conditions.includes('O') && d[0].conditions.includes('Q'), 'une conditions O+Q');
});
sync('dedup: NO colapsa trades distintos (mismo px/size, distinto ts)', ()=>{
  const trades = [
    { ts:1, price:774.61, size:112233, exchange:'P', conditions:[' '] },
    { ts:2, price:774.61, size:112233, exchange:'P', conditions:[' '] },
  ];
  assert.strictEqual(dedupTrades(trades).length, 2);
});
sync('dedup: NO colapsa mismo trade en distinto venue', ()=>{
  const trades = [
    { ts:1, price:774.61, size:112233, exchange:'P', conditions:[' '] },
    { ts:1, price:774.61, size:112233, exchange:'D', conditions:[' '] },
  ];
  assert.strictEqual(dedupTrades(trades).length, 2);
});
sync('dedup: identidad incompleta (ts null) -> no arriesga dedup', ()=>{
  const trades = [
    { ts:null, price:774, size:100, exchange:'P', conditions:[' ','O'] },
    { ts:null, price:774, size:100, exchange:'P', conditions:[' ','Q'] },
  ];
  assert.strictEqual(dedupTrades(trades).length, 2);
});
sync('filter: aplica dedup antes de contar (opening cross no infla)', ()=>{
  const trades = [
    { ts:1786455000487, price:774.61, size:112233, exchange:'P', conditions:[' ','O'] },
    { ts:1786455000487, price:774.61, size:112233, exchange:'P', conditions:[' ','Q'] },
  ];
  const r = filterLargePrints(trades, 1e6);
  assert.strictEqual(r.length, 1, 'el duplicado no se cuenta dos veces');
  assert.strictEqual(r[0].notional, 774.61*112233);
});

// ── 3) TAG off-exchange + auction ──
sync('isOffExchange: D=true, P/T/V/Z=false', ()=>{
  assert.strictEqual(isOffExchange('D'), true);
  ['P','T','V','Z',null,undefined].forEach(x=>assert.strictEqual(isOffExchange(x), false, 'x='+x));
});
sync('isAuction: O/Q/M/6 en conditions -> true', ()=>{
  assert.strictEqual(isAuction([' ','O']), true);
  assert.strictEqual(isAuction([' ','Q']), true);
  assert.strictEqual(isAuction([' ']), false);
  assert.strictEqual(isAuction([' ','F']), false);
});
sync('filter: taggea offExchange + auction en cada print', ()=>{
  const trades = [
    { ts:1, price:774.06, size:3216, exchange:'D', conditions:[' '] },      // off-exchange, no subasta
    { ts:2, price:774.61, size:112233, exchange:'P', conditions:[' ','O'] },// subasta, no off-exchange
  ];
  const r = filterLargePrints(trades, 1e6);
  const byEx = Object.fromEntries(r.map(p=>[p.exchange, p]));
  assert.strictEqual(byEx['D'].offExchange, true);
  assert.strictEqual(byEx['D'].auction, false);
  assert.strictEqual(byEx['P'].offExchange, false);
  assert.strictEqual(byEx['P'].auction, true);
});

// ── 4) summary: breakdown off-exchange + auction ──
sync('summary: offExchangeCount/Notional/Pct + auction', ()=>{
  const prints = [
    { notional: 6e6, offExchange:true,  auction:false },
    { notional: 4e6, offExchange:false, auction:false },
    { notional: 2e6, offExchange:false, auction:true  },
  ];
  const s = summarizePrints(prints, 20);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.totalNotional, 12e6);
  assert.strictEqual(s.offExchangeCount, 1);
  assert.strictEqual(s.offExchangeNotional, 6e6);
  assert.strictEqual(s.offExchangePct, 0.5);
  assert.strictEqual(s.auctionCount, 1);
  assert.strictEqual(s.auctionNotional, 2e6);
});
sync('summary: vacio -> ceros', ()=>{
  const s = summarizePrints([], 20);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.offExchangePct, 0);
});

// ── 5) mapTradesFull ──
sync('mapTradesFull: t/p/s/x/c -> ts/price/size/exchange/conditions', ()=>{
  const m = mapTradesFull([{ t:RTH_A, p:773.5, s:1200, x:'D', c:['@'] }]);
  assert.strictEqual(m[0].price, 773.5);
  assert.strictEqual(m[0].exchange, 'D');
  assert.deepStrictEqual(m[0].conditions, ['@']);
});

// ── 6) e2e con fetch mock: replica el opening cross duplicado REAL ──
function mockFetch(pages){
  let i = 0;
  return async (url)=>{
    if(!String(url).includes('/trades'))
      return { ok:true, status:200, text: async()=>JSON.stringify({ quotes:[], next_page_token:null }) };
    const page = pages[i] || { trades:[], next_page_token:null }; i++;
    return { ok:true, status:200, text: async()=>JSON.stringify(page) };
  };
}
t('e2e: opening cross O/Q dedup + tag D en datos tipo-reales', async ()=>{
  // ts dentro de RTH (14:00Z=10:00 ET). Replica el patron real de SPY.
  const T = new Date(RTH_A).getTime();
  const pages = [{ trades:[
    { t:RTH_A, p:774.61, s:112233, x:'P', c:[' ','O'] },  // opening \
    { t:RTH_A, p:774.61, s:112233, x:'P', c:[' ','Q'] },  // opening / MISMO trade -> dedup a 1
    { t:RTH_A, p:774.06, s:3216,   x:'D', c:[' '] },      // off-exchange 2.49M
    { t:RTH_A, p:773.11, s:1949,   x:'D', c:[' '] },      // off-exchange 1.51M
    { t:RTH_A, p:773,    s:500,    x:'P', c:[' '] },      // 386k <1M ✗
  ], next_page_token:null }];
  const r = await fetchLargePrints('SPY', '2026-08-10T13:30:00Z', '2026-08-10T20:00:00Z',
    { _fetch: mockFetch(pages), minNotional:1e6, topN:20 });
  assert.strictEqual(r.count, 3, '4 prints >1M pero el opening dup colapsa -> 3');
  assert.strictEqual(r.offExchangeCount, 2, 'los dos D');
  assert.strictEqual(r.auctionCount, 1, 'el opening (ya deduplicado) marcado auction');
  assert.strictEqual(r.maxNotional, 774.61*112233, 'opening cross es el mayor (una sola vez)');
  const opening = r.top.find(p=>p.auction);
  assert.ok(opening.conditions.includes('O') && opening.conditions.includes('Q'), 'conditions merged');
});
t('e2e: sin trades -> hadData false', async ()=>{
  const r = await fetchLargePrints('SPY','2026-08-10T13:30:00Z','2026-08-10T20:00:00Z',
    { _fetch: mockFetch([{ trades:[], next_page_token:null }]) });
  assert.strictEqual(r.hadData, false);
  assert.strictEqual(r.count, 0);
});

Promise.resolve().then(()=>new Promise(r=>setTimeout(r,150))).then(()=>{
  console.log('\nPRINTS ' + (pass===total ? 'OK ' : 'FAIL ') + pass + '/' + total);
  process.exit(pass===total ? 0 : 1);
});
