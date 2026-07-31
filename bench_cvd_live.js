// bench_cvd_live.js — Banco de la capa I/O del CVD por agresor (FASE 3, etapa 2).
// fetch MOCK: no toca la red. Verifica URLs, feed=sip, paginacion, mapeo de campos,
// filtro RTH y el agregado real end-to-end contra verdad conocida.
'use strict';
const live = require('./cvd_live.js');

let pass=0, fail=0;
function ok(n,c){ if(c){pass++;console.log('  ✓ '+n);}else{fail++;console.log('  ✗ '+n);} }
function eq(n,a,b){ ok(n+' ('+a+'=='+b+')', a===b); }

// helper: construye una respuesta fetch-like
function resp(obj){ return { ok:true, status:200, text: async()=>JSON.stringify(obj) }; }

(async () => {
console.log('\n=== 1. URLs y feed=sip ===');
{
  const seen = [];
  const _fetch = async (url)=>{ seen.push(url);
    if(url.includes('/trades')) return resp({ trades:[], next_page_token:null });
    return resp({ quotes:[], next_page_token:null });
  };
  await live.fetchAggressorCVD('AAPL','2026-07-30T13:30:00Z','2026-07-30T20:00:00Z',{_fetch, rth:false});
  ok('pidio /trades', seen.some(u=>u.includes('/v2/stocks/AAPL/trades')));
  ok('pidio /quotes', seen.some(u=>u.includes('/v2/stocks/AAPL/quotes')));
  ok('usa feed=sip',  seen.every(u=>u.includes('feed=sip')));
  ok('manda start/end', seen.every(u=>u.includes('start=')&&u.includes('end=')));
}

console.log('\n=== 2. PAGINACION (sigue next_page_token) ===');
{
  let tpage=0;
  const _fetch = async (url)=>{
    if(url.includes('/trades')){
      tpage++;
      if(tpage===1) return resp({ trades:[{t:'2026-07-30T14:00:00Z',p:101,s:5}], next_page_token:'AAA' });
      return resp({ trades:[{t:'2026-07-30T14:00:01Z',p:101,s:7}], next_page_token:null });
    }
    return resp({ quotes:[{t:'2026-07-30T13:59:00Z',bp:100,ap:101}], next_page_token:null });
  };
  const r = await live.fetchAggressorCVD('MSFT','2026-07-30T13:30:00Z','2026-07-30T20:00:00Z',{_fetch, rth:false});
  eq('trajo 2 trades de 2 paginas', r.nTrades, 2);
  eq('buyV real = 5+7 (ambos al ask=101>mid100.5)', r.buyV, 12);
  eq('cvdReal', r.cvdReal, true);
}

console.log('\n=== 3. MAPEO DE CAMPOS (p/s, bp/ap) ===');
{
  const _fetch = async (url)=>{
    if(url.includes('/trades')) return resp({ trades:[
      {t:'2026-07-30T14:00:00Z',p:250.5,s:10},  // al ask -> buy
      {t:'2026-07-30T14:00:01Z',p:249.5,s:4}    // al bid -> sell
    ], next_page_token:null });
    return resp({ quotes:[{t:'2026-07-30T13:59:00Z',bp:249.5,ap:250.5}], next_page_token:null }); // mid 250
  };
  const r = await live.fetchAggressorCVD('NVDA','2026-07-30T13:30:00Z','2026-07-30T20:00:00Z',{_fetch, rth:false});
  eq('buyV=10', r.buyV, 10);
  eq('sellV=4', r.sellV, 4);
  eq('cvd=6',   r.cvd, 6);
}

console.log('\n=== 4. FILTRO RTH (9:30–16:00 ET) ===');
{
  // 30-jul-2026 es verano → EDT = UTC-4. 13:30Z=9:30 ET (dentro), 12:00Z=8:00 ET (pre, fuera), 20:30Z=16:30 ET (fuera)
  const _fetch = async (url)=>{
    if(url.includes('/trades')) return resp({ trades:[
      {t:'2026-07-30T12:00:00Z',p:101,s:100},  // 8:00 ET pre-market -> fuera
      {t:'2026-07-30T14:00:00Z',p:101,s:10},   // 10:00 ET -> dentro
      {t:'2026-07-30T20:30:00Z',p:101,s:100}   // 16:30 ET after -> fuera
    ], next_page_token:null });
    return resp({ quotes:[{t:'2026-07-30T13:59:00Z',bp:100,ap:101}], next_page_token:null });
  };
  const withRTH = await live.fetchAggressorCVD('AAPL','2026-07-30T11:00:00Z','2026-07-30T21:00:00Z',{_fetch, rth:true});
  eq('RTH ON: solo la de 10:00 ET (size 10)', withRTH.buyV, 10);
  eq('RTH ON: nTrades=1', withRTH.nTrades, 1);
  const noRTH = await live.fetchAggressorCVD('AAPL','2026-07-30T11:00:00Z','2026-07-30T21:00:00Z',{_fetch, rth:false});
  eq('RTH OFF: las 3 (100+10+100)', noRTH.buyV, 210);
  // sanity del helper de minutos ET
  eq('13:30Z = 9:30 ET = 570 min', live.etMinutes(Date.parse('2026-07-30T13:30:00Z')), 570);
  ok('inRTH(9:30 ET) true', live.inRTH(Date.parse('2026-07-30T13:30:00Z')));
  ok('inRTH(16:00 ET) false (borde)', !live.inRTH(Date.parse('2026-07-30T20:00:00Z')));
}

console.log('\n=== 5. HONESTIDAD: sin trades -> cvdReal false ===');
{
  const _fetch = async (url)=> url.includes('/trades') ? resp({trades:[],next_page_token:null}) : resp({quotes:[{t:'2026-07-30T14:00:00Z',bp:100,ap:101}],next_page_token:null});
  const r = await live.fetchAggressorCVD('X','2026-07-30T13:30:00Z','2026-07-30T20:00:00Z',{_fetch, rth:false});
  eq('sin trades -> cvdReal false', r.cvdReal, false);
  eq('sin trades -> cvd 0', r.cvd, 0);
}

console.log('\n=== 6. ERROR HTTP se propaga ===');
{
  const _fetch = async (url)=> ({ ok:false, status:403, text: async()=>JSON.stringify({message:'forbidden feed'}) });
  let threw=false;
  try { await live.fetchAggressorCVD('X','2026-07-30T13:30:00Z','2026-07-30T20:00:00Z',{_fetch, rth:false}); }
  catch(e){ threw = /http_403/.test(e.message); }
  ok('403 lanza error legible', threw);
}

console.log('\n=== 7. TICK RULE end-to-end via ruta (trades al mid) ===');
{
  const _fetch = async (url)=>{
    if(url.includes('/trades')) return resp({ trades:[
      {t:'2026-07-30T14:00:00Z',p:100.5,s:3},  // al mid, sin prev -> seed buy
      {t:'2026-07-30T14:00:01Z',p:100.4,s:2}   // 100.4<mid100.5 -> sell(quote)
    ], next_page_token:null });
    return resp({ quotes:[{t:'2026-07-30T13:59:00Z',bp:100,ap:101}], next_page_token:null });
  };
  const r = await live.fetchAggressorCVD('T','2026-07-30T13:30:00Z','2026-07-30T20:00:00Z',{_fetch, rth:false});
  eq('buyV=3 (seed) sellV=2 (quote)', r.buyV+'/'+r.sellV, '3/2');
}

console.log('\n──────────────────────────────');
console.log(`RESULTADO: ${pass}/${pass+fail} verde` + (fail? `  (${fail} en rojo)`:' — TODO VERDE'));
process.exit(fail ? 1 : 0);
})();
