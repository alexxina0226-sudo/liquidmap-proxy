// bench_monitor_estructura.js — juez del trasplante s61 (monitor → detector canónico v2)
// Extrae detectStructure del MONITOR REAL modificado y verifica:
//  (a) fidelidad al módulo canónico (evento vigente → type/label/plus)
//  (b) anti-regresión: continuación bajista = BOS_SELL, NUNCA CHOCH_SELL (el bug viejo)
//  (c) fallback honesto: sin módulo → null (capa apagada, no detector viejo)
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/monitor_bolsa.js', 'utf8');
const mod = require(__dirname + '/detectStructure_v2.js');

const i0 = src.indexOf('function detectStructure(');
let d = 0, i = src.indexOf('{', i0), j = i;
for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) break; } }
const body = src.slice(i0, j + 1);
const makeFn = v2 => { let detectStructureV2 = v2; let f; eval('f = ' + body); return f; };
const fn = makeFn(mod.detectStructure_v2);
const fnSinModulo = makeFn(null);

const B = (o, h, l, c) => ({ o, h, l, c, v: 1000 });
function hill(b, t) { return [B(b,b+1,b-1,b+1),B(b+1,t-1,b,t-1),B(t-1,t,b+2,t-0.5),B(t-1,t-1,b+1,b+2),B(b+2,b+3,b,b+1)]; }
function valley(b, bo) { return [B(b,b+1,b-1,b-1),B(b-1,b,bo+1,bo+1),B(bo+1,b-2,bo,bo+0.5),B(bo+1,bo+1,b-1,b-2),B(b-2,b,b-3,b-1)]; }
const pad = bars => { const out=[...bars]; while(out.length<30) out.unshift(B(100,101,99,100)); return out; };
// picos puntiagudos (dominancia estricta 5/5) para disparar giros reales en L=5
function spikeH(base, top){ const out=[]; for(let k=0;k<5;k++){ const v=base+(top-2-base)*(k/4); out.push(B(v,v+0.3,v-0.6,v)); } out.push(B(top-1.5,top,top-2.5,top-1)); for(let k=4;k>=0;k--){ const v=base+(top-2-base)*(k/4); out.push(B(v,v+0.3,v-0.6,v)); } return out; }
function spikeL(base, bot){ const out=[]; for(let k=0;k<5;k++){ const v=base-(base-(bot+2))*(k/4); out.push(B(v,v+0.6,v-0.3,v)); } out.push(B(bot+1.5,bot+2.5,bot,bot+1)); for(let k=4;k>=0;k--){ const v=base-(base-(bot+2))*(k/4); out.push(B(v,v+0.6,v-0.3,v)); } return out; }
const close5 = (p,n=3)=>{ const o=[]; for(let k=0;k<n;k++) o.push(B(p,p+0.5,p-0.5,p)); return o; };

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '\u2713 '.padStart(4) : '\u2717 '.padStart(4)) + n); };

// escenarios (mismas familias que el banco del mapa + giros reales en L=5)
const tendAlc  = pad([...hill(100,110),...valley(105,95),...hill(100,120),...valley(110,105),...hill(112,130)]);
const giroAlcSimple = [...spikeH(100,118),...spikeL(104,96),...spikeH(96,110),...spikeL(100,88),...close5(92),B(92,109,91,108),B(108,112,107,111),B(111,113,110,112),...close5(112)];
const giroAlcPlus   = [...spikeH(100,118),...spikeL(104,96),...spikeH(96,110),...spikeL(100,88),...spikeH(92,102),...spikeL(94,90),...close5(94),B(94,111,93,110.5),B(110.5,114,110,112),B(112,115,111,113),...close5(113)];
const contBaj  = pad([...valley(110,100),...hill(104,107),...valley(103,90),...hill(94,97),...valley(93,80)]); // bajada que continúa

// (a) fidelidad: el wrapper reporta lo mismo que el evento vigente del módulo
for (const [name, bars] of [['tendencia alcista',tendAlc],['giro alcista simple',giroAlcSimple],['giro alcista soportado (CHoCH+)',giroAlcPlus],['continuación bajista',contBaj]]) {
  const w = fn(bars);
  const r = mod.detectStructure_v2(bars, { swingLen: 5, confirm: 2 });
  let exp = null;
  if (r.choch) exp = { type: r.choch.dir==='BULL'?'CHOCH_BUY':'CHOCH_SELL', plus: !!r.choch.plus };
  else if (r.bos) exp = { type: r.bos.dir==='BULL'?'BOS_BUY':'BOS_SELL' };
  const okFid = exp === null ? w === null
    : w && w.type === exp.type && (!exp.type.includes('CHOCH') || !!w.plus === exp.plus)
      && (!w.plus || w.label.includes('CHoCH+'));
  ok(`fidelidad al módulo — ${name} (${w ? w.type + (w.plus?'+':'') : 'null'})`, okFid);
}

// (b) anti-regresión del bug viejo: la continuación bajista JAMÁS es CHOCH_SELL
{
  const w = fn(contBaj);
  ok('anti-regresión: continuación bajista NO es CHOCH_SELL', !w || w.type !== 'CHOCH_SELL');
  ok('anti-regresión: continuación bajista es BOS_SELL (a favor)', !!w && w.type === 'BOS_SELL');
}

// (c) interfaz y fallback
ok('interfaz: priority 10 en CHoCH / 7 en BOS', (() => { const g=fn(giroAlcSimple), t=fn(tendAlc); return !!(g&&g.priority===10&&t&&t.priority===7); })());
ok('CHoCH+ llega con plus:true y label CHoCH+', (() => { const p=fn(giroAlcPlus); return !!(p&&p.type==='CHOCH_BUY'&&p.plus&&p.label.includes('CHoCH+')); })());
ok('CHoCH simple llega con plus:false y label sin +', (() => { const s=fn(giroAlcSimple); return !!(s&&s.type==='CHOCH_BUY'&&!s.plus&&!s.label.includes('CHoCH+')); })());
ok('pocas velas (<30) → null', fn(pad([]).slice(0, 20)) === null);
ok('fallback honesto: sin módulo → null (capa apagada)', fnSinModulo(tendAlc) === null);

// (d) pesos del bump en la puntuación (código real del archivo)
ok('pesos 4H: BOS 3.0 · CHoCH+ 2.0 · CHoCH 1.5', /struct4H\.plus \? 2\.0 : 1\.5\) : 3\.0/.test(src));
ok('pesos 1H: BOS 2.0 · CHoCH+ 1.0 · CHoCH 0.8', /struct1H\.plus \? 1\.0 : 0\.8\) : 2\.0/.test(src));
ok('detector viejo enterrado (sin banda 0.3%)', !src.includes('* 1.003') && !src.includes('* 0.997'));

console.log('\nRESULTADO: ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
