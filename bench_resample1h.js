// ════════════════════════════════════════════════════════════════════
//  bench_resample1h.js — s67 · 24-jul-2026
//  Banco del RESAMPLE 1H ANCLADO A 9:30 (Opción B = TV). Corre sobre el
//  CÓDIGO REAL extraído del HTML: resampleSessionHourly + filterRTH +
//  buildVP/pocIndex/getPOC. No reimplementa el resample del mapa.
//
//  Hipótesis probada en vivo con /poc (MU 1H: velas/día 5.88, sin la hora
//  09): las 1H nativas de Alpaca vienen EN PUNTO (9:00,…) y filterRTH tira
//  entera la vela de 9:00 = la HORA DE APERTURA. El fix reconstruye las 1H
//  ancladas a 9:30 desde 15m, como TV. El banco demuestra:
//   (1) la hora de apertura VUELVE, (2) el path viejo la pierde (contraste),
//   (3) conservación de volumen y OHLCV correcta, (4) el POC se corrige.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'LiquidityMap_BOLSA_v5.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

function grab(header, src) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error('no encontré: ' + header);
  let d = 0, s = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; s = true; } else if (c === '}') { d--; if (s && d === 0) return src.slice(i, j + 1); }
  }
}
function grabConst(src, n) {
  const m = src.match(new RegExp('^const\\s+' + n + '\\s*=[^;\\n]*;', 'm'));
  if (!m) throw new Error('no encontré const: ' + n);
  return m[0];
}

// ── montaje del código real ─────────────────────────────────────────
const piezas = [
  grabConst(html, 'POC_ROWS'), grabConst(html, 'POC_W_CUERPO'), grabConst(html, '_rthFmt'),
  grab('function resampleSessionHourly(bars){', html),
  grab('function filterRTH(bars){', html),
  grab('function buildVP(bars,n){', html),
  grab('function pocIndex(v){', html),
  grab('function getPOC(v){', html),
  'return {resampleSessionHourly,filterRTH,buildVP,pocIndex,getPOC,POC_ROWS,POC_W_CUERPO};',
].join('\n');
const M = new Function(piezas)();
const { resampleSessionHourly, filterRTH, buildVP, pocIndex, getPOC } = M;

// ── generador de 15m con hora ET conocida (julio 2026 = EDT = UTC-4) ─────────
// ET wall-clock → epoch seg: UTC = ET + 4h en verano.
const etSec = (y, mo, d, hh, mm) => Math.floor(Date.UTC(y, mo - 1, d, hh + 4, mm, 0) / 1000);
const etHourMin = t => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const p = f.formatToParts(new Date(t * 1000));
  let hh = parseInt(p.find(x => x.type === 'hour').value, 10); if (hh === 24) hh = 0;
  const mm = parseInt(p.find(x => x.type === 'minute').value, 10);
  return { hh, mm };
};

// Un día de 15m: pre (9:00,9:15) + RTH (9:30..15:45) + post (16:00,16:15).
// volAt(hh,mm) decide el volumen por barra; priceAt idem el precio (para el POC).
function dia15m(y, mo, d, volAt, priceAt) {
  const out = [];
  const push = (hh, mm) => {
    const px = priceAt(hh, mm);
    out.push({ t: etSec(y, mo, d, hh, mm), o: px, h: px + 0.2, l: px - 0.2, c: px, v: volAt(hh, mm) });
  };
  push(9, 0); push(9, 15);                                  // pre-market
  for (let mins = 570; mins < 960; mins += 15) push(Math.floor(mins / 60), mins % 60); // 9:30..15:45
  push(16, 0); push(16, 15);                                // post-market
  return out;
}

// Serie de 3 días. Volumen: la APERTURA (9:30–10:30) concentra el nodo; el resto del día,
// menos. Precio: la apertura opera cerca de 100; el resto del día deriva a ~110.
const volAt = (hh, mm) => {
  const mins = hh * 60 + mm;
  if (mins < 570 || mins >= 960) return 1234;               // pre/post: NO debe entrar al perfil
  if (mins < 630) return 900;                               // 9:30–10:30 (4 barras) = nodo gordo
  return 100;                                               // resto del día
};
const priceAt = (hh, mm) => {
  const mins = hh * 60 + mm;
  if (mins < 630) return 100;                               // apertura ~100 (el nodo verdadero)
  return 110;                                               // resto ~110
};
const s15 = [
  ...dia15m(2026, 7, 21, volAt, priceAt),
  ...dia15m(2026, 7, 22, volAt, priceAt),
  ...dia15m(2026, 7, 23, volAt, priceAt),
].sort((a, b) => a.t - b.t);

const H = resampleSessionHourly(s15);

console.log('\n── CONTRATO / estructura del fix ──');
{
  ok('resampleSessionHourly existe y es función', typeof resampleSessionHourly === 'function');
  ok('entrada vacía → []', Array.isArray(resampleSessionHourly([])) && resampleSessionHourly([]).length === 0);
  ok('null → []', resampleSessionHourly(null).length === 0);
  // la config del 1H pide 15m, no 1H nativas
  const cfg1h = /is1H\s*\?\s*\{mult:15,\s*span:'minute'/.test(html);
  ok('loadCandles: el 1H pide 15m (mult:15 span:minute)', cfg1h);
  // la rama 1H llama al resample nuevo
  ok('loadCandles: la rama is1H usa resampleSessionHourly', /is1H\)\{[\s\S]*?resampleSessionHourly\(raw\)/.test(html));
  const m1h = html.match(/else if\(is1H\)\{([\s\S]*?)\} else \{/);
  ok('loadCandles: la rama is1H NO filtra RTH sobre las horarias', !!m1h && !/filterRTH/.test(m1h[1]));
}

console.log('\n── LA HORA DE APERTURA VUELVE (corazón del fix) ──');
{
  const dias = new Set(H.map(b => { const { hh } = etHourMin(b.t); return null; })); // placeholder
  // velas por día = 7 (9:30,10:30,11:30,12:30,13:30,14:30,15:30) en cada día lleno
  const porDiaMap = {};
  for (const b of H) {
    const k = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(b.t * 1000));
    porDiaMap[k] = (porDiaMap[k] || 0) + 1;
  }
  const diasDistintos = Object.keys(porDiaMap).length;
  ok('3 días distintos', diasDistintos === 3, 'días=' + diasDistintos);
  const todos7 = Object.values(porDiaMap).every(n => n === 7);
  ok('7 cubos horarios por día (9:30…15:30)', todos7, JSON.stringify(porDiaMap));
  // la hora 09 ESTÁ presente (el primer cubo de cada día arranca a las 9:30)
  const horas = H.map(b => etHourMin(b.t));
  const hay09 = horas.some(x => x.hh === 9 && x.mm === 30);
  ok('la hora de apertura (09:30) ESTÁ en el resultado', hay09);
  const nDe09 = horas.filter(x => x.hh === 9).length;
  ok('exactamente 1 cubo de apertura por día (3 cubos hh=09)', nDe09 === 3, 'n=' + nDe09);
  // el primer cubo del primer día es 9:30 ET exacto
  const first = etHourMin(H[0].t);
  ok('primer cubo = 9:30 ET', first.hh === 9 && first.mm === 30, JSON.stringify(first));
}

console.log('\n── CONTRASTE: el path VIEJO pierde la apertura (el bug) ──');
{
  // Simulo las 1H NATIVAS de Alpaca (en punto: 9:00,10:00,…,15:00) de un día,
  // y les aplico el filterRTH REAL. La de 9:00 (mins 540) se cae → sin hora 09.
  const enPunto = [];
  for (let hh = 9; hh <= 15; hh++) enPunto.push({ t: etSec(2026, 7, 21, hh, 0), o: 100, h: 100.5, l: 99.5, c: 100, v: 500 });
  const viejo = filterRTH(enPunto);
  const horasViejo = viejo.map(b => etHourMin(b.t).hh);
  ok('path viejo: filterRTH DESCARTA la vela de las 9:00', !horasViejo.includes(9), 'quedaron ' + JSON.stringify(horasViejo));
  ok('path viejo: quedan 6 velas (10..15), no 7', viejo.length === 6, 'n=' + viejo.length);
  ok('path nuevo tiene la apertura que el viejo perdió', H.some(b => etHourMin(b.t).hh === 9) && !horasViejo.includes(9));
}

console.log('\n── AGREGACIÓN OHLCV correcta ──');
{
  // Primer cubo (9:30–10:30) del día 1 = agrega 9:30,9:45,10:00,10:15 (4 barras de 15m).
  const cubo0 = H[0];
  const src0 = s15.filter(b => { const { hh, mm } = etHourMin(b.t); const m = hh * 60 + mm; return b.t >= etSec(2026, 7, 21, 0, 0) && b.t < etSec(2026, 7, 22, 0, 0) && m >= 570 && m < 630; });
  ok('cubo apertura agrega 4 barras de 15m', src0.length === 4, 'n=' + src0.length);
  ok('cubo.o = open de la 1ª (9:30)', cubo0.o === src0[0].o);
  ok('cubo.c = close de la última (10:15)', cubo0.c === src0[src0.length - 1].c);
  ok('cubo.h = max de las 4', cubo0.h === Math.max(...src0.map(b => b.h)));
  ok('cubo.l = min de las 4', cubo0.l === Math.min(...src0.map(b => b.l)));
  ok('cubo.v = suma de las 4', cubo0.v === src0.reduce((a, b) => a + b.v, 0));

  // CONSERVACIÓN de volumen: suma de todos los cubos = suma de los 15m RTH (sin pre/post).
  const volCubos = H.reduce((a, b) => a + b.v, 0);
  const volRTH = s15.filter(b => { const { hh, mm } = etHourMin(b.t); const m = hh * 60 + mm; return m >= 570 && m < 960; }).reduce((a, b) => a + b.v, 0);
  ok('conservación de volumen (cubos = 15m RTH)', volCubos === volRTH, volCubos + ' vs ' + volRTH);
}

console.log('\n── FILTRADO RTH (pre/post-market fuera) ──');
{
  // ningún cubo contiene volumen de pre/post (v=1234 marcador)
  const preVol = 1234;
  const contamina = H.some(b => (b.v % preVol) === 0 && b.v >= preVol && b.v === preVol);
  ok('pre/post-market NO entra a ningún cubo', !contamina);
  // el último cubo de un día es 15:30 (media hora final), NO hay 16:00
  const horas = H.map(b => etHourMin(b.t));
  ok('no hay cubo a las 16:00 (post)', !horas.some(x => x.hh === 16));
  ok('el último cubo del día arranca 15:30', horas.some(x => x.hh === 15 && x.mm === 30));
  // ese último cubo agrupa 15:30 y 15:45 (2 barras)
  const cuboFin = H.filter(b => { const x = etHourMin(b.t); return x.hh === 15 && x.mm === 30; })[0];
  const srcFin = s15.filter(b => { const { hh, mm } = etHourMin(b.t); const m = hh * 60 + mm; return b.t >= etSec(2026, 7, 21, 0, 0) && b.t < etSec(2026, 7, 22, 0, 0) && m >= 930 && m < 960; });
  ok('cubo final (15:30–16:00) agrupa 2 barras de 15m', srcFin.length === 2 && cuboFin.v === srcFin.reduce((a, b) => a + b.v, 0));
}

console.log('\n── LÍMITES DE CUBO (slots anclados a 9:30) ──');
{
  // 10:15 pertenece al cubo 0 (9:30–10:30); 10:30 abre el cubo 1.
  const d1 = s15.filter(b => b.t >= etSec(2026, 7, 21, 0, 0) && b.t < etSec(2026, 7, 22, 0, 0));
  const H1 = resampleSessionHourly(d1);
  const cubosDeD1 = H1.map(b => etHourMin(b.t));
  const slotsEsperados = [[9, 30], [10, 30], [11, 30], [12, 30], [13, 30], [14, 30], [15, 30]];
  const okSlots = cubosDeD1.length === 7 && slotsEsperados.every((s, i) => cubosDeD1[i].hh === s[0] && cubosDeD1[i].mm === s[1]);
  ok('cubos anclados exactamente a :30 (9:30,10:30,…,15:30)', okSlots, JSON.stringify(cubosDeD1));
  // orden cronológico ascendente
  let asc = true; for (let i = 1; i < H.length; i++) if (H[i].t <= H[i - 1].t) asc = false;
  ok('salida en orden cronológico ascendente', asc);
}

console.log('\n── EFECTO DOWNSTREAM EN EL POC (por qué importa) ──');
{
  // Nodo de volumen fuerte en la apertura (~100). El path NUEVO ve la apertura → POC ~100.
  // El path VIEJO (sin apertura) la pierde → POC se corre a ~110 (la acción del resto del día),
  // replicando el síntoma MU (992 pegado al precio vs 929 el nodo real).
  const vpNuevo = buildVP(H, M.POC_ROWS);
  const pocNuevo = getPOC(vpNuevo);
  ok('POC del path NUEVO cae sobre el nodo de apertura (~100)', Math.abs(pocNuevo - 100) < 3, 'POC=' + pocNuevo.toFixed(2));

  // path viejo: 1H en punto → filterRTH → sin apertura. Reconstruyo horarias "viejas" con
  // el mismo contenido pero SIN la franja 9:30–10:30 (que vivía en la vela 9:00 descartada).
  const horariasViejas = H.filter(b => etHourMin(b.t).hh !== 9); // la apertura ya no está
  const vpViejo = buildVP(horariasViejas, M.POC_ROWS);
  const pocViejo = getPOC(vpViejo);
  ok('POC del path VIEJO se corre lejos del nodo (~110)', Math.abs(pocViejo - 110) < 3, 'POC=' + pocViejo.toFixed(2));
  ok('el fix mueve el POC hacia la verdad (nuevo≠viejo)', Math.abs(pocNuevo - pocViejo) > 5, 'Δ=' + Math.abs(pocNuevo - pocViejo).toFixed(2));
}

console.log('\n── ANTI-REGRESIÓN ──');
{
  // aplicar filterRTH real a las horarias resampleadas NO tira ninguna (todas en [570,960))
  const rf = filterRTH(H);
  ok('filterRTH sobre las horarias 9:30 no descarta ninguna (doble-filtrado inofensivo)', rf.length === H.length);
  // idempotencia: resamplear dos veces la MISMA entrada da lo mismo
  const H2 = resampleSessionHourly(s15);
  ok('determinista (misma entrada → misma salida)', JSON.stringify(H) === JSON.stringify(H2));
}

console.log('\n' + (fail === 0 ? '✅' : '❌') + '  bench_resample1h: ' + pass + '/' + (pass + fail) + '  (fail=' + fail + ')');
process.exit(fail === 0 ? 0 : 1);
