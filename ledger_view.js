// ledger_view.js — VISTA de lectura del LEDGER para la pestaña 📒 del mapa (Etapa 3).
// ---------------------------------------------------------------------------
// PURO (sin red, sin DOM, sin storage). Toma los registros crudos del ledger
// (tal cual salen del gist ledger_bolsa.jsonl) y arma el PAYLOAD que consume el
// panel del mapa: scorecard global + juez por clase + cortes (setup/semáforo/
// horizonte) + BLOQUES POR TICKER con sus señales.
//
// FIDELIDAD (por qué reusa y no recalcula): usa EXACTAMENTE las mismas funciones
// que el /resumen de Telegram — dedupeSignals + aggregate (ledger_core) y
// aggregateByClass (ledger_class_judge). Así la pestaña muestra los MISMOS números
// que el resumen semanal, imposible que diverjan (misma fuente de verdad).
//
// Display-only: NO toca emisor/gate/score/resolver/gist. Solo LEE y transforma.
'use strict';

const { aggregate, dedupeSignals } = require('./ledger_core.js');
// Juez por clase: require FAIL-OPEN (igual que ledger_report). Si falta el módulo,
// el payload sale sin la sección por clase — jamás rompe la lectura.
let aggregateByClass = null;
try { ({ aggregateByClass } = require('./ledger_class_judge.js')); } catch (_e) { aggregateByClass = null; }

function _num(x){ return (typeof x === 'number' && isFinite(x)) ? x : null; }
function _round(x, d){ const n = _num(x); return n == null ? null : +n.toFixed(d == null ? 2 : d); }
function _avg(a){ return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

// aggregate() → array de cortes ordenado por expectativa desc, sin el grupo '—'.
function _cuts(groups){
  return Object.keys(groups || {})
    .filter(k => k !== '—')
    .map(k => {
      const g = groups[k];
      return { k, n: g.n, wins: g.wins, losses: g.losses,
               hitRate: _round(g.hitRate, 4), expectancyR: _round(g.expectancyR, 3) };
    })
    .sort((a, b) => (b.expectancyR == null ? -99 : b.expectancyR) - (a.expectancyR == null ? -99 : a.expectancyR));
}

function _isActive(r){ return !r.status || r.status === 'ACTIVA'; }

function _tpArr(r){
  if (Array.isArray(r.tp)) return r.tp.map(_num);
  return [_num(r.tp1), _num(r.tp2), _num(r.tp3)];
}

// buildLedgerView(records) → payload para el panel del mapa.
// records: array crudo de registros del ledger (con duplicados físicos del gist).
function buildLedgerView(records){
  // Solo registros REALES del ledger (sym + status siempre los pone makeRecord). Una
  // línea basura del gist (sin sym/status) NO cuenta ni crea ticker fantasma; además
  // así aggregate() nunca infla n con status indefinido.
  const all = Array.isArray(records)
    ? records.filter(r => r && typeof r === 'object' && r.sym && r.status)
    : [];
  const deduped  = dedupeSignals(all);                                   // Idempotent Reader
  const resolved = deduped.filter(r => r.status && r.status !== 'ACTIVA');
  const active   = deduped.filter(_isActive);

  // ── scorecard global ──
  const ov = aggregate(deduped)['ALL'] || null;
  const mfe = resolved.map(r => r.mfeR).filter(x => typeof x === 'number' && isFinite(x));
  const mae = resolved.map(r => r.maeR).filter(x => typeof x === 'number' && isFinite(x));
  const overall = ov ? {
    n: ov.n, wins: ov.wins, losses: ov.losses,
    expired: ov.expired, invalid: ov.invalid, ambiguo: ov.ambiguo,
    hitRate: _round(ov.hitRate, 4), expectancyR: _round(ov.expectancyR, 3),
    avgMfeR: _round(_avg(mfe), 3), avgMaeR: _round(_avg(mae), 3), nMfe: mfe.length
  } : { n: 0, wins: 0, losses: 0, expired: 0, invalid: 0, ambiguo: 0,
        hitRate: null, expectancyR: null, avgMfeR: null, avgMaeR: null, nMfe: 0 };

  // ── cortes (mismas agregaciones que el resumen) ──
  const bySetup   = _cuts(aggregate(deduped, r => r.setup   || '—'));
  const byGrade   = _cuts(aggregate(deduped, r => r.grade   || '—'));
  const byHorizon = _cuts(aggregate(deduped, r => r.horizon || '—'));

  // ── juez por clase ──
  let byClass = [];
  if (aggregateByClass) {
    const bc = aggregateByClass(deduped.map(r => ({ record: r, clase: r.horizon })));
    const order = { scalp: 0, day: 1, swing: 2 };
    byClass = Object.keys(bc)
      .filter(k => k !== '—' && k !== 'indefinido')
      .sort((a, b) => (order[a] != null ? order[a] : 9) - (order[b] != null ? order[b] : 9))
      .map(k => {
        const g = bc[k];
        return { clase: k, n: g.n, gano: g['ganó'], pleno: g.pleno, parcial: g.parcial,
                 no: g.no, pend: g.pend, hitRateClase: _round(g.hitRateClase, 4),
                 avgMfeR: _round(g.avgMfeR, 3), avgMaeR: _round(g.avgMaeR, 3) };
      });
  }

  // ── bloques por ticker ──
  const bySym = {};
  for (const r of deduped) { const s = r.sym || '—'; (bySym[s] = bySym[s] || []).push(r); }
  const tickers = Object.keys(bySym).map(sym => {
    const recs = bySym[sym];
    const ag = aggregate(recs)['ALL'] || null;
    const act = recs.filter(_isActive).length;
    const signals = recs.slice()
      .sort((a, b) => {                                    // ACTIVA arriba, luego reciente primero
        const aa = _isActive(a) ? 1 : 0, bb = _isActive(b) ? 1 : 0;
        if (aa !== bb) return bb - aa;
        return (b.ts || 0) - (a.ts || 0);
      })
      .map(r => ({
        ts: r.ts, type: r.type, setup: r.setup, grade: r.grade, horizon: r.horizon,
        entry: _num(r.entry), sl: _num(r.sl), tp: _tpArr(r),
        status: r.status || 'ACTIVA', hitTP: r.hitTP || 0,
        rMultiple: _round(r.rMultiple, 2), mfeR: _round(r.mfeR, 2), maeR: _round(r.maeR, 2),
        barsToResolve: r.barsToResolve != null ? r.barsToResolve : null
      }));
    return {
      sym, n: ag ? ag.n : 0, active: act,
      wins: ag ? ag.wins : 0, losses: ag ? ag.losses : 0,
      hitRate: ag ? _round(ag.hitRate, 4) : null, expectancyR: ag ? _round(ag.expectancyR, 3) : null,
      signals
    };
  }).sort((a, b) => (b.n + b.active) - (a.n + a.active) || (b.n - a.n) || a.sym.localeCompare(b.sym));

  return {
    ok: true,
    ts: Date.now(),
    counts: { raw: all.length, unique: deduped.length, resolved: resolved.length, active: active.length },
    overall, bySetup, byGrade, byHorizon, byClass, tickers
  };
}

module.exports = { buildLedgerView };
