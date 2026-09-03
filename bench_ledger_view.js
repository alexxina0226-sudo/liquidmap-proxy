// bench_ledger_view.js — juez de ledger_view.buildLedgerView (pestaña 📒 del mapa).
// Verifica que el payload de la pestaña sea FIEL a las agregaciones del ledger:
//  (a) dedup (Idempotent Reader) — señal parada re-emitida cuenta UNA
//  (b) scorecard global (n, wins, losses, hitRate, expectativa, MFE/MAE)
//  (c) juez por clase — swing/day/scalp con SU vara (no la binaria)
//  (d) bloques por ticker — stats propios + señales (ACTIVA aparte, no en stats)
//  (e) cortes por setup/semáforo/horizonte (sin el grupo '—')
//  (f) guardas: vacío / null → payload honesto en cero
const { buildLedgerView } = require('./ledger_view.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '\u2713' : '\u2717') + ' ' + n); };
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e == null ? 0.01 : e);

// ── registros sintéticos (con un DUPLICADO físico como en el gist real) ──
const RECS = [
  // SPY swing BUY CHoCH — CUMPLIDA TP1 (swing ganó)
  { id:'SPY|4H|1000', ts:1000, sym:'SPY', tf:'4H', type:'BUY', setup:'CHoCH', grade:'FUERTE', horizon:'swing',
    entry:100, sl:98, tp:[102,105,110], status:'CUMPLIDA', hitTP:1, rMultiple:1, mfeR:1.2, maeR:-0.3, barsToResolve:5 },
  // SPY — DUPLICADO de la anterior (misma clave: sym·tf·dir·setup·entry·sl), ACTIVA → debe colapsar
  { id:'SPY|4H|1005', ts:1005, sym:'SPY', tf:'4H', type:'BUY', setup:'CHoCH', grade:'FUERTE', horizon:'swing',
    entry:100, sl:98, tp:[102,105,110], status:'ACTIVA' },
  // NVDA day SELL BOS — FALLIDA sin TP, MFE 0.2 (day 'no')
  { id:'NVDA|4H|1010', ts:1010, sym:'NVDA', tf:'4H', type:'SELL', setup:'BOS', grade:'DÉBIL', horizon:'day',
    entry:200, sl:204, tp:[196,193,188], status:'FALLIDA', hitTP:0, rMultiple:-1, mfeR:0.2, maeR:-1, barsToResolve:1 },
  // NVDA scalp SELL BOS (entry/sl distintos → NO colapsa) — FALLIDA binaria pero MFE 1.3 (scalp GANÓ)
  { id:'NVDA|4H|1020', ts:1020, sym:'NVDA', tf:'4H', type:'SELL', setup:'BOS', grade:'FUERTE', horizon:'scalp',
    entry:210, sl:213, tp:[207,204,199], status:'FALLIDA', hitTP:0, rMultiple:-1, mfeR:1.3, maeR:-1, barsToResolve:2 },
  // TSLA swing BUY CHoCH — EXPIRADA, MFE 0.3 (swing 'no')
  { id:'TSLA|4H|1030', ts:1030, sym:'TSLA', tf:'4H', type:'BUY', setup:'CHoCH', grade:'DÉBIL', horizon:'swing',
    entry:300, sl:294, tp:[306,315,330], status:'EXPIRADA', hitTP:0, rMultiple:-0.2, mfeR:0.3, maeR:-0.4, barsToResolve:null },
  // TSLA swing BUY CHoCH — ACTIVA (entry distinto → instancia viva propia)
  { id:'TSLA|4H|1040', ts:1040, sym:'TSLA', tf:'4H', type:'BUY', setup:'CHoCH', grade:'FUERTE', horizon:'swing',
    entry:305, sl:299, tp:[311,320,335], status:'ACTIVA' },
  // AAPL swing SELL BOS — CUMPLIDA TP2 (swing ganó, no pleno: pleno swing = TP3)
  { id:'AAPL|4H|1050', ts:1050, sym:'AAPL', tf:'4H', type:'SELL', setup:'BOS', grade:'FUERTE', horizon:'swing',
    entry:250, sl:255, tp:[245,240,230], status:'CUMPLIDA', hitTP:2, rMultiple:2.5, mfeR:2.6, maeR:-0.2, barsToResolve:8 },
];

const v = buildLedgerView(RECS);

// (a) DEDUP
ok('counts.raw = 7 (crudos, con el duplicado físico)', v.counts.raw === 7);
ok('counts.unique = 6 (el SPY duplicado colapsó)', v.counts.unique === 6);
ok('counts.resolved = 5 · active = 1', v.counts.resolved === 5 && v.counts.active === 1);

// (b) SCORECARD GLOBAL
ok('overall.n = 5 (resueltas, ACTIVA no cuenta)', v.overall.n === 5);
ok('overall.wins = 2 · losses = 2 · expired = 1', v.overall.wins === 2 && v.overall.losses === 2 && v.overall.expired === 1);
ok('overall.hitRate = 0.5 (2 de 4 decididas)', near(v.overall.hitRate, 0.5));
ok('overall.expectancyR ≈ +0.26R', near(v.overall.expectancyR, 0.26, 0.005));
ok('overall.avgMfeR usa las 5 resueltas', v.overall.nMfe === 5 && v.overall.avgMfeR != null);
ok('overall.avgMaeR presente (≤ 0)', v.overall.avgMaeR != null && v.overall.avgMaeR <= 0);

// (c) JUEZ POR CLASE
const cls = {}; v.byClass.forEach(c => cls[c.clase] = c);
ok('swing: ganó 2 (TP1 + TP2), no 1 (expirada)', cls.swing && cls.swing.gano === 2 && cls.swing.no === 1);
ok('swing: hitRateClase ≈ 0.667 (2 de 3)', cls.swing && near(cls.swing.hitRateClase, 0.667, 0.01));
ok('swing: pendiente 1 (la ACTIVA no decide)', cls.swing && cls.swing.pend === 1);
ok('scalp: ganó 1 por MFE (FALLIDA binaria reencuadrada)', cls.scalp && cls.scalp.gano === 1 && cls.scalp.no === 0);
ok('day: no 1 (FALLIDA sin excursión)', cls.day && cls.day.gano === 0 && cls.day.no === 1);
ok('byClass ordenado scalp→day→swing', v.byClass.map(c => c.clase).join(',') === 'scalp,day,swing');

// (d) BLOQUES POR TICKER
const bySym = {}; v.tickers.forEach(t => bySym[t.sym] = t);
ok('4 tickers (SPY, NVDA, TSLA, AAPL)', v.tickers.length === 4);
ok('NVDA: n 2, losses 2, sin activas', bySym.NVDA.n === 2 && bySym.NVDA.losses === 2 && bySym.NVDA.active === 0);
ok('TSLA: active 1, stats n 1 (la ACTIVA no entra a stats)', bySym.TSLA.active === 1 && bySym.TSLA.n === 1);
ok('TSLA: 2 señales listadas (resuelta + en curso)', bySym.TSLA.signals.length === 2);
ok('TSLA: la ACTIVA va primera en la lista', bySym.TSLA.signals[0].status === 'ACTIVA');
ok('SPY: 1 señal (el duplicado no aparece dos veces)', bySym.SPY.signals.length === 1 && bySym.SPY.wins === 1);
ok('orden por movimiento: NVDA primero (n+act mayor, más señales)', v.tickers[0].sym === 'NVDA');
ok('cada señal expone status/rMultiple/mfeR', bySym.AAPL.signals[0].rMultiple === 2.5 && bySym.AAPL.signals[0].hitTP === 2);

// (e) CORTES
const setups = v.bySetup.map(x => x.k);
ok('bySetup tiene CHoCH y BOS, sin "—"', setups.includes('CHoCH') && setups.includes('BOS') && !setups.includes('—'));
ok('byGrade tiene FUERTE y DÉBIL', v.byGrade.map(x => x.k).sort().join(',') === 'DÉBIL,FUERTE');
ok('byHorizon tiene swing/day/scalp', v.byHorizon.map(x => x.k).sort().join(',') === 'day,scalp,swing');
ok('bySetup ordenado por expectativa desc', v.bySetup.every((x, i, a) => i === 0 || (a[i-1].expectancyR ?? -99) >= (x.expectancyR ?? -99)));

// (f) GUARDAS
const e1 = buildLedgerView([]);
ok('vacío → ok, counts en 0, tickers []', e1.ok && e1.counts.unique === 0 && e1.overall.n === 0 && e1.tickers.length === 0);
const e2 = buildLedgerView(null);
ok('null → no tira, payload honesto', e2.ok && e2.counts.raw === 0);
const e3 = buildLedgerView([{ junk:true }, null, 5, { sym:'X', ts:1, type:'BUY', setup:'BOS', horizon:'day', entry:10, sl:9, tp:[11], status:'CUMPLIDA', hitTP:1, rMultiple:1, mfeR:1, maeR:0 }]);
ok('mezcla con basura → filtra y no rompe (1 ticker)', e3.ok && e3.tickers.length === 1 && e3.tickers[0].sym === 'X');

console.log('\nRESULTADO: ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
