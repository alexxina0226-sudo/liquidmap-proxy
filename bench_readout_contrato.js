// ════════════════════════════════════════════════════════════════════
//  bench_readout_contrato.js — s73 · 27-jul-2026
//  Banco del CONTRATO PEGADO A LA SEÑAL (readout compacto en la barra de
//  señal). Extrae updateContractReadout del HTML real y la EJECUTA con
//  stubs (elemento DOM falso + fetch simulado). Verifica:
//   A) FUNCIONAL: aparece solo con señal direccional (NO gatea por score),
//      call/put por el titular, horizonte por TF, throttle 3 min por
//      (sym|tf|lado), re-pide al cambiar de símbolo, guard de respuesta
//      vieja, ok:false → "sin contrato líquido", clic → contratoDiag.
//   B) ESTRUCTURAL: DOM del readout, CSS, llamada en el render, y que el
//      criterio sea sig.type (BUY/SELL) y NO score>=7 (ese gate es del
//      emisor a Telegram, no del readout en pantalla).
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };
const tick = () => new Promise(r => setTimeout(r, 5));   // vacía microtareas de los .then

// tfToHorizon REAL extraída del HTML (misma que usa el mapa)
const tfToHorizon = new Function('return (' + html.match(/function tfToHorizon\(t\)\{[^}]*\}/)[0].replace('function tfToHorizon', 'function') + ')')();

// cuerpo REAL de updateContractReadout (sin la línea `const _ctr` → _ctr se inyecta compartido)
const FN_SRC = html.match(/function updateContractReadout\(sig\)\{[\s\S]*?\n\}(?=\nwindow\.updateContractReadout)/)[0];

function nuevoEl() { return { style: { display: '' }, className: '', innerHTML: '', title: '', onclick: null }; }

// arma un entorno de ejecución para la función real
function correr({ el, sym, tf, sig, resp, fetchLog, contratoDiagLog, _ctr }) {
  const env = {
    document: { getElementById: () => el },
    sym, tf,
    CONTRATO_URL: 'https://x/alpaca-contrato',
    tfToHorizon,
    contratoDiag: () => { contratoDiagLog.push(1); },
    fetch: (url) => { fetchLog.push(url); return Promise.resolve({ json: async () => resp }); },
    _ctr,
  };
  const keys = Object.keys(env);
  const fn = new Function(...keys, FN_SRC + '\n return updateContractReadout;');
  fn(...keys.map(k => env[k]))(sig);
}

const RESP_OK = {
  ok: true, fuente_gamma: 'OPRA nativa', alternativas: [],
  elegido: { symbol: 'TSLA260803P00305000', type: 'put', strike: 305, expiration: '2026-08-03',
    dte: 7.2, delta: -0.41, thetaPctDia: 8.74, breakevenMov: 16.05, mid: 6.63, bid: 6.55, ask: 6.70,
    spreadPct: 2.26, oi: 102, iv: 0.4985, src: 'opra' },
};
const RESP_OK_CALL = { ...RESP_OK, elegido: { ...RESP_OK.elegido, type: 'call', delta: 0.41, symbol: 'X_C' } };
const RESP_FALSE = { ok: false, motivo: 'sin contrato', descartes: { spread: 5 } };

const SELL = { type: 'SELL', score: 2 };   // score BAJO a propósito (el readout debe salir igual)
const BUY = { type: 'BUY', score: 3 };
const NEUTRAL = { type: 'NEUTRAL', score: 0 };

(async () => {
  console.log('\n── A) funcional (updateContractReadout ejecutada de verdad) ──');

  // A1: NEUTRAL → oculto, sin fetch
  {
    const el = nuevoEl(), fetchLog = [], _ctr = { key: 'x', ts: 0, err: false };
    correr({ el, sym: 'TSLA', tf: '240', sig: NEUTRAL, resp: RESP_OK, fetchLog, contratoDiagLog: [], _ctr });
    await tick();
    ok('A1 NEUTRAL oculta el readout', el.style.display === 'none', el.style.display);
    ok('A1 NEUTRAL no dispara fetch', fetchLog.length === 0, String(fetchLog.length));
    ok('A1 NEUTRAL limpia _ctr.key', _ctr.key === null, String(_ctr.key));
  }

  // A2: SELL score 2 (bajo) → SÍ aparece, side=put, horizonte swing (tf 240)
  {
    const el = nuevoEl(), fetchLog = [], cdLog = [], _ctr = { key: null, ts: 0, err: false };
    correr({ el, sym: 'TSLA', tf: '240', sig: SELL, resp: RESP_OK, fetchLog, contratoDiagLog: cdLog, _ctr });
    await tick();
    ok('A2 SELL con score bajo igual aparece (NO gatea por score)', el.style.display === '' && fetchLog.length === 1, el.style.display + '/' + fetchLog.length);
    ok('A2 fetch pide side=put', /side=put/.test(fetchLog[0]), fetchLog[0]);
    ok('A2 fetch pide horizon=swing (tf 4H)', /horizon=swing/.test(fetchLog[0]), fetchLog[0]);
    ok('A2 fetch pide sym=TSLA', /sym=TSLA/.test(fetchLog[0]), fetchLog[0]);
    ok('A2 clase is-put', el.className.includes('is-put'), el.className);
    ok('A2 muestra strike PUT 305', el.innerHTML.includes('PUT 305'), el.innerHTML);
    ok('A2 muestra DTE, Δ, θ y BE', el.innerHTML.includes('7.2DTE') && el.innerHTML.includes('Δ-0.41') && el.innerHTML.includes('θ8.74%/d') && el.innerHTML.includes('BE 16.05'), el.innerHTML);
    ok('A2 tooltip trae fuente OPRA nativa', el.title.includes('OPRA nativa'), el.title);
    ok('A2 clic cableado a contratoDiag', typeof el.onclick === 'function', typeof el.onclick);
    el.onclick(); ok('A2 el clic llama contratoDiag', cdLog.length === 1, String(cdLog.length));
  }

  // A3: BUY → side=call, clase is-call
  {
    const el = nuevoEl(), fetchLog = [], _ctr = { key: null, ts: 0, err: false };
    correr({ el, sym: 'AAPL', tf: '60', sig: BUY, resp: RESP_OK_CALL, fetchLog, contratoDiagLog: [], _ctr });
    await tick();
    ok('A3 BUY pide side=call', /side=call/.test(fetchLog[0]), fetchLog[0]);
    ok('A3 BUY clase is-call', el.className.includes('is-call'), el.className);
  }

  // A4: throttle — mismo (sym|tf|lado) dos veces <3min → un solo fetch
  {
    const el = nuevoEl(), fetchLog = [], _ctr = { key: null, ts: 0, err: false };
    correr({ el, sym: 'TSLA', tf: '240', sig: SELL, resp: RESP_OK, fetchLog, contratoDiagLog: [], _ctr });
    await tick();
    correr({ el, sym: 'TSLA', tf: '240', sig: SELL, resp: RESP_OK, fetchLog, contratoDiagLog: [], _ctr });
    await tick();
    ok('A4 throttle: 2 renders mismo contrato = 1 solo fetch', fetchLog.length === 1, String(fetchLog.length));
  }

  // A5: cambio de símbolo (mismo _ctr) → re-pide, 2do fetch con el nuevo sym
  {
    const el = nuevoEl(), fetchLog = [], _ctr = { key: null, ts: 0, err: false };
    correr({ el, sym: 'TSLA', tf: '240', sig: SELL, resp: RESP_OK, fetchLog, contratoDiagLog: [], _ctr });
    await tick();
    correr({ el, sym: 'AAPL', tf: '240', sig: SELL, resp: RESP_OK, fetchLog, contratoDiagLog: [], _ctr });
    await tick();
    ok('A5 cambio de símbolo re-dispara fetch', fetchLog.length === 2, String(fetchLog.length));
    ok('A5 el 2do fetch pide el símbolo nuevo', /sym=AAPL/.test(fetchLog[1]), fetchLog[1]);
  }

  // A6: ok:false → "sin contrato líquido", clase empty
  {
    const el = nuevoEl(), fetchLog = [], _ctr = { key: null, ts: 0, err: false };
    correr({ el, sym: 'TSLA', tf: '240', sig: SELL, resp: RESP_FALSE, fetchLog, contratoDiagLog: [], _ctr });
    await tick();
    ok('A6 ok:false muestra "sin contrato líquido"', el.innerHTML.includes('sin contrato líquido'), el.innerHTML);
    ok('A6 ok:false clase empty', el.className.includes('empty'), el.className);
  }

  // A7: horizonte por TF — 5m→scalp, D→position
  {
    const el = nuevoEl(), fetchLog = [], _ctr = { key: null, ts: 0, err: false };
    correr({ el, sym: 'TSLA', tf: '5', sig: SELL, resp: RESP_OK, fetchLog, contratoDiagLog: [], _ctr });
    await tick();
    ok('A7 tf 5m → horizon=scalp', /horizon=scalp/.test(fetchLog[0]), fetchLog[0]);
    const el2 = nuevoEl(), fetchLog2 = [], _ctr2 = { key: null, ts: 0, err: false };
    correr({ el: el2, sym: 'TSLA', tf: 'D', sig: SELL, resp: RESP_OK, fetchLog: fetchLog2, contratoDiagLog: [], _ctr: _ctr2 });
    await tick();
    ok('A7 tf D → horizon=position', /horizon=position/.test(fetchLog2[0]), fetchLog2[0]);
  }

  // A8: señal → NEUTRAL después → oculta y limpia onclick
  {
    const el = nuevoEl(), fetchLog = [], _ctr = { key: null, ts: 0, err: false };
    correr({ el, sym: 'TSLA', tf: '240', sig: SELL, resp: RESP_OK, fetchLog, contratoDiagLog: [], _ctr });
    await tick();
    correr({ el, sym: 'TSLA', tf: '240', sig: NEUTRAL, resp: RESP_OK, fetchLog, contratoDiagLog: [], _ctr });
    await tick();
    ok('A8 al volver a NEUTRAL oculta', el.style.display === 'none', el.style.display);
    ok('A8 al volver a NEUTRAL limpia onclick', el.onclick === null, String(el.onclick));
  }

  // ── B) estructural sobre el HTML real ──
  console.log('\n── B) estructural ──');
  ok('B1 DOM: elemento id="sig-contrato" en la barra de señal', /id="sig-contrato"/.test(html));
  ok('B2 CSS: .sig-contrato + variantes is-call/is-put/loading/empty',
    /\.sig-contrato\{/.test(html) && /\.sig-contrato\.is-call\{/.test(html) && /\.sig-contrato\.is-put\{/.test(html) && /\.sig-contrato\.loading\{/.test(html) && /\.sig-contrato\.empty\{/.test(html));
  ok('B3 el render llama updateContractReadout(sig)', /updateContractReadout\(sig\);/.test(html));
  ok('B4 criterio = sig.type BUY/SELL (no score)', /sig\.type!=='BUY' && sig\.type!=='SELL'/.test(FN_SRC));
  ok('B5 el readout NO gatea por score>=7 (ese gate es del emisor)', !/score>=7|score >= 7/.test(FN_SRC));
  ok('B6 throttle de 180000ms (3 min) por key sym|tf|lado', /180000/.test(FN_SRC) && /sym\+'\|'\+tf\+'\|'\+side/.test(FN_SRC));
  ok('B7 guard de respuesta vieja (_ctr.key!==key → descartar)', /_ctr\.key!==key/.test(FN_SRC));

  console.log(`\n${fail === 0 ? '✅' : '❌'} bench_readout_contrato: ${pass}/${pass + fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
