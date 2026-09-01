// signal_class.js — CLASIFICADOR scalp / day / swing con "SENTIDO REAL". FASE calibración.
// -----------------------------------------------------------------------------------------
// PURO (sin red, sin estado). Toma los features que el MAPA YA computa y devuelve la CLASE
// + su contrato/horizonte + su CRITERIO DE ÉXITO propio (lo que arregla el 0/20: cada clase
// se juzga con su vara). Deriva del FRAMEWORK v0.2 co-diseñado con Gonzalo.
// Los DIALES son constantes tuneables acá arriba — Gonzalo ajusta números sin tocar lógica.
'use strict';

// ── DIALES (tunear acá; no toca la lógica de abajo) ──────────────────────────────
const DIALS = {
  SCALP_RVOL: 1.3,   // RVOL "avisando" un movimiento (y en ASCENSO) → anticipación
  DAY_RVOL:   1.2,   // volumen "presente" para day
  SWING_RVOL: 1.8,   // volumen "elevado" (sello institucional) para swing
  SCALP_MFE_R: 1.0,  // MFE (en R) que cuenta como scalp GANADOR (o tocar TP1)
  DTE: { scalp: [0, 2], day: [2, 5], swing: [7, 14] },
  HORIZON_BARS: { scalp: 8, day: 26, swing: 30 },  // barras de vida esperadas por clase
};

// Criterio de éxito POR CLASE (cómo el ledger juzga cada una, además de la binaria).
function criterioExito(clase){
  if(clase === 'scalp') return { modo: 'mfe_rapido', mfeR: DIALS.SCALP_MFE_R, oTP: 'TP1' };
  if(clase === 'day')   return { modo: 'tp_sesion',    tps: ['TP1', 'TP2'] };
  if(clase === 'swing') return { modo: 'tp_horizonte', tps: ['TP2', 'TP3'] };
  return null;
}

// rvolRising: true si el RVOL viene acelerando (bool explícito, o derivado de rvolPrev).
function isRvolRising(f){
  if(f.rvolRising === true) return true;
  if(f.rvolRising === false) return false;
  if(f.rvolPrev != null && f.rvol != null) return f.rvol > f.rvolPrev;
  return false;
}

// classifySignal(features) → { clase, dte, horizonBars, criterioExito, razon }
//   features (lo que el mapa ya computa):
//     semaphore : 'alta'|'media'|'baja'|null   (evidencia)
//     regime    : 'COMPRESIÓN'|'EXPANSIÓN'|'NEUTRAL'|null
//     rvol      : number   (lastV/avg20) ; rvolRising:bool | rvolPrev:number
//     chochFresh: bool ; bosFresh: bool         (cambio de estructura reciente)
//     withTrend : bool     (la señal va a favor del estado estructural)
//     htfAligned: bool     (MTF 4H a favor)
//     cvdAgrees : bool     (CVD por agresor a favor de la señal)
// PRECEDENCIA: swing > day > scalp > esperar (la más confirmada gana).
// FAIL-OPEN: input inválido → { clase:'indefinido', razon:'features inválidos' }.
function classifySignal(features){
  const f = features || {};
  const sem = String(f.semaphore || '').toLowerCase();
  const semOK = (sem === 'alta' || sem === 'media');   // gatillo mínimo de evidencia
  const rvol = Number(f.rvol);
  const hasRvol = isFinite(rvol);
  const rising = isRvolRising(f);
  const structChange = !!(f.chochFresh || f.bosFresh);

  if(!hasRvol && !sem){
    return { clase: 'indefinido', dte: null, horizonBars: null, criterioExito: null, razon: 'features inválidos' };
  }

  // ── SWING — cambio de tendencia + confirmación de flujo + tendencia a favor ──
  // La confirmación de marco superior (htfAligned) es el IDEAL. Si el emisor no evalúa MTF
  // (monitor 4H → htfAligned false honesto), se acepta la tendencia del PROPIO TF como proxy
  // explícito (withTrend = ADX 4H a favor). No miente sobre el HTF: un swing 4H con estructura
  // fresca + RVOL institucional + CVD + tendencia a favor es swing POR CRITERIO, no por fallback.
  if(structChange && hasRvol && rvol >= DIALS.SWING_RVOL && f.cvdAgrees && (f.htfAligned || f.withTrend) && semOK){
    return pack('swing', 'CHoCH/BOS fresco + RVOL elevado + CVD a favor + tendencia a favor (' + (f.htfAligned ? 'HTF' : '4H') + ')');
  }
  // ── DAY — expansión + estructura a favor + volumen presente ──
  if(f.regime === 'EXPANSIÓN' && f.withTrend && hasRvol && rvol >= DIALS.DAY_RVOL && semOK){
    return pack('day', 'expansión + a favor de estructura + RVOL presente');
  }
  // ── SCALP — anticipación: semáforo media + compresión cargada + RVOL en ascenso ──
  if(semOK && hasRvol && rising && (f.regime === 'COMPRESIÓN' || rvol >= DIALS.SCALP_RVOL)){
    return pack('scalp', 'semáforo≥media + RVOL en ascenso' + (f.regime === 'COMPRESIÓN' ? ' + compresión cargada' : ''));
  }
  return { clase: 'esperar', dte: null, horizonBars: null, criterioExito: null, razon: 'no califica ninguna clase todavía' };
}

function pack(clase, razon){
  return {
    clase,
    dte: DIALS.DTE[clase],
    horizonBars: DIALS.HORIZON_BARS[clase],
    criterioExito: criterioExito(clase),
    razon,
  };
}

module.exports = { classifySignal, criterioExito, isRvolRising, DIALS };
