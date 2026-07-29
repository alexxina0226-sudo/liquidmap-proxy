// ════════════════════════════════════════════════════════════════════
//  bench_audit_route.js (s77) — banco de la ruta /alpaca-audit (auditContract).
//  Usa un _fetch INYECTADO (mock) → prueba TODO el camino sin tocar Alpaca:
//   A) construccion de URLs (endpoint correcto + feed opra/sip + params).
//   B) normalizacion de barras Alpaca ({t,o,h,l,c,v}) → cerebro + scorecard.
//   C) paginacion (next_page_token) junta las paginas.
//   D) validacion de params (contract/entry/tp faltantes).
//   E) parseOCC deriva sym/side del símbolo OCC.
// ════════════════════════════════════════════════════════════════════
'use strict';
// keys dummy ANTES de require (se leen al cargar el modulo) para pasar el guard
process.env.ALPACA_KEY_ID = process.env.ALPACA_KEY_ID || 'test';
process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || 'test';
const OL = require('./options_live.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

const CONTRACT = 'AAPL260807C00345000';
const under = [ // {t,o,h,l,c,v} — misma trayectoria que bench_audit (call que toca TP1@2, TP2@4)
  { t: '2026-07-28', o: 100, h: 103, l: 99, c: 102, v: 1 },
  { t: '2026-07-29', o: 102, h: 106, l: 101, c: 105, v: 1 },
  { t: '2026-07-30', o: 105, h: 109, l: 104, c: 108, v: 1 },
  { t: '2026-07-31', o: 108, h: 110, l: 107, c: 109, v: 1 },
  { t: '2026-08-03', o: 109, h: 113, l: 108, c: 112, v: 1 },
  { t: '2026-08-04', o: 112, h: 114, l: 110, c: 113, v: 1 },
];
const opt = [
  { t: '2026-07-28', o: 5.4, h: 5.6, l: 5.3, c: 5.5, v: 1 }, { t: '2026-07-29', o: 6.5, h: 7, l: 6.3, c: 6.8, v: 1 },
  { t: '2026-07-30', o: 7.8, h: 8.2, l: 7.6, c: 8.0, v: 1 }, { t: '2026-07-31', o: 8.4, h: 8.8, l: 8.2, c: 8.6, v: 1 },
  { t: '2026-08-03', o: 10.2, h: 10.7, l: 10, c: 10.5, v: 1 }, { t: '2026-08-04', o: 10.8, h: 11.2, l: 10.6, c: 11.0, v: 1 },
];

// mock _fetch: registra las URLs y responde con la forma Alpaca segun el endpoint
function mkFetch(urls, opts = {}) {
  return async (url) => {
    urls.push(url);
    return { json: async () => {
      if (url.includes('/v2/stocks/bars'))     return { bars: { AAPL: under }, next_page_token: null };
      if (url.includes('/v1beta1/options/bars')) {
        if (opts.paginate && !url.includes('page_token')) return { bars: { [CONTRACT]: opt.slice(0, 3) }, next_page_token: 'TK2' };
        if (opts.paginate) return { bars: { [CONTRACT]: opt.slice(3) }, next_page_token: null };
        return { bars: { [CONTRACT]: opt }, next_page_token: null };
      }
      return { bars: {} };
    } };
  };
}

const baseQ = {
  contract: CONTRACT, entry: '2026-07-28T13:30:00Z', end: '2026-08-05T00:00:00Z',
  horizon: 'swing', spot0: '100', mid: '5', delta: '0.4', gamma: '0.03', theta: '0.3', be: '12.5',
  tp1: '108', tp2: '112', tp3: '118', sl: '96', earnings: '2026-07-30',
};

(async () => {
  console.log('── A) URLs (endpoint + feed) ──');
  let urls = [];
  const out = await OL.auditContract(baseQ, mkFetch(urls));
  const uStock = urls.find(u => u.includes('/v2/stocks/bars'));
  const uOpt = urls.find(u => u.includes('/v1beta1/options/bars'));
  ok('A1 pega a /v2/stocks/bars con symbols=AAPL y feed=sip', !!uStock && uStock.includes('symbols=AAPL') && uStock.includes('feed=sip'), uStock);
  ok('A2 pega a /v1beta1/options/bars con el contrato y feed=opra', !!uOpt && uOpt.includes('symbols=AAPL260807C00345000') && uOpt.includes('feed=opra'), uOpt);
  ok('A3 la ventana [entry,end] va en la URL', !!uOpt && uOpt.includes('start=') && uOpt.includes('end='), uOpt);
  ok('A4 timeframe swing → 1Hour', !!uOpt && uOpt.includes('timeframe=1Hour'), uOpt);

  console.log('\n── B) normalizacion + scorecard end-to-end ──');
  ok('B1 ok', out.ok === true, JSON.stringify(out.error));
  ok('B2 cuenta barras (6 subyacente / 6 opcion)', out.barras.subyacente === 6 && out.barras.opcion === 6, JSON.stringify(out.barras));
  ok('B3 side derivado del OCC = call', out.side === 'call', out.side);
  ok('B4 outcome = gano', out.auditoria.outcome === 'gano', out.auditoria.outcome);
  ok('B5 TP1 prima real = 8.0 (de las barras normalizadas)', out.auditoria.tps[0].realPremium === 8.0, out.auditoria.tps[0].realPremium);
  ok('B6 TP1 proyectada = 8.26', out.auditoria.tps[0].projPremium === 8.26, out.auditoria.tps[0].projPremium);
  ok('B7 earning en la ventana marcado', out.auditoria.earnings.enVentana === true, JSON.stringify(out.auditoria.earnings));
  ok('B8 R/R real maxFav +120%', out.auditoria.realRR.maxFavPct === 120, JSON.stringify(out.auditoria.realRR));

  console.log('\n── C) paginacion ──');
  let urls2 = [];
  const out2 = await OL.auditContract(baseQ, mkFetch(urls2, { paginate: true }));
  ok('C1 junta las 2 paginas de la opcion (3+3=6)', out2.barras.opcion === 6, out2.barras.opcion);
  ok('C2 pidio la 2da pagina con page_token', urls2.some(u => u.includes('page_token=TK2')), 'no pidió page_token');

  console.log('\n── D) validacion de params ──');
  ok('D1 sin contract → error', (await OL.auditContract({}, mkFetch([]))).error.includes('contract'));
  ok('D2 sin entry → error', (await OL.auditContract({ contract: CONTRACT }, mkFetch([]))).error.includes('entry'));
  ok('D3 sin tp → error', (await OL.auditContract({ contract: CONTRACT, entry: '2026-07-28', spot0: '100', mid: '5', delta: '0.4' }, mkFetch([]))).error.includes('faltan datos'));

  console.log('\n── E) parseOCC ──');
  ok('E1 call: AAPL...C... → {AAPL, call}', OL.parseOCC('AAPL260807C00345000').sym === 'AAPL' && OL.parseOCC('AAPL260807C00345000').side === 'call');
  ok('E2 put: ...P... → put', OL.parseOCC('TSLA260919P00300000').side === 'put' && OL.parseOCC('TSLA260919P00300000').sym === 'TSLA');
  ok('E3 basura → {null,null}', OL.parseOCC('no-es-occ').sym === null);

  console.log(`\n${fail === 0 ? '✅' : '❌'} bench_audit_route: ${pass}/${pass + fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
