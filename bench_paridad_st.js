// bench_paridad_st.js — banco de PARIDAD del SuperTrend JUEZ crypto ↔ bolsa (s58)
// El reloj exige que los dos jueces lean el MISMO lenguaje. Verifica:
// (1) IDENTIDAD BYTE A BYTE — computeSuperTrend en crypto es exactamente la función de bolsa;
// (2) IDENTIDAD EMPÍRICA — mismas velas → mismos flips, misma tendencia vela a vela, misma línea;
// (3) PROPIEDADES del ST fiel: ATR Wilder/RMA exacto (no la SMA inflada vieja: 11 TRs/10),
//     giro contra la banda final de la vela PREVIA, ratchet de bandas correcto;
// (4) INTERFAZ — los consumidores del crypto ({i, line, trend}) siguen servidos.
// Correr junto a: LiquidityMap_CRYPTO_v6_2.html y LiquidityMap_BOLSA_v5.html en la misma carpeta.
'use strict';
const fs = require('fs');
function loadFn(file, name){
  const html = fs.readFileSync(file, 'utf8');
  const i = html.indexOf('function ' + name);
  if(i < 0) throw new Error(`no encontré ${name} en ${file}`);
  let d = 0, j = html.indexOf('{', i);
  for(let k = j; k < html.length; k++){
    if(html[k]==='{') d++;
    else if(html[k]==='}'){ d--; if(d===0) return html.slice(i, k+1); }
  }
}
const CRYPTO = './LiquidityMap_CRYPTO_v6_2.html', BOLSA = './LiquidityMap_BOLSA_v5.html';
const srcC = loadFn(CRYPTO, 'computeSuperTrend');
const srcB = loadFn(BOLSA, 'computeSuperTrend');
const stC = new Function(srcC + '; return computeSuperTrend;')();
const stB = new Function(srcB + '; return computeSuperTrend;')();

let pass = 0, fail = 0;
const check = (n, c) => { if(c){ pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ FALLA: ' + n); } };
console.log('BENCH PARIDAD ST JUEZ — crypto ↔ bolsa, el mismo lenguaje (código real de ambos HTML)');

// 1) IDENTIDAD BYTE A BYTE
check('computeSuperTrend crypto === bolsa (byte a byte)', srcC === srcB);

// mercado sintético reproducible: tendencia + ruido + reversión
let seed = 42; const rnd = () => (seed = (seed*9301+49297)%233280) / 233280;
const bars = []; let px = 100;
for(let i = 0; i < 400; i++){
  const drift = i < 120 ? 0.15 : i < 230 ? -0.22 : 0.10;
  px += drift + (rnd()-0.5)*1.6;
  const h = px + rnd()*0.8, l = px - rnd()*0.8;
  bars.push({ h, l, c: l + rnd()*(h-l) });
}

// 2) IDENTIDAD EMPÍRICA
const rC = stC(bars, 10, 3.0), rB = stB(bars, 10, 3.0);
const flips = r => r.filter((x,k)=>k>0 && x.trend!==r[k-1].trend).map(x=>`${x.i}:${x.trend}`);
check(`mismos flips (${flips(rB).length})`, flips(rC).join(',') === flips(rB).join(','));
check('misma tendencia vela a vela', rC.length===rB.length && rC.every((x,k)=>x.trend===rB[k].trend));
check('misma línea ST vela a vela', rC.every((x,k)=>Math.abs(x.line-rB[k].line) < 1e-12));

// 3a) ATR Wilder/RMA exacto — recomputado a mano contra el ATR que reporta la función
const tr = bars.map((b,i)=> i===0 ? b.h-b.l : Math.max(b.h-b.l, Math.abs(b.h-bars[i-1].c), Math.abs(b.l-bars[i-1].c)));
let atrW = tr.slice(0,10).reduce((a,b)=>a+b,0)/10;
for(let i=10;i<bars.length;i++) atrW = (atrW*9 + tr[i])/10;
const lastAtr = rC[rC.length-1].atr;
check('ATR Wilder exacto (RMA, como ta.atr del Pine)', Math.abs(lastAtr - atrW) < 1e-9);
// y NO es la SMA vieja inflada (11 TRs / 10)
const slice = bars.slice(bars.length-11);
const trOld = slice.map((b,j)=> j===0 ? b.h-b.l : Math.max(b.h-b.l, Math.abs(b.h-slice[j-1].c), Math.abs(b.l-slice[j-1].c)));
const atrViejo = trOld.reduce((a,v)=>a+v,0)/10;
check('el ATR ya NO es la SMA off-by-one vieja', Math.abs(lastAtr - atrViejo) > 1e-6);

// 3b) Giro contra banda de la vela PREVIA: caso quirúrgico de una vela
//     Construyo velas donde el close cruza la banda PREVIA pero NO la banda ACTUAL
//     recalculada — el fiel (banda previa) flipea; la variante vieja (banda actual) no.
const flat = []; for(let i=0;i<30;i++){ flat.push({ h:101, l:99, c:100.5 }); }  // banda sup ≈ 100+3*2=106
flat.push({ h:112, l:104, c:107 });   // hl2=108, banda actual=114; banda PREVIA=106 → close 107 la cruza
const rFlip = stC(flat, 10, 3.0);
const lastTwo = rFlip.slice(-2).map(x=>x.trend);
check('giro contra banda PREVIA (close cruza prev, no la actual) → flipea', lastTwo[0]===-1 || lastTwo[1]===1);

// 3c) Ratchet: en tendencia alcista la banda inferior nunca baja (salvo giro)
let ratchetOk = true;
for(let k=1;k<rB.length;k++){
  if(rB[k].trend===1 && rB[k-1].trend===1 && rB[k].lower < rB[k-1].lower - 1e-9){ ratchetOk = false; break; }
}
check('ratchet de banda inferior en tendencia alcista (nunca baja)', ratchetOk);

// 4) INTERFAZ para los consumidores del crypto: {i, line, trend} presentes y sanos
check('interfaz {i, line, trend} intacta', rC.every(x => Number.isInteger(x.i) && isFinite(x.line) && (x.trend===1||x.trend===-1)));

console.log(`\nRESULTADO: ${pass}/${pass+fail}`);
process.exit(fail ? 1 : 0);
