'use strict';
/**
 * obs_ledger.js — LEDGER INTELIGENTE de OBSERVACIONES (PURO).
 *
 * Mide el poder predictivo de las LECTURAS del sistema (juez, dark pool, ballena,
 * sticker) — que NO son trades (sin entry/sl/tp), sino observaciones con una
 * dirección implícita. La vara NO es R de trade: es FORWARD RETURN direccional
 * (cuando la señal dijo "up", ¿el precio subió en las próximas N barras?).
 *
 * Paralelo al ledger de trades (ledger_core), no lo toca. Comparte infra (gist +
 * getUnderlyingBars) al cablear. Este módulo es el cerebro: makeObservation +
 * resolveObservation + aggregateObs. Sin red/DOM/storage.
 *
 * Disciplina (misma de siempre): muestra chica miente → loguear, acumular, medir,
 * ajustar CONSERVADOR. Este módulo MIDE; el ajuste de pesos viene con evidencia.
 */

const DEFAULTS = {
  defHorizonBars: 8,        // cuántas barras forward medir el desenlace (tunable por kind al cablear)
  neutralBandPct: 0.20,     // 'neutral' acierta si el precio se movió < 0.2% (se quedó quieto)
  pxSanityMaxDiv: 0.25,     // GUARD bad-print: si el px capturado diverge >25% del precio real de la 1ra barra forward → mismapping símbolo→precio → sanar base con el precio real
  saneRetCapPct: 25         // red de seguridad en el agregado: |signedRetPct| > 25% = bad-print residual (ej. ya sellado) → se excluye del corte
};
function _opts(o){ return Object.assign({}, DEFAULTS, o || {}); }
function _round(x, d){ const p = Math.pow(10, d||2); return x == null ? null : Math.round(x*p)/p; }
function _num(x){ return typeof x === 'number' && isFinite(x); }
function _dir(d){ return (d === 'up' || d === 'down') ? d : 'neutral'; }

/**
 * makeObservation(ev) → registro OPEN. ev = { kind, sym, ts, dir, px?, horizonBars?, strength?, ctx? }
 *  kind: 'juez'|'darkpool'|'ballena'|'sticker' (libre). dir: 'up'|'down'|'neutral'.
 *  px: precio al momento del evento (la fuente lo conoce). strength: score/ratio opcional (para cortes).
 * Devuelve null si faltan kind/sym/ts (no se puede medir nada).
 */
function makeObservation(ev){
  ev = ev || {};
  if(!ev.kind || typeof ev.kind !== 'string') return null;
  if(!ev.sym  || typeof ev.sym  !== 'string') return null;
  if(!_num(ev.ts)) return null;
  const dir = _dir(ev.dir);
  return {
    id: ev.kind + '|' + ev.sym + '|' + ev.ts + (ev.tag ? '|' + ev.tag : ''),
    kind: ev.kind, sym: ev.sym, ts: ev.ts, dir,
    tf: (typeof ev.tf === 'string' && ev.tf) ? ev.tf : null,  // TF de las barras forward (lo usa el resolver)
    px: _num(ev.px) && ev.px > 0 ? ev.px : null,
    strength: _num(ev.strength) ? ev.strength : null,
    horizonBars: (_num(ev.horizonBars) && ev.horizonBars > 0) ? Math.floor(ev.horizonBars) : null,
    ctx: ev.ctx || null,
    status: 'open',
    fwdRetPct: null, signedRetPct: null, dirHit: null, mfePct: null,
    barsForward: null, full: null, resolvedTs: null
  };
}

/**
 * resolveObservation(rec, forwardBars, opts) → rec sellado (o intacto si no alcanza).
 *  forwardBars: barras POSTERIORES al evento (el caller filtra t>rec.ts), c/u {t,o,h,l,c}.
 *  Sella solo si hay >=H barras (horizonte cumplido) — salvo opts.force (edad vencida).
 *  base = px del evento (o el open de la 1ra barra forward). Mide:
 *   fwdRetPct   = retorno crudo (close@H - base)/base ×100
 *   signedRetPct= retorno EN la dirección de la señal (acertar = positivo)
 *   dirHit      = ¿la dirección se cumplió?
 *   mfePct      = máxima excursión a favor en la ventana
 */
function resolveObservation(rec, forwardBars, opts){
  const o = _opts(opts);
  if(!rec || rec.status === 'resolved') return rec;
  const bars = Array.isArray(forwardBars) ? forwardBars : [];
  if(bars.length === 0) return rec;                      // sin barras → sigue open
  const H = rec.horizonBars || o.defHorizonBars;
  const full = bars.length >= H;
  if(!full && !o.force) return rec;                      // horizonte no cumplido → espera

  // Precio REAL justo después del evento (barras por símbolo de Alpaca = fuente independiente del scan).
  const refPx = (_num(bars[0].o) && bars[0].o > 0) ? bars[0].o : null;
  let base = (rec.px && rec.px > 0) ? rec.px : refPx;
  if(!_num(base) || base <= 0) return rec;               // sin base sana → no puede medir
  // GUARD bad-print: px capturado diverge absurdo del precio real → mismapping símbolo→precio.
  // Sano la base con el precio real (el registro se salva medido bien, no envenenado).
  let pxHealed = false, pxRaw = null;
  if(refPx && rec.px && rec.px > 0 && Math.abs(rec.px / refPx - 1) > o.pxSanityMaxDiv){
    pxRaw = rec.px; base = refPx; pxHealed = true;
  }
  const endIdx = Math.min(H, bars.length) - 1;
  const endClose = bars[endIdx].c;
  const fwdRet = (endClose - base) / base;               // fracción
  const sign = rec.dir === 'up' ? 1 : rec.dir === 'down' ? -1 : 0;

  // MFE forward (máx a favor de la dirección; neutral = máx movimiento absoluto)
  let mfe = 0;
  for(let i = 0; i <= endIdx; i++){
    const b = bars[i];
    let fav;
    if(sign > 0)      fav = (b.h - base) / base;
    else if(sign < 0) fav = (base - b.l) / base;
    else              fav = Math.max((b.h - base) / base, (base - b.l) / base);
    if(fav > mfe) mfe = fav;
  }

  const dirHit = rec.dir === 'neutral'
    ? Math.abs(fwdRet) * 100 <= o.neutralBandPct
    : (sign > 0 ? fwdRet > 0 : fwdRet < 0);
  const signedRet = sign !== 0 ? fwdRet * sign : -Math.abs(fwdRet);  // neutral: mover en contra penaliza

  return Object.assign({}, rec, {
    status: 'resolved',
    fwdRetPct: _round(fwdRet * 100, 3),
    signedRetPct: _round(signedRet * 100, 3),
    dirHit: !!dirHit,
    mfePct: _round(mfe * 100, 3),
    barsForward: endIdx + 1,
    full,
    resolvedTs: bars[endIdx].t,
    pxHealed: pxHealed,          // true = la base capturada era un bad-print y se sanó con el precio real
    pxRaw: pxRaw                 // el px mentiroso original (null si no hubo que sanar)
  });
}

/**
 * aggregateObs(list, keyFn) → { key: { n, hits, hitRate, avgSignedRetPct, avgMfePct } }
 *  Solo cuenta RESUELTOS. keyFn default = por kind. hitRate y avgSignedRetPct son
 *  las dos palancas: ¿acierta seguido? ¿y cuánto rinde en su dirección?
 */
function aggregateObs(list, keyFn, opts){
  const o = _opts(opts);
  const key = keyFn || (r => r.kind);
  const acc = {};
  for(const r of (list || [])){
    if(!r || r.status !== 'resolved') continue;
    // Red de seguridad: un retorno absurdo = bad-print residual (ej. sellado antes del guard) → excluir.
    if(_num(r.signedRetPct) && Math.abs(r.signedRetPct) > o.saneRetCapPct){
      if(typeof o.onDrop === 'function') o.onDrop(r);
      continue;
    }
    const k = key(r);
    const a = acc[k] || (acc[k] = { n:0, hits:0, _sr:0, _mfe:0 });
    a.n++;
    if(r.dirHit) a.hits++;
    if(_num(r.signedRetPct)) a._sr  += r.signedRetPct;
    if(_num(r.mfePct))       a._mfe += r.mfePct;
  }
  const out = {};
  for(const k in acc){
    const a = acc[k];
    out[k] = {
      n: a.n,
      hits: a.hits,
      hitRate: a.n ? _round(a.hits / a.n, 3) : null,
      avgSignedRetPct: a.n ? _round(a._sr / a.n, 3) : null,
      avgMfePct: a.n ? _round(a._mfe / a.n, 3) : null
    };
  }
  return out;
}

module.exports = { makeObservation, resolveObservation, aggregateObs, DEFAULTS };
