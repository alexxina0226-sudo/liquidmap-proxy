'use strict';
/**
 * dp_baseline.js — AUTO-CALIBRACIÓN del baseline de dark pool por ticker (PURO).
 *
 * Sin red, sin DOM, sin storage: solo lógica testeable. El store (gist) y el
 * endpoint se cablean aparte; este módulo es el cerebro.
 *
 * Idea: cada ticker aprende SU propio baseline del % off-exchange a partir de
 * las muestras que el mapa ya obtiene en vivo. Las bandas de color (amarillo/
 * verde) salen de percentiles del PROPIO ticker (p75/p90), no de un % absoluto.
 *
 * Disciplina (misma que la auditoría): no confiar en muestra chica; ventana
 * rodante; detectar solo los tickers sin rango útil (quiet names).
 */

const DEFAULTS = {
  minSpacingMs: 15 * 60 * 1000,               // 1 muestra por ticker cada 15min → sobre-mirar no sesga
  maxAgeMs:     60 * 24 * 60 * 60 * 1000,     // ventana rodante ~60 días hábiles
  maxSamples:   200,                          // cap duro por ticker (gist chico)
  minSamples:   25,                           // por debajo NO se confía en el aprendido
  pctYellow:    0.75,                         // amarillo = p75 del propio ticker
  pctGreen:     0.90,                         // verde   = p90 del propio ticker
  degenSpread:  1.5,                          // si p90-p75 < esto → sin rango (quiet name)
  degenFloor:   99.5                          // o si p75 >= esto → pegado al tope, señal baja
};

function _opts(o){ return Object.assign({}, DEFAULTS, o || {}); }
function _round1(x){ return x == null ? null : Math.round(x * 10) / 10; }
function _validPct(p){ return typeof p === 'number' && isFinite(p) && p >= 0 && p <= 100; }

/** percentil con interpolación lineal; q en [0,1]; arr YA ordenado ascendente. */
function percentile(sortedAsc, q){
  const n = sortedAsc.length;
  if(!n) return null;
  if(n === 1) return sortedAsc[0];
  const idx = q * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if(lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * addSample(entry, ts, pct, opts) → { accepted, reason, entry }
 * entry = { samples:[{t,p}] } | undefined (se crea). Muta e.samples in-place.
 * Rechaza: pct/ts inválidos ('invalid'), o muestra dentro del spacing / fuera de
 * orden ('too-soon'). Prunea por antigüedad (ref = ts entrante) y por cap.
 */
function addSample(entry, ts, pct, opts){
  const o = _opts(opts);
  const e = (entry && Array.isArray(entry.samples)) ? entry : { samples: [] };
  if(!_validPct(pct) || typeof ts !== 'number' || !isFinite(ts)){
    return { accepted:false, reason:'invalid', entry:e };
  }
  const s = e.samples;
  const last = s.length ? s[s.length - 1] : null;
  if(last && (ts - last.t) < o.minSpacingMs){            // negativo (out-of-order) también cae acá
    return { accepted:false, reason:'too-soon', entry:e };
  }
  s.push({ t: ts, p: pct });
  const cutoff = ts - o.maxAgeMs;                        // prune por ventana rodante
  let i = 0; while(i < s.length && s[i].t < cutoff) i++;
  if(i > 0) s.splice(0, i);
  if(s.length > o.maxSamples) s.splice(0, s.length - o.maxSamples);  // prune por cap
  return { accepted:true, reason:'ok', entry:e };
}

/**
 * computeBands(entry, opts) → { ready, n, degenerate, y, g }
 * ready=false si n<minSamples (el consumidor cae a seed/_def).
 * degenerate=true si el ticker no tiene rango útil (quiet name / pegado al tope).
 */
function computeBands(entry, opts){
  const o = _opts(opts);
  const s = (entry && Array.isArray(entry.samples)) ? entry.samples : [];
  const n = s.length;
  if(n < o.minSamples) return { ready:false, n, degenerate:false, y:null, g:null };
  const vals = s.map(x => x.p).sort((a,b) => a - b);
  const y = percentile(vals, o.pctYellow);
  const g = percentile(vals, o.pctGreen);
  const degenerate = (g - y) < o.degenSpread || y >= o.degenFloor;
  return { ready:true, n, degenerate, y:_round1(y), g:_round1(g) };
}

/**
 * resolveBands(entry, seed, defBands, opts) → banda a usar hoy, con procedencia.
 * Prioridad: aprendido (listo y con rango) → seed CSV → _def.
 * Si el aprendido está listo pero es degenerado → {degenerate:true} (no colorear).
 */
function resolveBands(entry, seed, defBands, opts){
  const b = computeBands(entry, opts);
  if(b.ready && !b.degenerate) return { y:b.y, g:b.g, source:'learned', n:b.n };
  if(b.ready &&  b.degenerate) return { degenerate:true, source:'learned', n:b.n };
  if(seed && _validPct(seed.y) && _validPct(seed.g)) return { y:seed.y, g:seed.g, source:'seed' };
  const d = defBands || {};
  return { y:d.y, g:d.g, source:'def' };
}

module.exports = { percentile, addSample, computeBands, resolveBands, DEFAULTS };
