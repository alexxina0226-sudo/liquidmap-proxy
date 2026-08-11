// bench_prints.js — banco de prints.js (puro) + prints_live.js (I/O con fetch mock).
// Correr: node bench_prints.js   →   debe imprimir "PRINTS OK N/N".
'use strict';
const assert = require('assert');
const { filterLargePrints, summarizePrints } = require('./prints.js');
const { fetchLargePrints, mapTradesFull } = require('./prints_live.js');

let pass = 0, total = 0;
function t(name, fn){ total++; return fn().then(()=>{ pass++; console.log('  ✓', name); })
  .catch(e=>{ console.log('  ✗', name, '\n     ', e.message); }); }
function sync(name, fn){ total++; try{ fn(); pass++; console.log('  ✓', name); }
  catch(e){ console.log('  ✗', name, '\n     ', e.message); } }

// timestamps de un lunes (2026-08-10, EDT UTC-4). 14:00Z=10:00 ET (RTH), 19:30Z=15:30 ET (RTH), 12:00Z=08:00 ET (pre)
const RTH_A = '2026-08-10T14:00:00Z';   // 10:00 ET
const RTH_B = '2026-08-10T19:30:00Z';   // 15:30 ET
const PRE   = '2026-08-10T12:00:00Z';   // 08:00 ET (fuera RTH)

// ── 1) filterLargePrints: umbral, orden, guardas ──
sync('filter: pasa solo notional >= $1M', ()=>{
  const trades = [
    { ts:1, price:773, size:2000 },   // 1.546M  ✓
    { ts:2, price:773, size:500  },   // 386.5k  ✗
    { ts:3, price:774, size:5000 },   // 3.87M   ✓ (mayor)
    { ts:4, price:772, size:100  },   // 77.2k   ✗
  ];
  const r = filterLargePrints(trades, 1e6);
  assert.strictEqual(r.length, 2, 'deben pasar 2');
  assert.strictEqual(r[0].notional, 774*5000, 'el mayor primero');
  assert.strictEqual(r[1].notional, 773*2000, 'el menor despues');
});
sync('filter: umbral configurable (500k)', ()=>{
  const trades = [{ts:1,price:773,size:500}, {ts:2,price:773,size:2000}]; // 386.5k, 1.546M
  assert.strictEqual(filterLargePrints(trades, 5e5).length, 1, 'solo el de 1.546M supera 500k... 386.5k<500k');
  assert.strictEqual(filterLargePrints(trades, 3e5).length, 2, 'ambos superan 300k');
});
sync('filter: default 1e6 cuando umbral invalido', ()=>{
  const trades = [{ts:1,price:100,size:5000}]; // 500k < 1M
  assert.strictEqual(filterLargePrints(trades, null).length, 0);
  assert.strictEqual(filterLargePrints(trades, -5).length, 0);
  assert.strictEqual(filterLargePrints(trades, 'x').length, 0);
});
sync('filter: descarta basura (price/size null/<=0)', ()=>{
  const trades = [
    { ts:1, price:null, size:5000 },
    { ts:2, price:773,  size:0 },
    { ts:3, price:773,  size:-10 },
    { ts:4, price:0,    size:9999 },
    { ts:5, price:773,  size:2000 },   // unico valido y >1M
  ];
  const r = filterLargePrints(trades, 1e6);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].ts, 5);
});
sync('filter: no-array -> []', ()=>{
  assert.deepStrictEqual(filterLargePrints(null, 1e6), []);
  assert.deepStrictEqual(filterLargePrints(undefined, 1e6), []);
});
sync('filter: arrastra exchange/conditions crudo, sin interpretar', ()=>{
  const trades = [{ ts:1, price:773, size:2000, exchange:'D', conditions:['@','F'] }];
  const r = filterLargePrints(trades, 1e6);
  assert.strictEqual(r[0].exchange, 'D');
  assert.deepStrictEqual(r[0].conditions, ['@','F']);
});
sync('filter: exchange/conditions ausentes -> null', ()=>{
  const r = filterLargePrints([{ ts:1, price:773, size:2000 }], 1e6);
  assert.strictEqual(r[0].exchange, null);
  assert.strictEqual(r[0].conditions, null);
});

// ── 2) summarizePrints ──
sync('summary: count/total/max correctos', ()=>{
  const prints = [
    { notional: 3_870_000 },
    { notional: 1_546_000 },
    { notional: 2_000_000 },
  ];
  const s = summarizePrints(prints, 20);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.maxNotional, 3_870_000);
  assert.strictEqual(s.totalNotional, 3_870_000+1_546_000+2_000_000);
  assert.strictEqual(s.top[0].notional, 3_870_000, 'top ordenado desc');
});
sync('summary: topN recorta', ()=>{
  const prints = Array.from({length:30}, (_,i)=>({ notional: (i+1)*1e6 }));
  const s = summarizePrints(prints, 5);
  assert.strictEqual(s.count, 30, 'count es total, no recortado');
  assert.strictEqual(s.top.length, 5, 'top recortado a 5');
  assert.strictEqual(s.top[0].notional, 30e6, 'el mayor primero');
});
sync('summary: vacio -> ceros', ()=>{
  const s = summarizePrints([], 20);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.totalNotional, 0);
  assert.strictEqual(s.maxNotional, 0);
  assert.deepStrictEqual(s.top, []);
});

// ── 3) mapTradesFull: mapea x/c del row crudo Alpaca ──
sync('mapTradesFull: t/p/s/x/c -> ts/price/size/exchange/conditions', ()=>{
  const rows = [{ t:RTH_A, p:773.5, s:1200, x:'D', c:['@'] }];
  const m = mapTradesFull(rows);
  assert.strictEqual(m[0].price, 773.5);
  assert.strictEqual(m[0].size, 1200);
  assert.strictEqual(m[0].exchange, 'D');
  assert.deepStrictEqual(m[0].conditions, ['@']);
  assert.strictEqual(m[0].ts, new Date(RTH_A).getTime());
});
sync('mapTradesFull: no-array -> []', ()=>{
  assert.deepStrictEqual(mapTradesFull(null), []);
});

// ── 4) fetchLargePrints e2e con fetch mock (paginacion + RTH + resumen) ──
// mock: pagina 'trades' en 2 páginas; ignora 'quotes' (prints solo pide trades)
function mockFetch(pages){
  let i = 0;
  return async (url)=>{
    if(!String(url).includes('/trades')){
      return { ok:true, status:200, text: async()=>JSON.stringify({ quotes:[], next_page_token:null }) };
    }
    const page = pages[i] || { trades:[], next_page_token:null };
    i++;
    return { ok:true, status:200, text: async()=>JSON.stringify(page) };
  };
}
t('e2e: pagina 2 páginas, filtra RTH, resume', async ()=>{
  const pages = [
    { trades:[
        { t:RTH_A, p:773, s:2000, x:'D', c:['@'] },   // 1.546M ✓
        { t:RTH_A, p:773, s:500,  x:'P', c:['@'] },   // 386.5k ✗
      ], next_page_token:'p1' },
    { trades:[
        { t:RTH_B, p:774, s:5000, x:'P', c:['@'] },   // 3.87M ✓ (mayor)
        { t:PRE,   p:773, s:3000, x:'D', c:['@'] },   // 2.319M pero PRE-MARKET → RTH lo saca
      ], next_page_token:null },
  ];
  const r = await fetchLargePrints('SPY','2026-08-10T13:00:00Z','2026-08-10T20:00:00Z',
    { _fetch: mockFetch(pages), minNotional:1e6, topN:20 });
  assert.strictEqual(r.nTrades, 3, 'RTH deja 3 (saca el pre-market)');
  assert.strictEqual(r.count, 2, '2 prints >$1M en RTH');
  assert.strictEqual(r.top[0].notional, 774*5000, 'mayor primero');
  assert.strictEqual(r.maxNotional, 774*5000);
  assert.strictEqual(r.hadData, true);
  assert.strictEqual(r.partial, false);
  assert.strictEqual(r.top[0].exchange, 'P', 'venue crudo presente');
});
t('e2e: rth:0 incluye pre-market', async ()=>{
  const pages = [{ trades:[
      { t:RTH_A, p:773, s:2000, x:'D', c:['@'] },   // 1.546M
      { t:PRE,   p:773, s:3000, x:'D', c:['@'] },   // 2.319M pre-market
    ], next_page_token:null }];
  const r = await fetchLargePrints('SPY','2026-08-10T10:00:00Z','2026-08-10T20:00:00Z',
    { _fetch: mockFetch(pages), minNotional:1e6, rth:false });
  assert.strictEqual(r.count, 2, 'con rth off entran los 2');
  assert.strictEqual(r.maxNotional, 773*3000, 'el pre-market de 2.319M es el mayor');
});
t('e2e: sin trades -> hadData false, count 0', async ()=>{
  const r = await fetchLargePrints('SPY','2026-08-10T13:00:00Z','2026-08-10T20:00:00Z',
    { _fetch: mockFetch([{ trades:[], next_page_token:null }]) });
  assert.strictEqual(r.hadData, false);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.totalNotional, 0);
});

Promise.resolve()
  .then(()=>new Promise(r=>setTimeout(r,50)))  // deja correr los t() async
  .then(()=>{
    // pequeña espera extra por si algún async quedó en cola
    return new Promise(res=>setTimeout(res, 100));
  })
  .then(()=>{
    console.log('\nPRINTS ' + (pass===total ? 'OK ' : 'FAIL ') + pass + '/' + total);
    process.exit(pass===total ? 0 : 1);
  });
