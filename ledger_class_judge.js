// ledger_class_judge.js — JUEZ POR CLASE del ledger. Arregla el 0/20 de raíz.
// ------------------------------------------------------------------------------------
// PURO (sin red, sin estado, sin DOM). Toma un registro YA RESUELTO por el resolver
// (status/hitTP/mfeR/maeR/rMultiple) + su CLASE (scalp/day/swing) y lo juzga con la VARA
// PROPIA de esa clase — no con la binaria TP-lejano vs SL-pegado que hacía ver 0/20.
//
// El PORQUÉ (reframe honesto que trajo Gonzalo): el resolver mide UNA cosa binaria —
// ¿tocó TP (3–7.5 ATR) o SL (~0.5 ATR) primero? Con esa vara casi todo da FALLIDA aunque
// la DIRECCIÓN se diera. Pero un SCALP no se juzga por TP3 en días: se juzga por si se
// movió ~1R a favor RÁPIDO. Un SWING sí corre a TP2-3. Cada clase, su bar. El MFE ya
// grabado (máx excursión favorable en R) es el juez del scalp; los TP tocados, el del
// day/swing. Así una señal "FALLIDA" por la binaria puede ser GANÓ o PARCIAL por su clase.
//
// Deriva de criterioExito() de signal_class.js — misma fuente de verdad, no se duplica.
'use strict';

const { criterioExito } = require('./signal_class.js');

// Piso de excursion favorable (en R) para conceder 'parcial' cuando NO se toco ningun TP.
// Debajo de esto, un MFE apenas positivo es RUIDO, no media victoria → 'no' honesto.
// Perilla (Gonzalo 10/08): 0.5R = medio riesgo ganado. Tuneable con medicion.
const PARCIAL_MIN_MFE_R = 0.5;

// TP tocado → rango numérico (TP1=1, TP2=2, TP3=3, nada=0). Tolera 'tp2'/'TP2'/2.
function tpRank(hitTP){
  if(hitTP == null) return 0;
  const s = String(hitTP).toUpperCase();
  const m = s.match(/TP\s*([123])/);
  if(m) return +m[1];
  const n = Number(hitTP);
  return (n === 1 || n === 2 || n === 3) ? n : 0;
}

// Primer TP del tier de la clase (entrada) y último (objetivo pleno).
function tierBounds(crit){
  if(!crit) return { entry: 0, full: 0 };
  if(crit.modo === 'mfe_rapido'){
    // scalp: el "pleno" es tocar su oTP (TP1) o llegar al MFE bar; el tier arranca en TP1.
    return { entry: tpRank(crit.oTP || 'TP1'), full: tpRank(crit.oTP || 'TP1') };
  }
  const tps = Array.isArray(crit.tps) ? crit.tps.map(tpRank).filter(Boolean) : [];
  if(!tps.length) return { entry: 0, full: 0 };
  return { entry: Math.min.apply(null, tps), full: Math.max.apply(null, tps) };
}

// judgeByClass(record, clase) → { veredicto, modo, motivo, mfeR, maeR, hitTP, clase }
//   veredicto: 'ganó' | 'parcial' | 'no' | 'pendiente' | 'indefinido'
//   - pendiente : señal aún ACTIVA (el resolver no la selló todavía)
//   - indefinido: AMBIGUO (TP y SL en la misma barra) o input/clase inválidos
//   FAIL-OPEN: cualquier problema → indefinido, nunca tira.
function judgeByClass(record, clase){
  const rec = record || {};
  const crit = criterioExito(clase);
  const base = { modo: crit ? crit.modo : null, clase: clase || null,
                 mfeR: (rec.mfeR == null ? null : rec.mfeR),
                 maeR: (rec.maeR == null ? null : rec.maeR),
                 hitTP: (rec.hitTP == null ? null : rec.hitTP) };

  if(!crit) return Object.assign({ veredicto: 'indefinido', motivo: 'clase inválida' }, base);
  if(rec.status === 'ACTIVA' || rec.status == null)
    return Object.assign({ veredicto: 'pendiente', motivo: 'aún sin resolver' }, base);
  if(rec.status === 'AMBIGUO')
    return Object.assign({ veredicto: 'indefinido', motivo: 'TP y SL en la misma barra' }, base);

  const rank = tpRank(rec.hitTP);
  const mfe = (rec.mfeR == null ? null : Number(rec.mfeR));
  const { entry, full } = tierBounds(crit);

  // ── SCALP — vara MFE rápido (o tocar TP1) ──
  if(crit.modo === 'mfe_rapido'){
    const bar = Number(crit.mfeR) || 1.0;
    if((mfe != null && mfe >= bar) || rank >= 1)
      return Object.assign({ veredicto: 'ganó',
        motivo: (rank >= 1 ? 'tocó '+ (rec.hitTP) : 'MFE '+ mfe +'R ≥ '+ bar +'R') }, base);
    if(mfe != null && mfe >= PARCIAL_MIN_MFE_R)
      return Object.assign({ veredicto: 'parcial',
        motivo: 'se movió +'+ mfe +'R a favor (≥'+ PARCIAL_MIN_MFE_R +'R) pero no llegó a '+ bar +'R' }, base);
    return Object.assign({ veredicto: 'no', motivo: 'no avanzó a favor (MFE '+ (mfe==null?'s/d':mfe+'R') +')' }, base);
  }

  // ── DAY / SWING — vara por tier de TP tocado (con parcial honesto por dirección) ──
  if(rank >= full)
    return Object.assign({ veredicto: 'ganó', motivo: 'alcanzó objetivo pleno ('+ tpName(full) +')' }, base);
  if(rank >= entry)
    return Object.assign({ veredicto: 'parcial', motivo: 'tocó '+ tpName(rank) +' (entró al tier, no al pleno '+ tpName(full) +')' }, base);
  if(rank >= 1)
    return Object.assign({ veredicto: 'parcial', motivo: 'tocó '+ tpName(rank) +' (por debajo del tier de la clase, pero la dirección pagó)' }, base);
  if(mfe != null && mfe >= PARCIAL_MIN_MFE_R)
    return Object.assign({ veredicto: 'parcial', motivo: 'sin TP pero MFE +'+ mfe +'R (≥'+ PARCIAL_MIN_MFE_R +'R a favor, no alcanzó tier)' }, base);
  return Object.assign({ veredicto: 'no', motivo: 'no alcanzó ni el primer TP ni excursión favorable' }, base);
}

function tpName(r){ return r >= 1 && r <= 3 ? 'TP'+r : '—'; }

// aggregateByClass(items) → { [clase]: {n, ganó, parcial, no, indef, hitRateClase, avgMfeR, avgMaeR} }
// items: [{ record, clase }] o [{...record, clase}].
function aggregateByClass(items){
  const out = {};
  for(const it of (items || [])){
    const rec   = it.record || it;
    const clase = it.clase != null ? it.clase : rec.clase;
    const v = judgeByClass(rec, clase);
    const k = v.clase || 'indefinido';
    const g = out[k] || (out[k] = { n:0, 'ganó':0, parcial:0, no:0, indef:0, pend:0,
                                    hitRateClase:null, avgMfeR:null, avgMaeR:null, _mfe:[], _mae:[] });
    g.n++;
    if(v.veredicto === 'ganó') g['ganó']++;
    else if(v.veredicto === 'parcial') g.parcial++;
    else if(v.veredicto === 'no') g.no++;
    else if(v.veredicto === 'pendiente') g.pend++;
    else g.indef++;
    if(typeof v.mfeR === 'number' && isFinite(v.mfeR)) g._mfe.push(v.mfeR);
    if(typeof v.maeR === 'number' && isFinite(v.maeR)) g._mae.push(v.maeR);
  }
  for(const k in out){
    const g = out[k];
    const decididos = g['ganó'] + g.no;
    g.hitRateClase = decididos > 0 ? g['ganó'] / decididos : 0;
    g.avgMfeR = g._mfe.length ? +avg(g._mfe).toFixed(3) : null;
    g.avgMaeR = g._mae.length ? +avg(g._mae).toFixed(3) : null;
    delete g._mfe; delete g._mae;
  }
  return out;
}

function avg(a){ return a.reduce((s,x)=>s+x,0) / a.length; }

module.exports = { judgeByClass, aggregateByClass, tpRank };
