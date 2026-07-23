// ════════════════════════════════════════════════════════════════════
//  bench_poc_canonico.js — s64 · 23-jul-2026
//  Banco del PERFIL DE VOLUMEN canónico del mapa. Corre sobre el CÓDIGO
//  REAL extraído del HTML: buildVP / pocIndex / getPOC / getVA /
//  pocSourceBars. No reimplementa nada del mapa.
//
//  Juez de exactitud: se genera un CAMINO DE TICKS donde sabemos por
//  construcción dónde se operó el volumen. El POC verdadero sale de los
//  ticks; las velas se agregan a partir del mismo camino. Gana el método
//  que más se acerca a la verdad, no el que confirme la hipótesis.
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
  grabConst(html, 'POC_WIN_BARS'), grabConst(html, 'POC_ROWS'), grabConst(html, 'POC_W_CUERPO'),
  grab('function pocSourceBars(candles, tf){', html),
  grab('function buildVP(bars,n){', html),
  grab('function pocIndex(v){', html),
  grab('function getPOC(v){', html),
  grab('function getVA(v){', html),
  'return {POC_WIN_BARS,POC_ROWS,POC_W_CUERPO,pocSourceBars,buildVP,pocIndex,getPOC,getVA};',
].join('\n');
function montar(vpBarsFake) {
  let vpBars = vpBarsFake || [];
  const filterRTH = b => b;
  return new Function('vpBars', 'filterRTH', piezas)(vpBars, filterRTH);
}
const M = montar();

// ── el método VIEJO, para comparar ──────────────────────────────────
function vpViejo(bars, n) {
  const mn = Math.min(...bars.map(b => b.l)), mx = Math.max(...bars.map(b => b.h));
  const bs = (mx - mn) / n, p = new Array(n).fill(0);
  for (const b of bars) { p[Math.max(0, Math.min(n - 1, Math.floor((b.c - mn) / bs)))] += b.v || 0; }
  return { profile: p, min: mn, max: mx, binSize: bs };
}

console.log('\n── CONTRATO (nada de lo que ya consumía el perfil se rompe) ──');
{
  const b = [{ t: 1, o: 10, h: 12, l: 9, c: 11, v: 100 }, { t: 2, o: 11, h: 13, l: 10, c: 12, v: 200 }];
  const v = M.buildVP(b, 60);
  ok('devuelve {profile,min,max,binSize}', v && Array.isArray(v.profile) && v.profile.length === 60 && v.min === 9 && v.max === 13);
  ok('getVA sigue devolviendo {vah,val}', (() => { const a = M.getVA(v); return a && typeof a.vah === 'number' && typeof a.val === 'number'; })());
  ok('serie vacía → null (los consumidores ya lo guardan)', M.buildVP([], 60) === null);
  ok('serie plana (max=min) → null, no NaN', M.buildVP([{ t: 1, o: 5, h: 5, l: 5, c: 5, v: 9 }], 60) === null);
  ok('volumen sin dato no rompe', M.buildVP([{ t: 1, o: 1, h: 2, l: 1, c: 2 }], 60) !== undefined);
}

console.log('\n── CONSERVACIÓN DEL VOLUMEN ──');
{
  const b = []; let p = 100;
  for (let i = 0; i < 50; i++) { const o = p; p += (i % 7) - 3; b.push({ t: i, o, c: p, h: Math.max(o, p) + 2, l: Math.min(o, p) - 2, v: 1000 + i }); }
  const v = M.buildVP(b, 60);
  const tot = v.profile.reduce((a, x) => a + x, 0);
  const real = b.reduce((a, x) => a + x.v, 0);
  ok('el perfil conserva el volumen total (no inventa ni pierde)', Math.abs(tot - real) < 1e-6, `perfil ${tot.toFixed(2)} vs real ${real}`);
}

console.log('\n── REPARTO POR RANGO (el arreglo de fondo) ──');
{
  // una sola vela que cruza todo el rango: su volumen debe quedar repartido, no en un punto
  const v = M.buildVP([{ t: 1, o: 10, h: 20, l: 10, c: 20, v: 6000 }], 60);
  const vivos = v.profile.filter(x => x > 0).length;
  ok('una vela ancha ocupa TODAS las filas que toca', vivos === 60, 'filas con volumen: ' + vivos);
  ok('el cuerpo pesa más que las mechas (reparto OHLC-proporcional)', (() => {
    const b2 = [{ t: 1, o: 14, h: 20, l: 10, c: 16, v: 6000 }];
    const w = M.buildVP(b2, 60), f = x => Math.floor((x - w.min) / w.binSize);
    return w.profile[f(15)] > w.profile[f(11)] && w.profile[f(11)] > 0;
  })(), 'el cuerpo debe pesar más, y la mecha NO debe quedar en cero');
  ok('POC_W_CUERPO declarado en 0.70', Math.abs(M.POC_W_CUERPO - 0.70) < 1e-9, M.POC_W_CUERPO);
}
{
  // el nivel que el precio cruza siempre pero donde nadie cierra
  const b = [];
  for (let i = 0; i < 60; i++) { const c = i % 2 ? 105 : 95; b.push({ t: i, o: c, h: 106, l: 94, c, v: 1000 }); }
  const vNuevo = M.buildVP(b, 60), vViejo = vpViejo(b, 60);
  const filaDe = (v, precio) => Math.floor((precio - v.min) / v.binSize);
  ok('el nivel más transitado ($100) ahora TIENE volumen', vNuevo.profile[filaDe(vNuevo, 100)] > 0);
  ok('con el método viejo ese nivel era invisible (volumen 0)', vViejo.profile[filaDe(vViejo, 100)] === 0);
}

console.log('\n── DESEMPATE CANÓNICO DEL POC ──');
{
  // dos filas empatadas: gana la más cercana al medio del rango
  const v = { profile: new Array(11).fill(0), min: 0, max: 11, binSize: 1 };
  v.profile[1] = 50; v.profile[6] = 50;
  ok('empate → gana la fila más cercana al medio', M.pocIndex(v) === 6, 'idx=' + M.pocIndex(v));
  const v2 = { profile: new Array(11).fill(0), min: 0, max: 11, binSize: 1 };
  v2.profile[3] = 50; v2.profile[7] = 50;   // equidistantes de mid=5
  ok('equidistantes → gana la de abajo', M.pocIndex(v2) === 3, 'idx=' + M.pocIndex(v2));
  ok('getVA arranca desde el MISMO POC (una sola verdad)', (() => {
    const a = M.getVA(v); return a.val <= M.getPOC(v) && a.vah >= M.getPOC(v);
  })());
}

console.log('\n── VENTANA ÚNICA (se acabó el parche por ticker) ──');
{
  ok('POC_WIN_BARS = 100 (= i_poc_len del Pine v6.1)', M.POC_WIN_BARS === 100, M.POC_WIN_BARS);
  ok('POC_ROWS declarado', M.POC_ROWS === 60, M.POC_ROWS);
  const b = []; for (let i = 0; i < 400; i++) b.push({ t: i, o: 1, h: 2, l: 1, c: 1, v: 1 });
  const tfs = ['5', '15', '60', 'D'];
  const largos = tfs.map(tf => M.pocSourceBars(b, tf).length);
  ok('TODOS los TF usan la misma ventana de 100', largos.every(l => l === 100), largos.join('/'));
  ok('las constantes viejas {156,104,130,60} ya no están en el HTML',
    !/'5':156|'15':104|'60':130/.test(html));
  ok('serie más corta que la ventana → se usa entera', M.pocSourceBars(b.slice(0, 30), '15').length === 30);
}

console.log('\n── MAGNIFICACIÓN EN 4H (resolución gratis) ──');
{
  const velas4H = []; for (let i = 0; i < 120; i++) velas4H.push({ t: 1000 + i * 100, o: 1, h: 2, l: 1, c: 1, v: 1 });
  const finas1H = []; for (let i = 0; i < 1200; i++) finas1H.push({ t: 1000 + i * 10, o: 1, h: 2, l: 1, c: 1, v: 1 });
  const M2 = montar(finas1H);
  const src = M2.pocSourceBars(velas4H, '240');
  const win = velas4H.slice(-100);
  ok('en 4H el perfil usa las velas finas, no las de sesión', src.length > win.length, src.length + ' vs ' + win.length);
  ok('y solo las que caen dentro de la ventana', src.every(b => b.t >= win[0].t));
  ok('sin velas finas disponibles → cae a las 100 de sesión (fail-open)',
    montar([]).pocSourceBars(velas4H, '240').length === 100);
  ok('los demás TF NO magnifican', M2.pocSourceBars(velas4H, '15').length === 100);
}

console.log('\n── EXACTITUD CONTRA LA VERDAD DE LOS TICKS ──');
{
  function camino(seed, rallyFrac) {
    let s = seed; const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const t = []; let p = 100;
    const nb = Math.round(9000 * (1 - rallyFrac));
    for (let i = 0; i < nb; i++) { p += (r() - 0.5) * 0.8; p += (100 - p) * 0.05; t.push({ p, v: 10 }); }
    for (let i = 0; i < 9000 - nb; i++) { p += 0.03 + (r() - 0.45) * 0.6; t.push({ p, v: 10 }); }
    return t;
  }
  const verdad = (t, n) => {
    const mn = Math.min(...t.map(x => x.p)), mx = Math.max(...t.map(x => x.p));
    const bs = (mx - mn) / n, p = new Array(n).fill(0);
    for (const x of t) p[Math.max(0, Math.min(n - 1, Math.floor((x.p - mn) / bs)))] += x.v;
    return mn + p.indexOf(Math.max(...p)) * bs + bs / 2;
  };
  const aVelas = (t, k) => { const o = []; for (let i = 0; i < t.length; i += k) { const g = t.slice(i, i + k); if (!g.length) continue; o.push({ t: i, o: g[0].p, c: g[g.length - 1].p, h: Math.max(...g.map(x => x.p)), l: Math.min(...g.map(x => x.p)), v: g.reduce((a, x) => a + x.v, 0) }); } return o; };
  const seeds = [7, 13, 29, 41, 57, 73, 91, 101, 113, 131];
  console.log('    vela      régimen    err VIEJO   err NUEVO   err NUEVO+magnif');
  let ganaNuevo = 0, total = 0;
  for (const rf of [0.15, 0.35]) {
    for (const k of [300, 900]) {
      let ev = 0, en = 0, em = 0;
      for (const s of seeds) {
        const t = camino(s, rf), V = verdad(t, 60);
        const gruesas = aVelas(t, k), finas = aVelas(t, Math.max(10, Math.round(k / 4)));
        ev += Math.abs(M.getPOC(vpViejo(gruesas, 60)) - V);
        en += Math.abs(M.getPOC(M.buildVP(gruesas, 60)) - V);
        em += Math.abs(M.getPOC(M.buildVP(finas, 60)) - V);
      }
      const [a, b, c] = [ev / seeds.length, en / seeds.length, em / seeds.length];
      total++; if (c <= a + 1e-9) ganaNuevo++;
      console.log(`    ${String(k).padStart(4)}t  ${(rf === 0.15 ? 'lateral' : 'rally  ')}    ${('$' + a.toFixed(2)).padStart(9)}   ${('$' + b.toFixed(2)).padStart(9)}   ${('$' + c.toFixed(2)).padStart(17)}`);
    }
  }
  ok('el POC nuevo nunca es peor que el viejo', ganaNuevo === total, ganaNuevo + '/' + total);
}

console.log('\n── ANTI-REGRESIÓN ──');
{
  ok('el binning por cierre ya no existe en el HTML', !/p\[Math\.max\(0,Math\.min\(n-1,Math\.floor\(\(b\.c-mn\)\/bs\)\)\)\]\s*\+=/.test(html));
  ok('el call site usa pocSourceBars + POC_ROWS', /buildVP\(pocSourceBars\(candles, tf\), POC_ROWS\)/.test(html));
  ok('getVA sigue siendo el 70% real (no ±35% del rango)', /tot\*\.70/.test(html) && !/p_rng\s*\*\s*0\.35/.test(html));
  ok('pocWindowBars sigue existiendo como alias (nada viejo se rompe)', typeof M.pocSourceBars === 'function' && /function pocWindowBars\(candles, tf\)\{ return pocSourceBars/.test(html));
}

console.log(`\n${'═'.repeat(52)}\n  RESULTADO: ${pass}/${pass + fail}` + (fail ? `  · ${fail} FALLAN` : '  · TODO VERDE') + `\n${'═'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);
