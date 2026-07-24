const fs=require('fs');
const h=fs.readFileSync('LiquidityMap_BOLSA_v5.html','utf8');
let p=0,f=0;const ok=(n,c,x)=>{if(c){p++;console.log('  ✓ '+n)}else{f++;console.log('  ✗ '+n+(x?'  → '+x:''))}};

console.log('\n── EL DIAGNÓSTICO EXISTE Y ES ALCANZABLE ──');
ok('pocDiag declarada', /function pocDiag\(\)\{/.test(h));
ok('expuesta en window (para consola)', /window\.pocDiag = pocDiag;/.test(h));
ok('atajo Ctrl+Shift+L', /e\.ctrlKey && e\.shiftKey && \(e\.key==='L'\|\|e\.key==='l'\)/.test(h));
ok('comando /POC por la casilla TICKER', /if\(s==='\/POC'\)\{ inp\.value=''; pocDiag\(\); return; \}/.test(h));
ok('comando /ADX tambien (el que ya existia, ahora sin F12)', /if\(s==='\/ADX'\)\{ inp\.value=''; adxDiag\(\); return; \}/.test(h));

console.log('\n── NO ROMPE EL ALTA DE TICKERS ──');
{
  const body=h.match(/function addSymbol\(\)\{[\s\S]*?\n\}/)[0];
  ok('los comandos salen ANTES de crear el boton', body.indexOf("'/POC'") < body.indexOf('createSymBtn'));
  ok('un ticker normal sigue su camino', /createSymBtn\(s,false\); saveSymbols\(\);/.test(body));
  ok('limpia la casilla en los tres caminos', (body.match(/inp\.value=''/g)||[]).length===3);
}

console.log('\n── MIDE LO QUE HAY QUE MEDIR ──');
{
  const d=h.match(/function pocDiag\(\)\{[\s\S]*?\n\}\nwindow\.pocDiag/)[0];
  for(const [n,re] of [
    ['usa pocSourceBars (la fuente REAL del perfil)', /pocSourceBars\(cs, tf\)/],
    ['cuenta velas por hora ET', /porHora\[k\] = \(porHora\[k\]\|\|0\)\+1/],
    ['cuenta dias distintos', /new Set\(src\.map\(b=>etD\(b\.t\)\)\)\.size/],
    ['reporta velas por dia', /src\.length\/dias/],
    ['reporta POC, VAH y VAL', /getPOC\(vp\)[\s\S]*?getVA\(vp\)/],
    ['reporta la fuerza del iman y el piso plano', /Math\.max\(\.\.\.vp\.profile\)\/tot\*100/],
    ['declara las 3 constantes en uso', /POC_WIN_BARS[\s\S]*?POC_ROWS[\s\S]*?POC_W_CUERPO/],
    ['detecta si el 4H magnifico', /magnif/],
    ['imprime primera y ultima vela con fecha ET', /primera del perfil[\s\S]*?última del perfil/],
  ]) ok(n, re.test(d));
  ok('VEREDICTO: canta si falta la hora de apertura', /FALTA la hora de apertura/.test(d) && /horas\.includes\('09'\)/.test(d));
  ok('el veredicto solo aplica a intradia', /const intradia = \(tf==='5'\|\|tf==='15'\|\|tf==='60'\)/.test(d));
  ok('es display-only: no toca vp, candles ni el score', !/\bvp\s*=|\bcandles\s*=|score\s*[+]=/.test(d));
  ok('falla suave (try/catch, como adxDiag)', /catch\(e\)\{ alert\('pocDiag error/.test(d));
}

console.log('\n── EL RESTO SIGUE INTACTO ──');
for(const [n,re] of [['adxDiag no fue tocada',/function adxDiag\(\)\{/],['su atajo Ctrl+Shift+D sigue',/e\.key==='D'\|\|e\.key==='d'/],
 ['POC canonico intacto',/const POC_W_CUERPO = 0\.70;/],['tgGate intacta',/function tgGate\(\)/],['Governor intacto',/function governConviction/]])
  ok(n,re.test(h));

console.log(`\n${'═'.repeat(50)}\n  BENCH pocDiag: ${p}/${p+f}`+(f?`  · ${f} FALLAN`:'  · TODO VERDE')+`\n${'═'.repeat(50)}\n`);
process.exit(f?1:0);
