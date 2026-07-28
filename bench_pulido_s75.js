// ════════════════════════════════════════════════════════════════════
//  bench_pulido_s75.js — s75 · 28-jul-2026
//  Banco del PULIDO FINAL de la capa de opciones. Cubre:
//   A) fmtExpShort — formateador de fecha de expiración para la píldora.
//      Extraído del HTML real y ejecutado. 12 meses, bordes y seguridad de
//      timezone (parse manual, NO Date() → no se corre un día).
//   B) ESTRUCTURAL sobre el HTML real: etiqueta de OI "cierre previo" en el
//      popup /contrato, en el tooltip de la píldora y en la nota del panel
//      GEX/Max Pain; leyenda con las entradas de la píldora 🎯 y de la
//      SALIDA theta-aware; cabeceras viejas "Black-Scholes/BS" ya corregidas.
//  Todo el pulido es DISPLAY — no toca score, Governor ni el motor de opciones.
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

// ── fmtExpShort REAL extraída del HTML ──
const m = html.match(/function fmtExpShort\(iso\)\{[\s\S]*?\n\}/);
const fmtExpShort = new Function('return (' + m[0].replace('function fmtExpShort', 'function') + ')')();

console.log('── A) fmtExpShort (formateo de fecha) ──');
ok('A1 caso base: 2026-08-15 → 15Ago', fmtExpShort('2026-08-15') === '15Ago', fmtExpShort('2026-08-15'));
ok('A2 día de un dígito sin cero a la izquierda: 2026-08-03 → 3Ago', fmtExpShort('2026-08-03') === '3Ago', fmtExpShort('2026-08-03'));
ok('A3 enero: 2026-01-09 → 9Ene', fmtExpShort('2026-01-09') === '9Ene', fmtExpShort('2026-01-09'));
ok('A4 diciembre: 2026-12-31 → 31Dic', fmtExpShort('2026-12-31') === '31Dic', fmtExpShort('2026-12-31'));

// los 12 meses en orden
const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
let mesesOK = true, detalle = '';
for (let i = 0; i < 12; i++) {
  const mm = String(i + 1).padStart(2, '0');
  const got = fmtExpShort(`2026-${mm}-15`);
  const exp = '15' + MESES[i];
  if (got !== exp) { mesesOK = false; detalle += `${mm}:${got}!=${exp} `; }
}
ok('A5 los 12 meses mapean a su abreviatura ES', mesesOK, detalle);

// seguridad de timezone: parse manual, NUNCA construye Date() → no se corre de día
ok('A6 NO usa Date/getMonth/getDate (parse manual, sin timezone)', !/\bDate\b|getMonth|getUTCDate|getDate/.test(m[0]), m[0]);
// prueba dura: la vela de fin de mes en ET no debe saltar al mes siguiente
ok('A7 fin de mes no salta: 2026-07-31 → 31Jul', fmtExpShort('2026-07-31') === '31Jul', fmtExpShort('2026-07-31'));
ok('A8 primero de mes no retrocede: 2026-03-01 → 1Mar', fmtExpShort('2026-03-01') === '1Mar', fmtExpShort('2026-03-01'));

// bordes: entrada inválida no rompe (devuelve '' o el crudo, nunca throw)
let sinThrow = true;
try {
  ok('A9 null → cadena vacía', fmtExpShort(null) === '', JSON.stringify(fmtExpShort(null)));
  ok('A10 undefined → cadena vacía', fmtExpShort(undefined) === '', JSON.stringify(fmtExpShort(undefined)));
  ok('A11 mes fuera de rango → crudo (no inventa mes)', fmtExpShort('2026-13-01') === '2026-13-01', fmtExpShort('2026-13-01'));
  ok('A12 formato raro sin guiones → crudo', fmtExpShort('20260815') === '20260815', fmtExpShort('20260815'));
} catch (e) { sinThrow = false; }
ok('A13 ninguna entrada de borde tira excepción', sinThrow);

console.log('\n── B) etiquetas y leyenda (estructural sobre el HTML real) ──');
// OI cierre previo — las tres bocas donde se muestra OI
ok('B1 popup /contrato etiqueta OI como cierre previo (OCC T+1)',
   /OI:\s+\$\{e\.oi\}\s+\(cierre previo · OCC T\+1\)/.test(html) || /OI:\s+\$\{e\.oi\}\s{2,}\(cierre previo/.test(html), 'popup');
ok('B2 tooltip de la píldora etiqueta OI como (previo)', /· OI '\+e\.oi\+' \(previo\)/.test(html), 'tooltip');
ok('B3 nota del panel GEX/Max Pain declara OI cierre previo (OCC T+1)', /OI cierre previo \(OCC T\+1\)/.test(html) && /opt-note/.test(html), 'panel');

// la píldora ahora arma la fecha con fmtExpShort(e.expiration)
ok('B4 la píldora arma la fecha con fmtExpShort(e.expiration)', /\+e\.strike\+' · '\+fmtExpShort\(e\.expiration\)\+'/.test(html), 'pill');

// leyenda: dos entradas nuevas
ok('B5 leyenda: entrada "Contrato sugerido (píldora)"', /<strong>Contrato sugerido \(píldora\)<\/strong>/.test(html), 'legend');
ok('B6 leyenda: entrada "Salida theta-aware"', /<strong>Salida theta-aware<\/strong>/.test(html), 'legend');
ok('B7 leyenda de la salida es honesta ("guía, no promesa")', /guía, no promesa/.test(html), 'legend');

// cabeceras viejas ya corregidas: ninguna afirmación "Black-Scholes/BS" como fuente primaria de la gamma
ok('B8 comentario del panel GEX ya dice OPRA nativa (no Black-Scholes)',
   /GEX \/ MAX PAIN \(opciones reales, griegas OPRA nativas/.test(html) && !/opciones reales, Black-Scholes/.test(html), 'header');
ok('B9 comentario del loader de opciones ya dice OPRA nativa (no BS)',
   /GEX \/ Max Pain, OPRA nativa\)/.test(html) && !/GEX \/ Max Pain, BS\)/.test(html), 'header');

// pulido = DISPLAY: no aparece ninguna referencia a score/Governor en lo tocado
ok('B10 el pulido no introdujo gates de score en el readout', !/updateContractReadout[\s\S]*?score\s*>=?\s*7/.test(html.slice(html.indexOf('function updateContractReadout'), html.indexOf('window.updateContractReadout'))), 'no-score');

console.log(`\n${fail === 0 ? '✅' : '❌'} bench_pulido_s75: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
