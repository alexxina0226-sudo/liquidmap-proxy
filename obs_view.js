// obs_view.js — VISTA de lectura del LEDGER INTELIGENTE para la pestaña 🧠 del mapa.
// ---------------------------------------------------------------------------
// PURO (sin red, sin DOM, sin storage). Toma las OBSERVACIONES del ledger inteligente
// (ballena, dark pool, juez, sticker — lecturas con dirección implícita, NO trades) y
// arma el PAYLOAD del panel: scorecard global + POR TIPO de lectura + POR TIPO×DIRECCIÓN
// + BLOQUES POR TICKER con las obs recientes.
//
// La pregunta que responde (caso SNOW de Gonzalo): cuando el radar/mapa dice "ballena
// COMPRADORA", ¿el precio realmente sube en las próximas barras? La vara es FORWARD
// RETURN direccional (dirHit) + retorno firmado — NO R de trade.
//
// FIDELIDAD: reusa aggregateObs (obs_ledger) — la MISMA función que sella y mide las
// observaciones. La pestaña muestra exactamente lo que el cerebro ya calcula, no recalcula.
//
// Display-only: solo LEE y transforma. Excluye bad-prints residuales (misma red de
// seguridad que aggregateObs: |signedRetPct| > saneRetCapPct) del agregado y de las listas.
'use strict';

const { aggregateObs, DEFAULTS } = require('./obs_ledger.js');
const SANE = DEFAULTS.saneRetCapPct;   // tope de retorno firmado; arriba = bad-print residual

function _num(x){ return typeof x === 'number' && isFinite(x); }
function _round(x, d){ return _num(x) ? +x.toFixed(d == null ? 2 : d) : null; }
function _valid(r){ return r && typeof r === 'object' && r.kind && r.sym && r.status; }
function _sane(r){ return !(_num(r.signedRetPct) && Math.abs(r.signedRetPct) > SANE); }

// aggregateObs → array ordenado por n desc (luego por hitRate desc).
function _rows(agg){
  return Object.keys(agg || {})
    .map(k => Object.assign({ k }, agg[k]))
    .sort((a, b) => (b.n - a.n) || ((b.hitRate || 0) - (a.hitRate || 0)) || a.k.localeCompare(b.k));
}

// buildObsView(records) → payload para el panel 🧠 LECTURAS.
function buildObsView(records){
  const all = Array.isArray(records) ? records.filter(_valid) : [];
  const resolved     = all.filter(r => r.status === 'resolved');
  const resolvedSane = resolved.filter(_sane);
  const open         = all.filter(r => r.status === 'open');

  // ── scorecard global (¿nuestras lecturas son predictivas en promedio?) ──
  const ovAgg = aggregateObs(resolvedSane, () => 'ALL')['ALL'] || null;
  const overall = ovAgg ? {
    n: ovAgg.n, hits: ovAgg.hits,
    hitRate: ovAgg.hitRate, avgSignedRetPct: ovAgg.avgSignedRetPct, avgMfePct: ovAgg.avgMfePct
  } : { n: 0, hits: 0, hitRate: null, avgSignedRetPct: null, avgMfePct: null };

  // ── por TIPO de lectura (headline: ballena/darkpool/juez/sticker) ──
  const byKind = _rows(aggregateObs(resolvedSane, r => r.kind));

  // ── por TIPO × DIRECCIÓN (ballena↑ vs ballena↓ — el punto SNOW) ──
  const byKindDir = _rows(aggregateObs(resolvedSane, r => r.kind + '\u0000' + (r.dir || 'neutral')))
    .map(row => {
      const i = row.k.indexOf('\u0000');
      return Object.assign({ kind: row.k.slice(0, i), dir: row.k.slice(i + 1) }, row);
    });

  // ── bloques por ticker ──
  const symMap = {};
  for (const r of all) { (symMap[r.sym] = symMap[r.sym] || []).push(r); }
  const tickers = Object.keys(symMap).map(sym => {
    const recs = symMap[sym];
    const res  = recs.filter(r => r.status === 'resolved' && _sane(r));
    const ag   = aggregateObs(res, () => 'ALL')['ALL'] || null;
    const kinds = _rows(aggregateObs(res, r => r.kind));          // por tipo dentro del ticker
    const openN = recs.filter(r => r.status === 'open').length;
    const recent = res.slice()
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 12)
      .map(r => ({
        kind: r.kind, dir: r.dir, ts: r.ts, dirHit: !!r.dirHit,
        signedRetPct: _round(r.signedRetPct, 2), mfePct: _round(r.mfePct, 2),
        strength: _num(r.strength) ? r.strength : null
      }));
    return {
      sym, n: ag ? ag.n : 0, open: openN,
      hits: ag ? ag.hits : 0,
      hitRate: ag ? ag.hitRate : null, avgSignedRetPct: ag ? ag.avgSignedRetPct : null,
      kinds, recent
    };
  }).filter(t => t.n > 0 || t.open > 0)
    .sort((a, b) => (b.n + b.open) - (a.n + a.open) || (b.n - a.n) || a.sym.localeCompare(b.sym));

  return {
    ok: true,
    ts: Date.now(),
    counts: { raw: all.length, resolved: resolved.length, open: open.length, dropped: resolved.length - resolvedSane.length },
    overall, byKind, byKindDir, tickers
  };
}

module.exports = { buildObsView };
