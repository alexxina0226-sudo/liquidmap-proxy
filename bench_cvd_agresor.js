// bench_cvd_agresor.js — Banco del clasificador Lee-Ready (FASE 3, etapa 1).
// Juez imparcial: construye trades+quotes con verdad conocida y verifica cada regla.
'use strict';
const { matchPrevailingQuotes, classifyTrades, aggregateByCandle, computeAggressorCVD } = require('./cvd_agresor.js');

let pass = 0, fail = 0;
function ok(name, cond){ if(cond){ pass++; console.log('  ✓ '+name); } else { fail++; console.log('  ✗ '+name); } }
function eq(name, a, b){ ok(name+' ('+a+'=='+b+')', a === b); }
function near(name, a, b, tol){ ok(name+' ('+a+'≈'+b+')', Math.abs(a-b) <= (tol||1e-9)); }

console.log('\n=== 1. QUOTE RULE ===');
// quote vigente bid=100 ask=101 mid=100.5
{
  const quotes = [{ts:0, bid:100, ask:101}];
  const buy  = classifyTrades([{ts:10, price:100.8, size:5}], quotes, {});
  const sell = classifyTrades([{ts:10, price:100.2, size:5}], quotes, {});
  const atAsk= classifyTrades([{ts:10, price:101,   size:5}], quotes, {}); // > mid -> buy
  const atBid= classifyTrades([{ts:10, price:100,   size:5}], quotes, {}); // < mid -> sell
  eq('precio sobre mid -> buy', buy[0].side, 'buy');
  eq('  regla = quote', buy[0].rule, 'quote');
  eq('precio bajo mid -> sell', sell[0].side, 'sell');
  eq('trade AL ASK -> buy', atAsk[0].side, 'buy');
  eq('trade AL BID -> sell', atBid[0].side, 'sell');
}

console.log('\n=== 2. TICK RULE (trade al midpoint) ===');
{
  const quotes = [{ts:0, bid:100, ask:101}]; // mid 100.5
  // dos trades exactamente al midpoint: el primero seed, el segundo por tick
  const seq = classifyTrades([
    {ts:10, price:100.5, size:1},   // al mid, sin prevPrice -> seed (buy por default)
    {ts:20, price:100.5, size:1}    // al mid, zero-tick vs 100.5 -> carry (buy)
  ], quotes, {});
  eq('primer mid sin historia -> seed', seq[0].rule, 'seed');
  // uptick / downtick sobre el midpoint
  const up = classifyTrades([
    {ts:10, price:100.5, size:1},   // seed buy
    {ts:20, price:100.6, size:1}    // 100.6 > mid 100.5 -> quote rule ya lo hace buy... forzamos midpoint puro:
  ], quotes, {});
  // Para tick puro necesitamos price == mid en ambos y variar prevPrice via quote nulo:
  const noQuote = classifyTrades([
    {ts:10, price:50, size:1},   // sin quote (ts<0? no; quotes[0].ts=0<=10) -> hay quote mid100.5 -> 50<mid -> sell(quote)
  ], quotes, {});
  eq('sin ambiguedad, quote manda', noQuote[0].rule, 'quote');
  // tick real: sin quotes en absoluto
  const tick = classifyTrades([
    {ts:10, price:100, size:1},   // sin quote previo -> seed buy
    {ts:20, price:101, size:1},   // uptick -> buy(tick)
    {ts:30, price:100, size:1},   // downtick -> sell(tick)
    {ts:40, price:100, size:1}    // zero-tick -> carry(sell)
  ], [], {});
  eq('sin quote, primer trade -> seed', tick[0].rule, 'seed');
  eq('uptick -> buy',   tick[1].side, 'buy');   eq('  regla tick', tick[1].rule, 'tick');
  eq('downtick -> sell', tick[2].side, 'sell'); eq('  regla tick', tick[2].rule, 'tick');
  eq('zero-tick -> carry direccion previa (sell)', tick[3].side, 'sell'); eq('  regla carry', tick[3].rule, 'carry');
}

console.log('\n=== 3. QUOTE VIGENTE (matching temporal) ===');
{
  // 3 quotes; el trade debe tomar el ULTIMO con ts <= trade.ts, no uno posterior
  const quotes = [
    {ts:0,  bid:100, ask:101},  // mid 100.5
    {ts:50, bid:200, ask:201},  // mid 200.5
    {ts:99, bid:300, ask:301}   // mid 300.5 (posterior al trade)
  ];
  const m = matchPrevailingQuotes([{ts:60, price:1, size:1}], quotes);
  near('quote vigente en ts=60 es el de ts=50 (mid 200.5)', m[0].mid, 200.5);
  // trade ANTES del primer quote -> null -> cae a tick rule
  const early = classifyTrades([{ts:-5, price:1, size:1}], quotes, {seedSide:'sell'});
  eq('trade antes de todo quote -> seed (seedSide)', early[0].side, 'sell');
  eq('  regla seed', early[0].rule, 'seed');
}

console.log('\n=== 4. AGREGACION POR VELA ===');
{
  const candles = [{t:0},{t:100},{t:200}]; const tfMs = 100;
  const classified = [
    {ts:10,  size:3, side:'buy'},
    {ts:20,  size:2, side:'sell'},
    {ts:120, size:5, side:'buy'},
    {ts:250, size:4, side:'sell'},
    {ts:999, size:9, side:'buy'}   // fuera de rango -> se ignora
  ];
  const per = aggregateByCandle(classified, candles, tfMs);
  eq('vela0 buyV', per[0].buyV, 3);  eq('vela0 sellV', per[0].sellV, 2);  eq('vela0 cvd', per[0].cvd, 1);
  eq('vela1 buyV', per[1].buyV, 5);  eq('vela1 cvd', per[1].cvd, 5);
  eq('vela2 sellV', per[2].sellV, 4); eq('vela2 cvd', per[2].cvd, -4);
  const totalV = per.reduce((a,p)=>a+p.buyV+p.sellV,0);
  eq('conservacion: vol clasificado en velas = 3+2+5+4 (el fuera-de-rango no cuenta)', totalV, 14);
}

console.log('\n=== 5. END-TO-END con VERDAD CONOCIDA ===');
{
  // Construyo una tape donde SE la respuesta: 3 compras agresivas (al ask) y 2 ventas (al bid).
  const quotes = [{ts:0, bid:100, ask:101}]; // mid 100.5
  const trades = [
    {ts:5,  price:101, size:10},  // buy
    {ts:15, price:101, size:20},  // buy
    {ts:25, price:100, size:5},   // sell
    {ts:35, price:101, size:30},  // buy
    {ts:45, price:100, size:8}    // sell
  ];
  const candles = [{t:0}]; const tfMs = 100;
  const r = computeAggressorCVD(trades, quotes, candles, tfMs, {});
  eq('hadData', r.hadData, true);
  eq('nClassified', r.nClassified, 5);
  eq('buyV = 10+20+30', r.perBar[0].buyV, 60);
  eq('sellV = 5+8',     r.perBar[0].sellV, 13);
  eq('cvd = 60-13',     r.perBar[0].cvd, 47);
  // contraste con el estimador viejo (direccion de vela) NO aplica aca — este es el juez real.
}

console.log('\n=== 6. HONESTIDAD / GUARDAS ===');
{
  const empty = computeAggressorCVD([], [], [{t:0}], 100, {});
  eq('sin trades -> hadData false', empty.hadData, false);
  eq('sin trades -> perBar en cero', empty.perBar[0].cvd, 0);
  // basura filtrada: size<=0 o price no finito no cuenta
  const junk = classifyTrades([
    {ts:10, price:101, size:0},      // size 0 -> descartado
    {ts:20, price:NaN, size:5},      // price NaN -> descartado
    {ts:30, price:101, size:7}       // valido
  ], [{ts:0,bid:100,ask:101}], {});
  eq('basura filtrada, queda 1', junk.length, 1);
  eq('  el valido es buy', junk[0].side, 'buy');
  // determinismo
  const a = computeAggressorCVD([{ts:5,price:101,size:1}], [{ts:0,bid:100,ask:101}], [{t:0}], 100, {});
  const b = computeAggressorCVD([{ts:5,price:101,size:1}], [{ts:0,bid:100,ask:101}], [{t:0}], 100, {});
  eq('determinista', JSON.stringify(a), JSON.stringify(b));
}

console.log('\n=== 7. ANTI-REGRESION: bid/ask cruzado y quote parcial ===');
{
  // quote con bid null (dato parcial) -> ese trade cae a tick rule, no rompe
  const q = [{ts:0, bid:null, ask:101}];
  const r = classifyTrades([{ts:10, price:101, size:1},{ts:20, price:102, size:1}], q, {});
  eq('quote parcial no rompe: primer trade seed', r[0].rule, 'seed');
  eq('  segundo uptick -> buy tick', r[1].rule, 'tick');
  // quote cruzado (bid>ask): mid sigue computable, quote rule opera
  const cx = classifyTrades([{ts:10, price:150, size:1}], [{ts:0, bid:200, ask:100}], {}); // mid 150 -> price==mid -> tick/seed
  eq('quote cruzado: price==mid cae a seed', cx[0].rule, 'seed');
}

console.log('\n──────────────────────────────');
console.log(`RESULTADO: ${pass}/${pass+fail} verde` + (fail? `  (${fail} en rojo)`:' — TODO VERDE'));
process.exit(fail ? 1 : 0);
