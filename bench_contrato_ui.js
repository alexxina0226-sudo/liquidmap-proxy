// ════════════════════════════════════════════════════════════════════
//  bench_contrato_ui.js — s72 · 27-jul-2026
//  Banco del PASO DE UI del selector de contrato. Tres frentes:
//   A) FIX fuente_gamma (options_live.js): la etiqueta ahora se mide sobre
//      los candidatos que PASARON los filtros (elegido + alternativas), no
//      sobre la cadena cruda que incluye ilíquidos sin griegas. Entierra el
//      bug s71 que decía "mixta" para un pick 100% OPRA. Usa el _fetch
//      inyectable (Alpaca simulado, sin red ni keys).
//   B) COMANDO /contrato en el HTML del mapa (estructural sobre el archivo
//      real): CONTRATO_URL, la función contratoDiag, el wiring del comando
//      con parseo de args, el mapeo TF→horizonte (evaluado de verdad), la
//      deducción de lado, el atajo, y que el cartel use los NOMBRES REALES
//      de los campos de `elegido` (guarda contra claves inventadas).
//   C) HONESTIDAD del cartel GEX: "BS real" → "OPRA nativa".
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
process.env.ALPACA_KEY_ID = process.env.ALPACA_KEY_ID || 'TEST_KEY';
process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || 'TEST_SECRET';
const L = require('./options_live');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

const SPOT = 100;
const d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const EXP_10 = d(10), EXP_17 = d(17);

// ── Alpaca simulado ─────────────────────────────────────────────────
// opts.junk=true agrega strikes con OI pero SIN snapshot ni close_price
// → esos contratos entran a la cadena con src=null (ilíquidos sin griegas),
//   que es exactamente lo que inflaba chain.length y ensuciaba la etiqueta.
// opts.spreadHalf ensancha el spread para forzar el caso "nada pasa".
function hacerAlpaca(opts = {}) {
  const contratos = [], snaps = {};
  const strikes = [92, 96, 100, 104, 108];
  const deltas = { call: { 92: 0.80, 96: 0.62, 100: 0.50, 104: 0.34, 108: 0.19 },
                   put:  { 92: -0.20, 96: -0.35, 100: -0.50, 104: -0.66, 108: -0.81 } };
  for (const exp of [EXP_10, EXP_17]) {
    for (const ty of ['call', 'put']) {
      for (const k of strikes) {
        const sym = `${ty[0].toUpperCase()}${k}_${exp.slice(5)}`;
        contratos.push({ symbol: sym, strike_price: String(k), type: ty,
          open_interest: '4000', close_price: '2', expiration_date: exp });
        const half = opts.spreadHalf != null ? opts.spreadHalf : 0.02;
        snaps[sym] = {
          greeks: { delta: deltas[ty][k], gamma: 0.03, theta: -0.05, vega: 0.10, rho: 0.01 },
          impliedVolatility: 0.25,
          latestQuote: { bp: +(2 - half).toFixed(2), ap: +(2 + half).toFixed(2) },
        };
      }
      if (opts.junk) {
        // ilíquidos: OI real pero SIN snapshot y SIN close_price → src=null en la cadena
        for (const k of [50, 60, 150, 160]) {
          const sym = `${ty[0].toUpperCase()}${k}_${exp.slice(5)}J`;
          contratos.push({ symbol: sym, strike_price: String(k), type: ty,
            open_interest: '3', close_price: '0', expiration_date: exp });
          // a propósito NO se crea snaps[sym]
        }
      }
    }
  }
  const fake = async (url) => {
    if (url.includes('/trades/latest')) return { status: 200, json: async () => ({ trade: { p: SPOT } }) };
    if (url.includes('/options/contracts')) {
      const m = url.match(/[?&]type=(call|put)/);
      let lista = m ? contratos.filter(c => c.type === m[1]) : contratos;
      const gte = (url.match(/expiration_date_gte=([\d-]+)/) || [])[1];
      const lte = (url.match(/expiration_date_lte=([\d-]+)/) || [])[1];
      lista = lista.filter(c => (!gte || c.expiration_date >= gte) && (!lte || c.expiration_date <= lte));
      return { status: 200, json: async () => ({ option_contracts: lista }) };
    }
    if (url.includes('/options/snapshots')) {
      const pedidos = decodeURIComponent((url.match(/symbols=([^&]+)/) || [])[1] || '').split(',');
      const out = {}; for (const s of pedidos) if (snaps[s]) out[s] = snaps[s];
      return { status: 200, json: async () => ({ snapshots: out }) };
    }
    return { status: 404, json: async () => ({}) };
  };
  return fake;
}

(async () => {
  console.log('\n── A) FIX fuente_gamma (candidatos, no cadena cruda) ──');

  // A1: cadena CON basura src=null pero pick 100% OPRA → 'OPRA nativa' (bug s71 muerto)
  L._CACHE.clear();
  const r1 = await L.getContractPick('TST', { side: 'call', horizon: 'swing', fresh: true }, hacerAlpaca({ junk: true }));
  ok('A1 pick OK con cadena ensuciada', r1.ok === true, JSON.stringify(r1.error || r1.motivo));
  ok('A1 fuente_gamma = "OPRA nativa" (no "mixta")', r1.fuente_gamma === 'OPRA nativa', r1.fuente_gamma);
  const candSrc = [r1.elegido, ...(r1.alternativas || [])].map(c => c.src);
  ok('A1 todos los candidatos son src=opra', candSrc.every(s => s === 'opra'), candSrc.join(','));

  // A2: TESTIGO — la fórmula VIEJA (nat===chain.length) habría dado 'mixta' sobre la misma cobertura
  const natRaw = r1.cobertura.con_griegas_opra, chainLen = r1.cobertura.contratos;
  const etiquetaVieja = (natRaw === chainLen && natRaw > 0) ? 'OPRA nativa' : (natRaw > 0 ? 'mixta' : 'sin griegas');
  ok('A2 hay basura en la cadena (con_opra < contratos)', natRaw < chainLen, natRaw + '/' + chainLen);
  ok('A2 la fórmula vieja habría dicho "mixta" (bug reproducido y enterrado)', etiquetaVieja === 'mixta', etiquetaVieja);

  // A3: cobertura.con_griegas_opra sigue siendo el conteo crudo (no se rompió ese stat)
  ok('A3 con_griegas_opra sigue contando sobre la cadena cruda', typeof natRaw === 'number' && natRaw > 0, String(natRaw));

  // A4: SIN basura → coincide de todos modos en 'OPRA nativa'
  L._CACHE.clear();
  const r4 = await L.getContractPick('TST', { side: 'put', horizon: 'swing', fresh: true }, hacerAlpaca({ junk: false }));
  ok('A4 sin basura, put, sigue "OPRA nativa"', r4.ok && r4.fuente_gamma === 'OPRA nativa', r4.fuente_gamma);

  // A5: NADA pasa los filtros (spread gigante) pero había griegas OPRA → fallback de cadena = 'OPRA nativa'
  L._CACHE.clear();
  const r5 = await L.getContractPick('TST', { side: 'call', horizon: 'swing', maxSpreadPct: 0.001, fresh: true }, hacerAlpaca({ spreadHalf: 0.5 }));
  ok('A5 con spread imposible no hay pick (ok:false)', r5.ok === false, JSON.stringify(r5.elegido));
  ok('A5 sin candidatos, describe la cadena → "OPRA nativa" (había griegas OPRA)', r5.fuente_gamma === 'OPRA nativa', r5.fuente_gamma);
  ok('A5 descartes.spread mordió', r5.descartes && r5.descartes.spread > 0, JSON.stringify(r5.descartes));

  // ── B) COMANDO /contrato en el HTML del mapa (estructural sobre el real) ──
  console.log('\n── B) comando /contrato en el HTML ──');
  const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');

  ok('B1 CONTRATO_URL derivada del proxy (/alpaca → /alpaca-contrato)',
    /const CONTRATO_URL\s*=\s*POLY_PROXY\.replace\('\/alpaca',\s*'\/alpaca-contrato'\)/.test(html));
  ok('B2 función contratoDiag definida y expuesta en window',
    /async function contratoDiag\(/.test(html) && /window\.contratoDiag\s*=\s*contratoDiag/.test(html));

  // B3: comando cableado en addSymbol, con las dos formas y el parseo de args
  ok('B3 comando /CONTRATO y alias /CONT cableados',
    /s==='\/CONTRATO'\|\|s\.startsWith\('\/CONTRATO '\)\|\|s==='\/CONT'\|\|s\.startsWith\('\/CONT '\)/.test(html));
  ok('B3 llama a contratoDiag(sideOv, horOv)', /contratoDiag\(sideOv,\s*horOv\)/.test(html));
  for (const [tok, val] of [['CALL', "sideOv='call'"], ['PUT', "sideOv='put'"], ['SCALP', "horOv='scalp'"], ['SWING', "horOv='swing'"], ['POSITION', "horOv='position'"]]) {
    ok('B3 token ' + tok + ' → ' + val, html.includes("t==='" + tok + "'") && html.includes(val), 'no mapea');
  }

  // B4: mapeo TF→horizonte EVALUADO DE VERDAD (extrae la función del HTML)
  const mTf = html.match(/function tfToHorizon\(t\)\{[^}]*\}/);
  ok('B4 tfToHorizon presente en el HTML', !!mTf);
  if (mTf) {
    const tfToHorizon = new Function('return (' + mTf[0].replace('function tfToHorizon', 'function') + ')')();
    ok('B4 5m → scalp', tfToHorizon('5') === 'scalp', tfToHorizon('5'));
    ok('B4 15m → scalp', tfToHorizon('15') === 'scalp', tfToHorizon('15'));
    ok('B4 1H → swing', tfToHorizon('60') === 'swing', tfToHorizon('60'));
    ok('B4 4H → swing', tfToHorizon('240') === 'swing', tfToHorizon('240'));
    ok('B4 D → position', tfToHorizon('D') === 'position', tfToHorizon('D'));
  }

  // B5: deducción de lado desde el titular de la señal + NEUTRAL pide el lado a mano
  ok('B5 BUY→call / SELL→put deducido de computeNeuralScore',
    /computeNeuralScore\(p\)/.test(html) && /sig\.type==='BUY'\s*\?\s*'call'\s*:\s*sig\.type==='SELL'\s*\?\s*'put'/.test(html));
  ok('B5 NEUTRAL pide el lado a mano (no adivina)',
    /NEUTRAL/.test(html) && /\/contrato call\b/.test(html) && /\/contrato put\b/.test(html));

  // B6: el cartel usa los NOMBRES REALES de los campos de `elegido` (guarda anti-clave-inventada)
  for (const campo of ['e.symbol', 'e.type', 'e.strike', 'e.expiration', 'e.dte', 'e.delta',
                       'e.spreadPct', 'e.oi', 'e.mid', 'e.bid', 'e.ask', 'e.thetaPctDia', 'e.breakevenMov', 'e.iv', 'e.src']) {
    ok('B6 cartel usa ' + campo, html.includes(campo), 'ausente');
  }
  ok('B6 lee alternativas / cobertura / fuente_gamma / criterio.targetDelta del resultado',
    /j\.alternativas/.test(html) && /j\.cobertura/.test(html) && /j\.fuente_gamma/.test(html) && /criterio.*targetDelta/.test(html));
  ok('B6 en ok:false muestra los descartes (por qué se cayó cada contrato)',
    /j\.descartes/.test(html) && /descartes:/.test(html));

  // B7: atajo de teclado y fetch a la ruta con los 3 params
  ok('B7 atajo Ctrl+Shift+K → contratoDiag()',
    /ctrlKey && e\.shiftKey && \(e\.key==='K'\|\|e\.key==='k'\)[\s\S]*?contratoDiag\(\)/.test(html));
  ok('B7 fetch a CONTRATO_URL con ?sym=&side=&horizon=',
    /\$\{CONTRATO_URL\}\?sym=\$\{encodeURIComponent\(sym\)\}&side=\$\{side\}&horizon=\$\{horizon\}/.test(html));

  // ── C) HONESTIDAD del cartel GEX ──
  console.log('\n── C) cartel GEX: BS → OPRA nativa ──');
  ok('C1 ya NO dice "OPCIONES (BS real)"', !html.includes('OPCIONES (BS real)'));
  ok('C1 ya NO comenta "(BS, /alpaca-options-metrics)"', !html.includes('(BS, /alpaca-options-metrics)'));
  ok('C2 dice "OPCIONES (OPRA nativa)" en el panel', html.includes('OPCIONES (OPRA nativa)'));
  ok('C2 comenta "griegas OPRA nativas" en el bloque GEX', html.includes('griegas OPRA nativas, /alpaca-options-metrics'));

  console.log(`\n${fail === 0 ? '✅' : '❌'} bench_contrato_ui: ${pass}/${pass + fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
