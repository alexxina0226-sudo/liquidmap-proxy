// ════════════════════════════════════════════════════════════════════
//  bench_ruta_contrato.js — s71 · 26-jul-2026
//  Banco del CABLEADO de la Fase 3: la ruta /alpaca-contrato en server.js.
//  Dos capas: (1) chequeo estructural sobre el server.js REAL (no una copia);
//  (2) arranque REAL del server en un puerto de prueba y consulta HTTP de
//  verdad, con options_live monkey-patcheado para no tocar Alpaca.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

console.log('\n── ESTRUCTURA (sobre el server.js real) ──');
{
  ok('la ruta /alpaca-contrato está declarada', /app\.get\(\s*'\/alpaca-contrato'/.test(src));
  ok('llama a optLive.getContractPick', /optLive\.getContractPick\(/.test(src));
  ok('usa la capa reusable ya importada (no re-require)', (src.match(/require\('\.\/options_live'\)/g) || []).length === 1);
  const bloque = (src.match(/app\.get\(\s*'\/alpaca-contrato'[\s\S]*?\n\}\);/) || [''])[0];
  for (const p of ['sym', 'side', 'horizon', 'targetDelta', 'dteMin', 'dteMax', 'maxSpreadPct', 'minOI', 'band', 'top', 'live']) {
    ok(`pasa el parámetro ?${p}`, new RegExp(`${p}`).test(bloque));
  }
  ok('?fresh=1 saltea la caché (ttl:0)', /fresh\s*\?\s*0\s*:\s*undefined/.test(bloque));
  ok('responde JSON', /res\.json\(out\)/.test(bloque));
  ok('la ruta vieja /alpaca-options-metrics sigue intacta', /app\.get\(\s*'\/alpaca-options-metrics'/.test(src) && /optLive\.getOptionsMetrics\(/.test(src));
  ok('comentario de la ruta vieja ya no dice Black-Scholes como fuente', !/gamma → BS sobre IV implícita/.test(src));
  ok('documenta que NO decide si operar', /NO decide si operar/.test(src));
}

console.log('\n── ARRANQUE REAL + CONSULTA HTTP ──');
(async () => {
  // monkey-patch de la capa viva: el server usará esta versión (mismo objeto en require.cache)
  const optLive = require('./options_live');
  let recibido = null;
  optLive.getContractPick = async (sym, opts) => {
    recibido = { sym, opts };
    return { ok: true, sym: sym || 'SPY', side: opts.side || 'call', elegido: { strike: 104 }, eco: opts };
  };
  process.env.PORT = process.env.PORT || '4173';
  process.env.ALPACA_KEY_ID = process.env.ALPACA_KEY_ID || 'TEST';
  process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || 'TEST';
  process.env.NO_MONITORS = '1';

  let srv;
  try { srv = require('./server.js'); } catch (e) { ok('el server.js arranca sin romper', false, e.message); return fin(); }
  ok('el server.js arranca sin romper (require OK)', true);

  await new Promise(r => setTimeout(r, 600));
  const base = `http://127.0.0.1:${process.env.PORT}`;
  const _authTok = require('./auth.js').makeToken(process.env.LM_PASSWORD || 'trader2026'); // s78: sesión válida para el gate
  const get = async (p) => {
    const r = await fetch(base + p, { headers: { Cookie: 'lm_sess=' + _authTok } });
    return { status: r.status, body: await r.json() };
  };

  try {
    // s78: el gate bloquea a quien no tiene sesión (a nivel HTTP real)
    const rNoAuth = await fetch(base + '/alpaca-contrato?sym=SPY');
    ok('s78 · /alpaca-contrato SIN sesión → 401 (gate activo)', rNoAuth.status === 401, 'status=' + rNoAuth.status);

    const r1 = await get('/alpaca-contrato?sym=SPY&side=call&horizon=swing');
    ok('GET /alpaca-contrato responde 200', r1.status === 200, 'status=' + r1.status);
    ok('devuelve JSON del selector', r1.body && r1.body.ok === true && !!r1.body.elegido);
    ok('el sym viaja hasta la capa', recibido.sym === 'SPY');
    ok('el side viaja hasta la capa', recibido.opts.side === 'call');
    ok('el horizon viaja hasta la capa', recibido.opts.horizon === 'swing');

    const r2 = await get('/alpaca-contrato?sym=QQQ&side=put&horizon=scalp&targetDelta=0.55&minOI=300&fresh=1');
    ok('side=put viaja', recibido.opts.side === 'put');
    ok('horizon=scalp viaja', recibido.opts.horizon === 'scalp');
    ok('targetDelta viaja', recibido.opts.targetDelta === '0.55');
    ok('minOI viaja', recibido.opts.minOI === '300');
    ok('fresh=1 → ttl 0', recibido.opts.ttl === 0);
    ok('sin fresh → ttl undefined (usa caché)', (await get('/alpaca-contrato?sym=SPY')) && recibido.opts.ttl === undefined);

    const r3 = await get('/health');
    ok('/health sigue vivo (no rompimos el server)', r3.status === 200 && r3.body.status === 'ok');
  } catch (e) {
    ok('las consultas HTTP corren sin excepción', false, e.message);
  }
  fin();

  function fin() {
    console.log('\n' + (fail === 0 ? '✅' : '❌') + '  bench_ruta_contrato: ' + pass + '/' + (pass + fail) + '  (fail=' + fail + ')');
    process.exit(fail === 0 ? 0 : 1);
  }
})();
