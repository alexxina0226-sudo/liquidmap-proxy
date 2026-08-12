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
// Scope real: PRINTS_MIN_NOTIONAL default (1e6) + fmtMoney visible a interpretFlow.
const factory = new Function('PRINTS_MIN_NOTIONAL',
  `${fmtMoneySrc}\n${interpretFlowSrc}\n${cvdViewSrc}\n return { fmtMoney, interpretFlow, cvdView };`);
const { fmtMoney, interpretFlow, cvdView } = factory(1e6);

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
console.log(`\n${'═'.repeat(60)}\nRESULTADO: ${pass} ✓ · ${fail} ✗   ${fail === 0 ? '🏆 BANCO VERDE' : '❌ HAY FALLAS'}`);
process.exit(fail === 0 ? 0 : 1);
