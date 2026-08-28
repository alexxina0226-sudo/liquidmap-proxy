// finalist_direction.js — CAPA 2 (cara) del scanner: DIRECCIÓN + CONVICCIÓN del finalista.
// -----------------------------------------------------------------------------------
// PURO (sin red). Toma los OUTPUTS de la capa cara (CVD real por agresor + dark pool +
// GEX) que se fetchean SOLO sobre los pocos finalistas que la cocción rankeó, y decide:
// ¿cocina para ARRIBA o ABAJO, y con cuánta convicción? Filosofía (de las clases):
//   • el CVD por agresor DIRIGE (order-flow real: quién pega al ask vs al bid).
//   • el dark pool AMPLIFICA, no dirige (alto + alineado = acumulación/distribución).
//   • el GEX da CONTEXTO (paredes = headwind/tailwind; régimen gamma).
// Confluencia: 2-3 fuentes independientes alineadas = alta probabilidad direccional.
'use strict';

// ── DIALES (tunear acá; se calibran con el ledger) ──
const DIR = {
  CVD_BUY_UP:   53,   // buyPct del agresor ≥53% → sesgo compra
  CVD_BUY_DOWN: 47,   // buyPct ≤47% → sesgo venta ; 47-53 = neutro
  DARK_STRONG:  30,   // offExchange ≥30% = huella institucional fuerte
  WALL_NEAR_PCT: 0.6, // pared GEX a <0.6% del precio = "cerca" (headwind/tailwind)
};
function clamp(x, lo, hi){ return x < lo ? lo : x > hi ? hi : x; }
function pct100(v){ if(v == null || !isFinite(v)) return null; return v <= 1 ? v * 100 : v; } // 0.61→61

// characterizeFinalist({cvd, dark, gex, price}) → { direction, conviction, read, ...componentes }
//   cvd  : { buyPct, cvd, cvdReal, partial }              (de fetchAggressorCVD)
//   dark : { offExchangePct, offExchangeNotional, count }  (de fetchLargePrints/summarizePrints)
//   gex  : { gammaFlip, callWall, putWall, maxPain } | null (de getOptionsMetrics; opcional)
//   price: number (subyacente actual, para el contexto GEX)
function characterizeFinalist(input){
  const f = input || {};
  const cvd = f.cvd || {};
  const dark = f.dark || {};
  const gex = f.gex || null;
  const price = Number(f.price);

  // ── 1) DIRECCIÓN = CVD por agresor (order-flow real) ──
  const buyPct = isFinite(cvd.buyPct) ? Number(cvd.buyPct) : null;
  let direction = 'undetermined';
  if(buyPct != null){
    if(buyPct >= DIR.CVD_BUY_UP) direction = 'up';
    else if(buyPct <= DIR.CVD_BUY_DOWN) direction = 'down';
  }

  // ── 2) DARK POOL amplifica (no dirige) ──
  const pctDark = pct100(dark.offExchangePct);
  const darkStrong = pctDark != null && pctDark >= DIR.DARK_STRONG;
  // acumulación/distribución = dark fuerte MIENTRAS el flujo es direccional
  let flowTag = null;
  if(darkStrong && direction === 'up')   flowTag = 'acumulación (dark pool respaldando compra)';
  if(darkStrong && direction === 'down') flowTag = 'distribución (dark pool respaldando venta)';

  // ── 3) GEX contexto (headwind/tailwind + régimen gamma) — OPCIONAL ──
  let gexAdj = 0, gexTag = null;
  if(gex && isFinite(price) && price > 0){
    const near = lvl => isFinite(lvl) && Math.abs(lvl - price) / price * 100 <= DIR.WALL_NEAR_PCT;
    if(direction === 'up'){
      if(near(gex.callWall) && gex.callWall >= price){ gexAdj -= 15; gexTag = 'call wall cerca arriba (resistencia)'; }
      else if(isFinite(gex.gammaFlip) && price < gex.gammaFlip){ gexAdj += 10; gexTag = 'bajo gamma flip (gamma negativo amplifica)'; }
    } else if(direction === 'down'){
      if(near(gex.putWall) && gex.putWall <= price){ gexAdj -= 15; gexTag = 'put wall cerca abajo (soporte)'; }
      else if(isFinite(gex.gammaFlip) && price < gex.gammaFlip){ gexAdj += 10; gexTag = 'bajo gamma flip (gamma negativo amplifica)'; }
    }
  }

  // ── CONVICCIÓN 0-100 ──
  let conv = 0;
  if(buyPct != null) conv += clamp(Math.abs(buyPct - 50) * 3.5, 0, 45); // fuerza del order-flow
  if(darkStrong && direction !== 'undetermined') conv += 25;            // respaldo institucional
  conv += gexAdj;                                                       // contexto opciones
  conv = clamp(Math.round(conv), 0, 100);
  if(direction === 'undetermined') conv = Math.min(conv, 20);          // sin dirección = convicción baja

  // ── LECTURA ──
  const arrow = direction === 'up' ? '▲ ARRIBA' : direction === 'down' ? '▼ ABAJO' : '◆ sin dirección clara';
  const bits = [];
  if(buyPct != null) bits.push('CVD ' + (direction==='up'?'comprador':direction==='down'?'vendedor':'neutro') + ' ' + buyPct.toFixed(0) + '%');
  if(pctDark != null) bits.push('dark pool ' + pctDark.toFixed(0) + '%');
  if(flowTag) bits.push(flowTag);
  if(gexTag) bits.push(gexTag);
  const read = 'cocinando ' + arrow + (bits.length ? ' · ' + bits.join(' · ') : '') +
               (cvd.partial ? ' · ⚠ CVD parcial' : '') +
               (direction === 'undetermined' ? ' → esperar confirmación' : ' · convicción ' + conv + '/100');

  return { direction, conviction: conv, buyPct, pctDark, darkStrong, flowTag, gexTag, cvdReal: !!cvd.cvdReal, partial: !!cvd.partial, read };
}

module.exports = { characterizeFinalist, DIR };
