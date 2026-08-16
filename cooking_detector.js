// cooking_detector.js — CAPA 3 del radar: "EN COCCIÓN" (anticipación del movimiento).
// -----------------------------------------------------------------------------------
// PURO (sin red, sin estado). Detecta el COIL antes del pop: volumen DESPERTÁNDOSE
// mientras el precio TODAVÍA está quieto (energía cargándose, no liberada). Es la capa
// MÁS TEMPRANA — antes que el pre-aviso (que ya exige precio moviéndose 1.2×ATR).
// Se alimenta del MISMO rvol normalizado-por-hora que ya calcula evaluate() del radar
// (apples-to-apples con el baseline SIP), + el rvol del scan anterior (STATE) para ver
// la ACELERACIÓN. Barato: solo snapshot, sirve para barrer el universo ~113 y RANKEAR
// los finalistas → sobre esos pocos corre después la capa cara (CVD real + dark pool + GEX).
'use strict';

// ── DIALES (tunear acá; se calibran con el ledger, como los del clasificador) ──
const COOK = {
  RVOL_MIN:      1.3,   // volumen "despierto" (mismo piso que el pre-aviso)
  RVOL_CAP:      3.0,   // techo para no premiar de más una explosión ya en curso
  MOVE_MAX:      1.2,   // "todavía quieto": |move| < 1.2×ATR (si ya pasó, es pre-aviso/confirmada, no cocción)
  RISING_MARGIN: 1.05,  // el RVOL debe venir ACELERANDO ≥5% vs el scan anterior
  MIN_FRAC:      0.05,  // < 5% de sesión → RVOL aún no confiable (igual que el radar)
};

function clamp(x, lo, hi){ return x < lo ? lo : x > hi ? hi : x; }

// scoreCooking(f) → { cooking, score, ...componentes }
//   f: { rvol, rvolPrev, moveATR, frac }  (rvol y rvolPrev = normalizados por hora, del radar)
//      rvolPrev null = primer scan del ticker (sin historia → no se puede ver aceleración).
function scoreCooking(f){
  const rvol    = Number(f.rvol);
  const moveATR = Number(f.moveATR);
  const frac    = Number(f.frac);
  if(!isFinite(rvol) || !isFinite(moveATR) || !isFinite(frac)) return null;
  if(frac < COOK.MIN_FRAC) return null;                 // demasiado temprano

  const rvolPrev = (f.rvolPrev == null) ? null : Number(f.rvolPrev);
  const accel    = rvolPrev != null ? rvol - rvolPrev : 0;
  const rising   = rvolPrev != null && rvol >= rvolPrev * COOK.RISING_MARGIN;
  const coiled   = Math.abs(moveATR) < COOK.MOVE_MAX;   // energía SIN liberar
  const waking   = rvol >= COOK.RVOL_MIN;               // volumen presente
  const cooking  = waking && rising && coiled;          // las tres a la vez

  // score 0-100 SOLO para rankear finalistas (mientras cooking=true).
  const rvolPart  = clamp((Math.min(rvol, COOK.RVOL_CAP) - 1) * 25, 0, 50); // magnitud del volumen
  const accelPart = clamp(accel * 60, 0, 30);                                // qué tan rápido acelera
  const coilPart  = coiled ? clamp((COOK.MOVE_MAX - Math.abs(moveATR)) * 16, 0, 20) : 0; // qué tan tenso el coil
  const score = cooking ? Math.round(rvolPart + accelPart + coilPart) : 0;

  let reason;
  if(!waking)       reason = 'volumen dormido (RVOL ' + rvol.toFixed(2) + ' < ' + COOK.RVOL_MIN + ')';
  else if(!rising)  reason = rvolPrev == null ? 'primer scan (sin historia de aceleración)' : 'RVOL no acelera';
  else if(!coiled)  reason = 'ya se movió (' + Math.abs(moveATR).toFixed(1) + '×ATR ≥ ' + COOK.MOVE_MAX + ') — es pre-aviso/confirmada, no cocción';
  else              reason = 'COCINANDO: volumen acelerando ' + rvol.toFixed(2) + '× (Δ+' + accel.toFixed(2) + ') con precio aún quieto (' + Math.abs(moveATR).toFixed(1) + '×ATR)';

  return { cooking, score, rvol, rvolPrev, accel, moveATR, rising, coiled, waking, reason };
}

module.exports = { scoreCooking, COOK };
