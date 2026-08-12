// bench_prints_monitor.js — BANCO del PASO 4A (dark pool/prints real → monitor).
// -----------------------------------------------------------------------------
// Dos frentes, SOBRE CÓDIGO REAL (no copias):
//  (A) prints.js PURO (dedup + filtro >$1M + tag off-exchange + resumen) — se
//      requiere directo (módulo sin dependencias de red).
//  (B) interpretFlow + fmtMoney EXTRAÍDOS del monitor por llaves balanceadas
//      (mismo patrón que bench_honestidad_bolsa) y evaluados con el default
//      PRINTS_MIN_NOTIONAL=1e6. Testea la MATRIZ de la clase con los 6 ejemplos
//      reales (AAPL/SPY/AMZN/BABA/MSFT) + bordes. display-only: NO toca score.
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./prints.js');

let pass = 0, fail = 0;
const ok  = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, '  ← FALLA'); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// ── Extractor por llaves balanceadas: saca `function NAME(...) {...}` del fuente ──
function extractFn(src, name) {
  const sig = 'function ' + name + '(';
  const i = src.indexOf(sig);
  if (i < 0) throw new Error('no encontré ' + name);
  const b = src.indexOf('{', i);
  let depth = 0, j = b;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

const monSrc = fs.readFileSync(path.join(__dirname, 'monitor_bolsa_v1.js'), 'utf8');
const fmtMoneySrc     = extractFn(monSrc, 'fmtMoney');
const interpretFlowSrc = extractFn(monSrc, 'interpretFlow');
const cvdViewSrc       = extractFn(monSrc, 'cvdView');
const cvdSignalsSrc    = extractFn(monSrc, 'cvdSignals');
// Scope real: PRINTS_MIN_NOTIONAL default (1e6) + fmtMoney visible a interpretFlow.
const factory = new Function('PRINTS_MIN_NOTIONAL',
  `${fmtMoneySrc}\n${interpretFlowSrc}\n${cvdViewSrc}\n${cvdSignalsSrc}\n return { fmtMoney, interpretFlow, cvdView, cvdSignals };`);
const { fmtMoney, interpretFlow, cvdView, cvdSignals } = factory(1e6);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n── (A) prints.js PURO — tubería dark pool ──');

// A1 — DEDUP: el doble-reporte del opening cross (mismo ts/price/size/exchange,
// conditions 'O' vs 'Q') colapsa a 1 y une las conditions. (bug real cazado en vivo)
{
  const t = [
    { ts: 1000, price: 600, size: 200000, exchange: 'D', conditions: ['O'] },   // $120M
    { ts: 1000, price: 600, size: 200000, exchange: 'D', conditions: ['Q'] },   // MISMO trade físico
  ];
  const d = P.dedupTrades(t);
  ok('A1 dedup colapsa doble-reporte a 1', d.length === 1);
  ok('A1 dedup une conditions (O+Q)', d[0].conditions.includes('O') && d[0].conditions.includes('Q'));
  const sum = P.summarizePrints(P.filterLargePrints(t, 1e6), 20);
  ok('A1 total NO se infla (1×$120M, no 2×)', near(sum.totalNotional, 120e6));
}

// A2 — FILTRO >$1M + orden desc + tag off-exchange ('D') + auction.
{
  const t = [
    { ts: 1, price: 100, size: 5000,  exchange: 'D', conditions: null },        // $0.5M → fuera
    { ts: 2, price: 100, size: 60000, exchange: 'D', conditions: null },        // $6M off-exch
    { ts: 3, price: 100, size: 458000, exchange: 'N', conditions: null },       // $45.8M on-exch (ballena)
    { ts: 4, price: 100, size: 20000, exchange: 'N', conditions: ['M'] },       // $2M auction (closing)
  ];
  const large = P.filterLargePrints(t, 1e6);
  ok('A2 descarta el <$1M', large.length === 3);
  ok('A2 orden desc por notional (ballena primero)', large[0].notional === 45.8e6);
  const off = large.find(p => p.notional === 6e6);
  ok('A2 tag offExchange en "D"', off.offExchange === true);
  ok('A2 NO offExchange en "N"', large.find(p => p.notional === 45.8e6).offExchange === false);
  ok('A2 tag auction en condition "M"', large.find(p => p.notional === 2e6).auction === true);
}

// A3 — RESUMEN: count, máx, offExchangePct = off$/total, auctionCount.
{
  const t = [
    { ts: 1, price: 100, size: 900000, exchange: 'D', conditions: null },       // $90M off
    { ts: 2, price: 100, size: 100000, exchange: 'N', conditions: null },       // $10M on
  ];
  const s = P.summarizePrints(P.filterLargePrints(t, 1e6), 20);
  ok('A3 count = 2', s.count === 2);
  ok('A3 maxNotional = $90M', near(s.maxNotional, 90e6));
  ok('A3 totalNotional = $100M', near(s.totalNotional, 100e6));
  ok('A3 offExchangePct = 0.90 (90/100)', near(s.offExchangePct, 0.9));
  ok('A3 offExchangeNotional = $90M', near(s.offExchangeNotional, 90e6));
}

// A4 — BASURA (price/size <=0 o no numérico) descartada; sin dato no inventa.
{
  const t = [
    { ts: 1, price: -5, size: 100000, exchange: 'D' },
    { ts: 2, price: 100, size: 0, exchange: 'D' },
    { ts: 3, price: 'x', size: 100000, exchange: 'D' },
  ];
  ok('A4 basura fuera (0 prints válidos)', P.filterLargePrints(t, 1e6).length === 0);
  const s = P.summarizePrints([], 20);
  ok('A4 resumen vacío: pct 0, count 0', s.count === 0 && s.offExchangePct === 0);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n── (B) fmtMoney — $ humano ──');
ok('B fmt $45.8M', fmtMoney(45.8e6) === '$45.8M');
ok('B fmt $274.3M', fmtMoney(274.3e6) === '$274.3M');
ok('B fmt $920k', fmtMoney(920000) === '$920k');
ok('B fmt $1.2B', fmtMoney(1.2e9) === '$1.2B');
ok('B fmt $0', fmtMoney(0) === '$0');
ok('B fmt no-numérico → $0', fmtMoney(NaN) === '$0');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n── (C) interpretFlow — LA MATRIZ (6 ejemplos reales de la clase) ──');
// Helpers para armar entradas realistas.
const prints = (o) => Object.assign({ hadData: true, count: 1, nTrades: 100, maxNotional: 5e6,
  offExchangePct: 0.5, offExchangeNotional: 5e6, auctionCount: 0, partial: false }, o);
const cvd = (cvdVal, buyPct) => ({ cvd: cvdVal, buyPct });
const struct = (dir) => dir ? ({ type: dir === 'BUY' ? 'BOS_BUY' : 'CHOCH_SELL' }) : null;

// C1 — AAPL 4H: dark 91% + CVD venta (−, 46%) + estructura ▼ → DISTRIBUCIÓN.
{
  const f = interpretFlow(prints({ count: 76, maxNotional: 45.8e6, offExchangePct: 0.91, offExchangeNotional: 274.3e6 }),
                          cvd(-52600, 46), struct('SELL'));
  ok('C1 AAPL 4H → DISTRIBUCIÓN', /DISTRIBUCIÓN/.test(f.read));
  ok('C1 panel muestra máx $45.8M', /máx \$45\.8M/.test(f.panel));
  ok('C1 panel muestra dark 91%', /Dark Pool: 91%/.test(f.panel));
}

// C2 — SPY 15m: dark 59% + CVD compra (+, 52%) + BOS alcista → ACUMULACIÓN.
{
  const f = interpretFlow(prints({ count: 92, maxNotional: 9.7e6, offExchangePct: 0.59, offExchangeNotional: 113.1e6 }),
                          cvd(14400, 52), struct('BUY'));
  ok('C2 SPY 15m → ACUMULACIÓN', /ACUMULACIÓN/.test(f.read));
}

// C3 — AMZN 15m: dark 71% + CVD venta − pero SIN estructura → falta estructura.
{
  const f = interpretFlow(prints({ count: 42, maxNotional: 5.5e6, offExchangePct: 0.71, offExchangeNotional: 53.3e6 }),
                          cvd(-42300, 47), null);
  ok('C3 AMZN 15m → dirección no confirmada (falta estructura)', /no confirmada.*falta estructura/.test(f.read));
  ok('C3 AMZN NO canta distribución', !/DISTRIBUCIÓN/.test(f.read));
}

// C4 — BABA 15m: dark 21% (moderado) + CVD casi neutro − + estructura sweep ▼.
//      La clase lo dejó en ESPERAR — NO distribución (dark no alcanza). → tentativo.
{
  const f = interpretFlow(prints({ count: 2, maxNotional: 5.8e6, offExchangePct: 0.21, offExchangeNotional: 1.5e6 }),
                          cvd(-4700, 48), struct('SELL'));
  ok('C4 BABA 21% NO canta DISTRIBUCIÓN (fidelidad clase)', !/DISTRIBUCIÓN/.test(f.read));
  ok('C4 BABA → flujo moderado / tentativo', /moderado/.test(f.read));
}

// C5 — MSFT 15m: dark/prints EN BLANCO (nadie grande) → poco peso institucional.
{
  const f1 = interpretFlow(prints({ hadData: true, count: 0, nTrades: 400 }), cvd(-17600, 47), struct('SELL'));
  ok('C5 MSFT (0 bloques, con trades) → poco peso institucional', f1 && /poco peso institucional/.test(f1.read));
  const f2 = interpretFlow(null, cvd(-17600, 47), struct('SELL'));
  ok('C5 sin dato alguno → panel omitido (null)', f2 === null);
}

// C6 — REVERSIÓN: dark alto (68%) + CVD venta − CONTRA estructura alcista ▲.
{
  const f = interpretFlow(prints({ count: 30, offExchangePct: 0.68, offExchangeNotional: 80e6 }),
                          cvd(-30000, 45), struct('BUY'));
  ok('C6 dark alto + flujo contra estructura → REVERSIÓN', /REVERSIÓN/.test(f.read));
}

// C7 — BORDES de umbral: <15 poco respaldo · 30 justo entra a "alto".
{
  const bajo = interpretFlow(prints({ count: 5, offExchangePct: 0.12 }), cvd(-1, 47), struct('SELL'));
  ok('C7 dark 12% (<15) → poco respaldo (bajo)', /poco respaldo/.test(bajo.read));
  const alto30 = interpretFlow(prints({ count: 10, offExchangePct: 0.30 }), cvd(-1, 46), struct('SELL'));
  ok('C7 dark 30% justo → matriz fuerte (DISTRIBUCIÓN)', /DISTRIBUCIÓN/.test(alto30.read));
  const muyAlto = interpretFlow(prints({ count: 50, offExchangePct: 0.85 }), cvd(1, 60), struct('BUY'));
  ok('C7 dark 85% → "muy alto"', /muy alto/.test(muyAlto.read));
}

// C8 — display-only: interpretFlow NO expone nada de score/dirección de señal.
{
  const f = interpretFlow(prints({ offExchangePct: 0.9 }), cvd(-1, 46), struct('SELL'));
  const keys = Object.keys(f);
  ok('C8 solo devuelve {panel, read} (no toca score)', keys.length === 2 && keys.includes('panel') && keys.includes('read'));
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n── (D) cvdView — CVD REAL por agresor al panel (4B-A) ──');
// Velas para priceDir: sube (last>first) o baja.
const candlesUp   = [{c:100},{c:101},{c:102},{c:103},{c:104},{c:105},{c:106},{c:108}];
const candlesDown = [{c:108},{c:106},{c:105},{c:104},{c:103},{c:102},{c:101},{c:100}];
const estStub = { cvd: 5, buyPct: 55, bullish: false, bearish: false, divergence: false, priceDir:'up', cvdDir:'up' };

// D1 — real utilizable, compra real + precio sube → source real, bullish, buyPct 60.
{
  const v = cvdView({ cvdReal: true, buyV: 60000, sellV: 40000, cvd: 20000, partial: false }, estStub, candlesUp);
  ok('D1 source = real', v.source === 'real');
  ok('D1 buyPct = 60', near(v.buyPct, 60));
  ok('D1 bullish (cvd>0, buyPct>51, precio↑=cvd↑)', v.bullish === true && v.bearish === false);
}

// D2 — real utilizable, venta real + precio baja → bearish (caso AAPL real).
{
  const v = cvdView({ cvdReal: true, buyV: 40000, sellV: 60000, cvd: -20000, partial: false }, estStub, candlesDown);
  ok('D2 bearish (cvd<0, buyPct<49, precio↓=cvd↓)', v.bearish === true && v.bullish === false);
  ok('D2 buyPct = 40', near(v.buyPct, 40));
}

// D3 — real presente pero cvdReal=false (no hubo trades clasificados) → FALLBACK estimado.
{
  const v = cvdView({ cvdReal: false, buyV: 0, sellV: 0, cvd: 0 }, estStub, candlesUp);
  ok('D3 cvdReal=false → fallback estimado', v.source === 'estimated');
  ok('D3 fallback conserva el estimado (buyPct 55)', near(v.buyPct, 55));
}

// D4 — real null (módulo/feed caído) → FALLBACK estimado, idéntico a hoy.
{
  const v = cvdView(null, estStub, candlesUp);
  ok('D4 real null → fallback estimado', v.source === 'estimated' && v.cvd === 5);
}

// D5 — real con volumen 0 total → no utilizable → fallback.
{
  const v = cvdView({ cvdReal: true, buyV: 0, sellV: 0, cvd: 0 }, estStub, candlesUp);
  ok('D5 buyV+sellV=0 → fallback estimado', v.source === 'estimated');
}

// D6 — DIVERGENCIA real: precio SUBE pero CVD real NEGATIVO → divergence, no bullish.
{
  const v = cvdView({ cvdReal: true, buyV: 45000, sellV: 55000, cvd: -10000, partial: false }, estStub, candlesUp);
  ok('D6 divergencia real (precio↑ vs cvd↓)', v.divergence === true);
  ok('D6 NO bullish/bearish (priceDir≠cvdDir corta la regla)', v.bullish === false && v.bearish === false);
}

// D7 — partial (paginación cortada) pasa como flag, sigue siendo real.
{
  const v = cvdView({ cvdReal: true, buyV: 70000, sellV: 30000, cvd: 40000, partial: true }, estStub, candlesUp);
  ok('D7 partial → source real + partial:true', v.source === 'real' && v.partial === true);
}

// D8 — MISMA regla que calcCVD: bullish requiere cvd>0 && buyPct>51 && priceDir===cvdDir.
{
  // buyPct 50.5 (≤51) → NO bullish aunque cvd>0 y precio suba.
  const v = cvdView({ cvdReal: true, buyV: 50500, sellV: 49500, cvd: 1000, partial: false }, estStub, candlesUp);
  ok('D8 buyPct 50.5 (≤51) → NO bullish (regla idéntica a calcCVD)', v.bullish === false);
}

// D9 — INTEGRACIÓN: el read de la clase ahora corre sobre CVD REAL.
//      AAPL-like: dark 91% + CVD real venta + estructura ▼ → DISTRIBUCIÓN.
{
  const realCvd = cvdView({ cvdReal: true, buyV: 46000, sellV: 54000, cvd: -8000, partial: false }, estStub, candlesDown);
  const f = interpretFlow(prints({ count: 76, maxNotional: 45.8e6, offExchangePct: 0.91, offExchangeNotional: 274.3e6 }),
                          realCvd, struct('SELL'));
  ok('D9 read sobre CVD real → DISTRIBUCIÓN', /DISTRIBUCIÓN/.test(f.read));
  ok('D9 el CVD que alimentó el read es real', realCvd.source === 'real' && realCvd.bearish === true);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n── (E) prints.js — CONTINGENTES (7/V) + sanidad de precio (honestidad dark pool) ──');

// E1 — isContingent: 7 y V (solo o combinados) sí; subasta/blank no.
ok('E1 cond [7] → contingente', P.isContingent(['7']) === true);
ok('E1 cond [V] → contingente', P.isContingent([' ', 'V']) === true);
ok('E1 cond [7,V] → contingente', P.isContingent([' ', '7', 'V']) === true);
ok('E1 cond [O,Q] (subasta) → NO contingente', P.isContingent(['O', 'Q']) === false);
ok('E1 cond [" "] (regular) → NO contingente', P.isContingent([' ']) === false);

// E2 — el print ESPURIO real de SPY ($829, cond 7/V, off-exch D) queda EXCLUIDO del read.
{
  const spurio = { ts: 1, price: 829.0061, size: 330000, exchange: 'D', conditions: [' ', '7', 'V'] }; // $273.5M
  const large = P.filterLargePrints([spurio], 1e6);
  ok('E2 filterLargePrints taggea contingent:true', large[0].contingent === true);
  const s = P.summarizePrints(large, 20);
  ok('E2 excluido del dark pool (offExchangeNotional 0)', s.offExchangeNotional === 0);
  ok('E2 no cuenta como print limpio (count 0)', s.count === 0);
  ok('E2 reportado aparte (contingentCount 1)', s.contingentCount === 1);
  ok('E2 contingentNotional ≈ $273.5M', Math.abs(s.contingentNotional - 273572013) < 1);
  ok('E2 NO aparece en top limpio', s.top.length === 0);
}

// E3 — SPY-like: prints LIMPIOS a mercado + el contingente gigante → el dark pool NO se infla.
{
  const trades = [
    { ts: 1, price: 773.5, size: 8947, exchange: 'D', conditions: [' '] },              // $6.92M limpio off
    { ts: 2, price: 773.4, size: 7480, exchange: 'D', conditions: [' '] },              // $5.78M limpio off
    { ts: 3, price: 773.3, size: 6727, exchange: 'D', conditions: [' '] },              // $5.20M limpio off
    { ts: 4, price: 829.0061, size: 330000, exchange: 'D', conditions: [' ', '7', 'V'] }, // $273.5M CONTINGENTE
  ];
  const s = P.summarizePrints(P.filterLargePrints(trades, 1e6), 20);
  ok('E3 count = 3 limpios (el contingente afuera)', s.count === 3);
  ok('E3 offExchangePct = 1.0 sobre flujo LIMPIO (no diluido por el ruido)', near(s.offExchangePct, 1.0));
  ok('E3 maxNotional NO es el $273.5M trucho', s.maxNotional < 10e6);
  ok('E3 el contingente reportado aparte', near(s.contingentNotional, 273572013, 1));
}

// E4 — RED DE OUTLIER: un print NO-contingente pero con precio grosero (>10% de la mediana) sale;
//      uno cercano (<10%) se queda. (mediana de 3+ limpios = ~$773).
{
  const trades = [
    { ts: 1, price: 773, size: 7000, exchange: 'D', conditions: [' '] },   // $5.41M
    { ts: 2, price: 774, size: 7000, exchange: 'D', conditions: [' '] },   // $5.42M
    { ts: 3, price: 772, size: 7000, exchange: 'D', conditions: [' '] },   // $5.40M
    { ts: 4, price: 900, size: 7000, exchange: 'D', conditions: [' '] },   // $6.30M FAT-FINGER (+16%)
    { ts: 5, price: 800, size: 7000, exchange: 'D', conditions: [' '] },   // $5.60M cercano (+3.5%) OK
  ];
  const s = P.summarizePrints(P.filterLargePrints(trades, 1e6), 20);
  ok('E4 el fat-finger $900 (>10%) excluido como outlier', s.priceOutlierCount === 1);
  ok('E4 el $800 (<10%) NO se excluye', s.count === 4);
  ok('E4 outlier no es contingente', s.contingentCount === 0);
}

// E5 — RED CONSERVADORA: con <3 refs limpias no hay mediana confiable → NO excluye por precio.
{
  const trades = [
    { ts: 1, price: 773, size: 7000, exchange: 'D', conditions: [' '] },   // $5.41M
    { ts: 2, price: 900, size: 7000, exchange: 'D', conditions: [' '] },   // $6.30M — sin base, no se juzga
  ];
  const s = P.summarizePrints(P.filterLargePrints(trades, 1e6), 20);
  ok('E5 <3 refs → red de outlier DORMIDA (no excluye)', s.priceOutlierCount === 0 && s.count === 2);
}

// E6 — BACKWARD-COMPAT: input limpio (sin contingentes/outliers) da los MISMOS números de antes.
{
  const trades = [
    { ts: 1, price: 100, size: 900000, exchange: 'D', conditions: [' '] }, // $90M off
    { ts: 2, price: 100, size: 100000, exchange: 'N', conditions: [' '] }, // $10M on
    { ts: 3, price: 100, size: 90000,  exchange: 'D', conditions: [' '] }, // $9M off (3ra ref p/ mediana)
  ];
  const s = P.summarizePrints(P.filterLargePrints(trades, 1e6), 20);
  ok('E6 sin contingentes → excludedCount 0', s.excludedCount === 0);
  ok('E6 offExchangePct intacto (99/109)', near(s.offExchangePct, 99/109));
  ok('E6 count = 3 (nada excluido)', s.count === 3);
}

// E7 — la SUBASTA sigue tratada como antes (NO es contingente, NO se excluye del read).
{
  const trades = [
    { ts: 1, price: 774.61, size: 112233, exchange: 'P', conditions: [' ', 'O', 'Q'] }, // $86.9M auction lit
    { ts: 2, price: 773, size: 7000, exchange: 'D', conditions: [' '] },
    { ts: 3, price: 773, size: 8000, exchange: 'D', conditions: [' '] },
    { ts: 4, price: 773, size: 9000, exchange: 'D', conditions: [' '] },
  ];
  const s = P.summarizePrints(P.filterLargePrints(trades, 1e6), 20);
  ok('E7 subasta NO excluida (sigue en el read)', s.excludedCount === 0 && s.auctionCount === 1);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n── (F) cvdSignals — CAPA 3 pura (4B-B: el CVD real cambia el score) ──');
const sumW = (sigs, dir) => sigs.filter(s => s.dir === dir).reduce((a, s) => a + s.weight, 0);
// cvd helpers con la forma que consume la capa (bullish/bearish/divergence/priceDir/buyPct)
const CVD = (o) => Object.assign({ cvd:0, buyPct:50, bullish:false, bearish:false, divergence:false, priceDir:'up', cvdDir:'up' }, o);
const neutral1H = CVD({});

// F1 — bullish → voto BUY 1.5.
{
  const s = cvdSignals(CVD({ cvd:100, buyPct:60, bullish:true }), neutral1H);
  ok('F1 bullish → BUY 1.5', sumW(s, 'BUY') === 1.5 && sumW(s, 'SELL') === 0);
}
// F2 — bearish → voto SELL 1.5.
{
  const s = cvdSignals(CVD({ cvd:-100, buyPct:40, bearish:true }), neutral1H);
  ok('F2 bearish → SELL 1.5', sumW(s, 'SELL') === 1.5 && sumW(s, 'BUY') === 0);
}
// F3 — divergencia (precio↑, cvd no) → voto SELL 2.0.
{
  const s = cvdSignals(CVD({ divergence:true, priceDir:'up' }), neutral1H);
  ok('F3 divergencia precio↑ → SELL 2.0', sumW(s, 'SELL') === 2.0);
}
// F4 — confirmación 1H suma 0.5.
{
  const s = cvdSignals(CVD({ cvd:100, buyPct:60, bullish:true }), CVD({ bullish:true }));
  ok('F4 1H confirma alcista → BUY 2.0 (1.5+0.5)', sumW(s, 'BUY') === 2.0);
}
// F5 — neutro → sin votos.
{
  ok('F5 CVD neutro → 0 votos', cvdSignals(CVD({}), neutral1H).length === 0);
}
// F6 — EL NÚCLEO DE 4B-B: mismo precio/estructura, pero CVD real DISTINTO al estimado
//      produce votos DISTINTOS → cambia el score. Estimado bullish vs real bearish.
{
  const candlesDown = [{c:108},{c:106},{c:105},{c:104},{c:103},{c:102},{c:101},{c:100}];
  const est  = CVD({ cvd:50, buyPct:56, bullish:true });                                   // estimado dice compra
  const real = cvdView({ cvdReal:true, buyV:44000, sellV:56000, cvd:-12000, partial:false }, est, candlesDown); // real dice venta
  const sEst  = cvdSignals(est, neutral1H);
  const sReal = cvdSignals(real, neutral1H);
  ok('F6 estimado vota BUY', sumW(sEst, 'BUY') === 1.5 && sumW(sEst, 'SELL') === 0);
  ok('F6 real (override) vota SELL — el override cambia la CAPA 3', sumW(sReal, 'SELL') >= 1.5 && sumW(sReal, 'BUY') === 0);
  ok('F6 real es source real (confirmaría/suprimiría en el gate)', real.source === 'real' && real.bearish === true);
}
// F7 — REGRESIÓN: cvdSignals reproduce EXACTO los votos inline viejos (misma lógica).
{
  const s = cvdSignals(CVD({ cvd:100, buyPct:62, bullish:true, divergence:false }), neutral1H);
  ok('F7 label exacto del voto BUY 1.5', s[0].label === 'CVD 4H positivo — 62% compra institucional' && s[0].weight === 1.5 && s[0].layer === 3);
}

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\nRESULTADO: ${pass} ✓ · ${fail} ✗   ${fail === 0 ? '🏆 BANCO VERDE' : '❌ HAY FALLAS'}`);
process.exit(fail === 0 ? 0 : 1);
