// signal_features.js — FEATURES compartidos mapa↔monitor para el clasificador.
// ---------------------------------------------------------------------------
// El monitor debe ser "copia lo más fiel posible del mapa" (norte de Gonzalo).
// Este módulo PORTA las dos capas que al monitor le faltaban — SEMÁFORO y RVOL —
// para que classifySignal pueda correr en la emisión igual que correría en el mapa.
//
// FIDELIDAD: computeSemaforoBolsa está copiado VERBATIM del mapa (LiquidityMap v7,
// líneas 1322-1345). El bench diffea esta copia contra el mapa → si el mapa cambia,
// el diff avisa. computeRvol usa la MISMA fórmula del computeFlow del mapa
// (avg20 de las 20 barras PREVIAS, lastV/avg20).
//
// El monitor YA arma su array `layers` con forma {name,dir,abs} (buildGovSig) — la
// MISMA que el semáforo espera — y YA tiene barras. Así el porte es alimentar estas
// funciones con lo que el monitor ya produce, sin recalcular nada nuevo.
'use strict';

// ── SEMÁFORO — VERBATIM del mapa (computeSemaforoBolsa). NO EDITAR sin re-sincronizar. ──
function computeSemaforoBolsa(layers){
  if(!layers || !layers.length) return null;
  let b=0, s=0, neut=0, abs=0;
  for(const L of layers){
    if(L && L.abs){ abs++; continue; }
    const dir = L ? (L.dir||0) : 0;
    if(dir>0) b++; else if(dir<0) s++; else neut++;
  }
  const d = b>s ? 1 : s>b ? -1 : 0;
  const conf    = d>0 ? b : d<0 ? s : Math.max(b,s);
  const against = d>0 ? s : d<0 ? b : Math.max(b,s);   // empate exacto → against==conf → pelea
  const arrow = d>0 ? '▲' : d<0 ? '▼' : '◆';
  let label, cls;
  if(abs >= 3){ label='BAJA · ciego'; cls='sem-r'; }
  else if(b===0 && s===0){ label='MEDIA · sin sesgo'; cls='sem-y'; }
  else if(against >= conf){ label='BAJA · capas en pelea'; cls='sem-r'; }
  else if(conf >= 5 && against <= 1 && abs <= 1){ label='ALTA'; cls='sem-g'; }
  else { label='MEDIA'; cls='sem-y'; }
  return { label, cls, arrow, conf, against, neut, abs,
           counter: conf+'✓·'+against+'✗·'+neut+'◦·'+abs+'∅' };
}
// ── fin VERBATIM ──

// semaphoreLevel(semObj|label) → 'alta'|'media'|'baja'|null — normaliza al contrato
// del clasificador (f.semaphore espera 'alta'/'media'/'baja'). Toma la 1ª palabra
// del label del semáforo (ALTA / MEDIA / BAJA · …) y la baja a minúscula.
function semaphoreLevel(sem){
  const label = sem && typeof sem === 'object' ? sem.label : sem;
  if(!label) return null;
  const first = String(label).trim().split(/[\s·]+/)[0].toLowerCase();
  return (first === 'alta' || first === 'media' || first === 'baja') ? first : null;
}

// computeRvol(bars) → { rvol, rvolPrev } — MISMA fórmula del mapa (computeFlow).
//   rvol     = vol de la última barra / promedio de las 20 barras PREVIAS (excluye la última)
//   rvolPrev = el mismo cálculo corrido UNA barra atrás → habilita la detección de "RVOL en ascenso"
//              (isRvolRising del clasificador). null si no hay ≥21 barras.
function computeRvol(bars){
  if(!Array.isArray(bars) || bars.length < 21) return { rvol: null, rvolPrev: null };
  const rvolAt = (arr) => {
    if(arr.length < 21) return null;
    const avg20 = arr.slice(-21,-1).reduce((a,b)=>a+((b&&b.v)||0),0)/20;
    const lastV = (arr[arr.length-1] && arr[arr.length-1].v) || 0;
    return avg20>0 ? +(lastV/avg20).toFixed(4) : 0;
  };
  return { rvol: rvolAt(bars), rvolPrev: rvolAt(bars.slice(0,-1)) };
}

// buildClassifierFeatures(ctx) → objeto de features listo para classifySignal.
//   ctx (lo que el monitor ya tiene en la emisión):
//     layers   : array {name,dir,abs}  (buildGovSig del monitor)
//     bars     : [{...,v}]              (para rvol/rvolPrev)
//     regime   : 'EXPANSIÓN'|'COMPRESIÓN'|'NEUTRAL'   (capa 6 del monitor)
//     struct   : { chochFresh?, bosFresh? }
//     withTrend, htfAligned, cvdAgrees : bool
//   PURO, fail-open: campos ausentes → undefined/null, el clasificador ya tolera eso.
function buildClassifierFeatures(ctx){
  const c = ctx || {};
  const sem = computeSemaforoBolsa(c.layers);
  const { rvol, rvolPrev } = computeRvol(c.bars);
  const st = c.struct || {};
  return {
    semaphore : semaphoreLevel(sem),
    rvol, rvolPrev,
    regime    : c.regime != null ? c.regime : null,
    chochFresh: !!st.chochFresh,
    bosFresh  : !!st.bosFresh,
    withTrend : !!c.withTrend,
    htfAligned: !!c.htfAligned,
    cvdAgrees : !!c.cvdAgrees,
    _sem: sem   // el objeto crudo del semáforo (para logging/telemetría, no lo usa el clasificador)
  };
}

// computeRegime(bars) → { regime, expRatio, atr14 } — MISMA lógica del computeFlow del mapa.
//   regime: 'EXPANSIÓN' (atrFast/atrSlow >= 1.15) | 'COMPRESIÓN' (<= 0.85) | 'NEUTRAL'.
//   Portado para que el clasificador tenga el MISMO régimen que tendría en el mapa
//   (el monitor calcula ADX-lateral, que NO es lo mismo — esto lo cierra fiel).
function computeRegime(bars){
  if(!Array.isArray(bars) || bars.length < 8) return { regime: 'NEUTRAL', expRatio: 1, atr14: null };
  const tr = [];
  for(let i=1;i<bars.length;i++){
    const pc = bars[i-1].c;
    tr.push(Math.max(bars[i].h-bars[i].l, Math.abs(bars[i].h-pc), Math.abs(bars[i].l-pc)));
  }
  const atrN = (arr,n)=> arr.length ? arr.slice(-Math.min(n,arr.length)).reduce((a,v)=>a+v,0)/Math.min(n,arr.length) : 0;
  const atr14 = atrN(tr,14), atrFast = atrN(tr,7), atrSlow = atrN(tr,21);
  const expRatio = atrSlow>0 ? atrFast/atrSlow : 1;
  let regime;
  if(expRatio >= 1.15) regime = 'EXPANSIÓN';
  else if(expRatio <= 0.85) regime = 'COMPRESIÓN';
  else regime = 'NEUTRAL';
  return { regime, expRatio: +expRatio.toFixed(3), atr14: atr14 ? +atr14.toFixed(4) : null };
}

module.exports = { computeSemaforoBolsa, semaphoreLevel, computeRvol, computeRegime, buildClassifierFeatures };
