// ledger_report.js — REPORTE del ledger: resumen SEMANAL de señales. FASE ledger, etapa 1b.
// ---------------------------------------------------------------------------
// PURO. Agrupa los registros resueltos por semana y arma el rollup (hit-rate,
// expectativa en R, cortes por setup / semáforo / horizonte) + un texto compacto
// estilo Telegram. Es el "resumen semanal de las señales" que pidió Gonzalo.
'use strict';
const { aggregate } = require('./ledger_core.js');
// Juez por clase: require FAIL-OPEN. Si el módulo falta, el resumen sale sin la
// línea por clase (comportamiento previo) — jamás rompe el /resumen que está vivo.
let aggregateByClass = null;
try { ({ aggregateByClass } = require('./ledger_class_judge.js')); } catch(_e){ aggregateByClass = null; }

// Clave de semana (lunes de la semana que contiene ms, en UTC) → 'YYYY-MM-DD'.
function weekKeyUTC(ms){
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7;               // 0=lunes .. 6=domingo
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return monday.toISOString().slice(0, 10);
}

// weeklySummary(records) → { [wk]: { week, overall, byGrade, bySetup, byHorizon } }
// Solo cuenta registros RESUELTOS (status != ACTIVA) y con ts.
function weeklySummary(records){
  const byWeek = {};
  for(const r of (records || [])){
    if(!r || r.status === 'ACTIVA' || r.ts == null) continue;
    const wk = weekKeyUTC(r.ts);
    (byWeek[wk] = byWeek[wk] || []).push(r);
  }
  const out = {};
  for(const wk in byWeek){
    const recs = byWeek[wk];
    const ov = aggregate(recs)['ALL'] || null;
    if(ov){
      const mfe = recs.map(r => r.mfeR).filter(x => typeof x === 'number' && isFinite(x));
      const mae = recs.map(r => r.maeR).filter(x => typeof x === 'number' && isFinite(x));
      ov.avgMfeR = mfe.length ? +(mfe.reduce((s,x)=>s+x,0)/mfe.length).toFixed(3) : null;
      ov.avgMaeR = mae.length ? +(mae.reduce((s,x)=>s+x,0)/mae.length).toFixed(3) : null;
      ov.nMfe = mfe.length;
    }
    out[wk] = {
      week: wk,
      overall: ov,
      byGrade: aggregate(recs, r => r.grade || '—'),
      bySetup: aggregate(recs, r => r.setup || '—'),
      byHorizon: aggregate(recs, r => r.horizon || '—'),
      byClass: aggregateByClass ? aggregateByClass(recs.map(r => ({ record: r, clase: r.horizon }))) : null
    };
  }
  return out;
}

// Helpers de formato honestos con nulls.
function pct(x){ return (x == null) ? '—' : Math.round(x * 100) + '%'; }
function rr(x){ return (x == null) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2) + 'R'; }

// Línea compacta por grupo: "BOS 62% (+1.40R, n8)"
function _lineByGroup(groups){
  const keys = Object.keys(groups).filter(k => k !== '—');
  if(!keys.length) return '—';
  return keys
    .sort((a, b) => (groups[b].expectancyR || -99) - (groups[a].expectancyR || -99))
    .map(k => `${k} ${pct(groups[k].hitRate)} (${rr(groups[k].expectancyR)}, n${groups[k].n})`)
    .join(' · ');
}

// Línea por clase con la VARA del juez: "swing 3G/5P/13N (HR 19%, MFE +0.40R, n21)".
// G=ganó · P=parcial · N=no (cada clase con su criterio, no la binaria TP/SL).
function _lineByClass(byClass){
  const order = { scalp: 0, day: 1, swing: 2 };
  const keys = Object.keys(byClass || {}).filter(k => k !== '—' && k !== 'indefinido');
  if(!keys.length) return '—';
  return keys
    .sort((a, b) => (order[a] != null ? order[a] : 9) - (order[b] != null ? order[b] : 9))
    .map(k => {
      const g = byClass[k];
      return `${k} ${g['ganó']}G/${g.parcial}P/${g.no}N (HR ${pct(g.hitRateClase)}, MFE ${rr(g.avgMfeR)}, n${g.n})`;
    })
    .join(' · ');
}

// Texto estilo Telegram de UNA semana.
function formatWeekly(weekObj){
  if(!weekObj || !weekObj.overall) return '📊 Semana ' + (weekObj && weekObj.week || '—') + ': sin señales resueltas.';
  const o = weekObj.overall;
  const L = [];
  L.push('📊 Resumen semanal · ' + weekObj.week);
  let head = `Señales resueltas: ${o.n} · Aciertos ${o.wins}/${o.wins + o.losses} (${pct(o.hitRate)}) · Expectativa ${rr(o.expectancyR)}`;
  if(o.avgMfeR != null) head += ` · MFE prom ${rr(o.avgMfeR)}` + (o.nMfe < o.n ? ` (n${o.nMfe})` : '');
  if(o.avgMaeR != null) head += ` · MAE prom ${rr(o.avgMaeR)}`;
  L.push(head);
  if(o.expired || o.invalid || o.ambiguo){
    L.push(`(expiradas ${o.expired} · invalidadas ${o.invalid} · ambiguas ${o.ambiguo})`);
  }
  L.push('Por setup: ' + _lineByGroup(weekObj.bySetup));
  L.push('Por semáforo: ' + _lineByGroup(weekObj.byGrade));
  L.push('Por horizonte: ' + _lineByGroup(weekObj.byHorizon));
  if(weekObj.byClass) L.push('Por clase (juez): ' + _lineByClass(weekObj.byClass));
  return L.join('\n');
}

// Texto de TODAS las semanas (más reciente primero).
function formatAll(summary){
  const wks = Object.keys(summary).sort().reverse();
  if(!wks.length) return '📊 Sin señales resueltas todavía.';
  return wks.map(wk => formatWeekly(summary[wk])).join('\n\n');
}

module.exports = { weekKeyUTC, weeklySummary, formatWeekly, formatAll };
