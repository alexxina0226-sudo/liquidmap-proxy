// bench_divergencia_bolsa.js — banco del detector de divergencias (s57)
// Verifica: (1) bajista y alcista se detectan como siempre (regresión); (2) la ASIMETRÍA
// del return temprano quedó corregida — si ambas coexisten (chop ancho) ya no gana la
// bajista por orden de código: se declara DIV. DOBLE = aviso de rango, no direccional;
// (3) la REDACCIÓN nueva es distinguible de reojo: dirección primero, flecha distinta.
'use strict';
const fs = require('fs');
const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');
function extract(name){
  const i = html.indexOf('function ' + name);
  if(i < 0) throw new Error('no encontré ' + name);
  let d = 0, j = html.indexOf('{', i);
  for(let k = j; k < html.length; k++){
    if(html[k] === '{') d++;
    else if(html[k] === '}'){ d--; if(d === 0) return html.slice(i, k + 1); }
  }
}
const detect = new Function(extract('detectMomentumDivergence') + '; return detectMomentumDivergence;')();

// velas con cierres controlados: ROC(5) exacto donde lo necesitamos
// c18=90 → roc(18)=-10% · c20=110 → roc(20)=+10% · c25=105 → roc(25)=-4.5% (menos
// negativo que -10%) · c27=112 vs c22=111 → roc(27)=+0.9% (más débil que +10%)
const closes = [100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,90,100,110,100,111,100,100,105,100,112,100,100];
const bars = closes.map(c => ({ c }));
const HH = (price, i) => ({ type:'HH', price, i });
const LL = (price, i) => ({ type:'LL', price, i });

let pass = 0, fail = 0;
const check = (n, c) => { if(c){ pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ FALLA: ' + n); } };
console.log('BENCH DIVERGENCIAS BOLSA — redacción + asimetría del return temprano (código real)');

// 1) BAJISTA sola (regresión): HH 110→112 con momentum +10%→+0.9%
let r = detect(bars, [LL(90,18), HH(110,20), LL(91,25), HH(112,27)]); // LLs suben: no califican alcista
check('bajista sola → BEAR_DIV', r && r.type === 'BEAR_DIV' && r.dir === 'BEAR');
check('etiqueta bajista arranca con la dirección', r && r.label.includes('DIV. BAJISTA') && r.label.includes('🔻'));

// 2) ALCISTA sola (regresión): LL 90→88 con momentum -10%→-4.5%
r = detect(bars, [HH(112,20), LL(90,18), HH(110,27), LL(88,25)]); // HHs bajan: no califican bajista
check('alcista sola → BULL_DIV', r && r.type === 'BULL_DIV' && r.dir === 'BULL');
check('etiqueta alcista arranca con la dirección', r && r.label.includes('DIV. ALCISTA') && r.label.includes('🔺'));

// 3) AMBAS a la vez (chop ancho) → DIV. DOBLE, no direccional
//    ANTES: el return temprano devolvía BEAR_DIV y la alcista jamás se mostraba.
r = detect(bars, [LL(90,18), HH(110,20), LL(88,25), HH(112,27)]);
check('ambas coexisten → DUAL_DIV (antes: ganaba la bajista por orden de código)',
  r && r.type === 'DUAL_DIV' && r.dir === 'NEUTRAL');
check('la doble se declara como rango, no como dirección', r && r.label.includes('DOBLE') && r.label.includes('rango'));

// 4) Redacción distinguible: las dos etiquetas difieren desde el arranque
const rb = detect(bars, [LL(90,18), HH(110,20), LL(91,25), HH(112,27)]);
const ra = detect(bars, [HH(112,20), LL(90,18), HH(110,27), LL(88,25)]);
check('etiquetas distinguibles de reojo (primeros 12 caracteres distintos)',
  rb.label.slice(0,12) !== ra.label.slice(0,12));

// 5) Sin divergencia → null (los patrones no califican)
r = detect(bars, [HH(112,20), LL(88,18), HH(110,27), LL(90,25)]); // HH baja y LL sube
check('sin patrón → null', r === null);

// 6) Guard de datos insuficientes → null
check('pocos swings → null', detect(bars, [HH(110,20), HH(112,27)]) === null);
check('pocas velas → null', detect(bars.slice(0,8), [LL(90,18), HH(110,20), LL(88,25), HH(112,27)]) === null);

console.log(`\nRESULTADO: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
