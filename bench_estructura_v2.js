// bench_estructura_v2.js — juez imparcial de la CAPA SWING canónica
// Escenarios sintéticos con estructura CONOCIDA por definición ICT.
// swingLen=2 en el banco: prueba la LÓGICA (la fuerza del pivote es calibración aparte).
const { detectStructure_v2 } = require('/home/claude/detectStructure_v2.js');

let pass=0, fail=0;
const ok=(name,cond)=>{ cond?pass++:fail++; console.log((cond?'  \u2713 ':'  \u2717 ')+name); };
const B=(o,h,l,c)=>({o,h,l,c,v:1000});
// pivote nítido: sube a 'top' y baja — con L=2 el pivote confirma 2 velas después
function hill(base,top){ return [B(base,base+1,base-1,base+1),B(base+1,top-1,base,top-1),B(top-1,top,base+2,top-0.5),B(top-1,top-1,base+1,base+2),B(base+2,base+3,base,base+1)]; }
function valley(base,bot){ return [B(base,base+1,base-1,base-1),B(base-1,base,bot+1,bot+1),B(bot+1,base-2,bot,bot+0.5),B(bot+1,base-1,bot+1,base-2),B(base-2,base,base-3,base-1)]; }
const flat=(p,n)=>Array.from({length:n},()=>B(p,p+0.5,p-0.5,p));
const O={swingLen:2,confirm:1};

console.log('BENCH ESTRUCTURA v2 — capa swing canónica (BOS/CHoCH/CHoCH+/estado)');

// 1) init: primer break alcista desde neutro = BOS (establece tendencia), NO CHoCH
{ let bars=[...hill(100,110),...flat(105,4)];
  for(let c=106;c<=114;c+=2) bars.push(B(c-1,c+1,c-2,c));           // cierra sobre 110
  const r=detectStructure_v2(bars,O);
  ok('init alcista → BOS (no CHoCH), trend=+1', r.trend===1 && r.bos && r.bos.dir==='BULL' && !r.choch && r.events.every(e=>e.type!=='CHoCH')); }

// 2) continuación: HH sucesivos = BOS repetidos, cero CHoCH
{ let bars=[...hill(100,110)]; for(let c=106;c<=114;c+=2) bars.push(B(c-1,c+1,c-2,c));
  bars.push(...hill(112,120)); for(let c=117;c<=125;c+=2) bars.push(B(c-1,c+1,c-2,c));
  const r=detectStructure_v2(bars,O);
  const boses=r.events.filter(e=>e.type==='BOS'||e.type==='BOS_init').length;
  ok('continuación → 2+ BOS, 0 CHoCH, trend=+1', boses>=2 && r.events.every(e=>e.type!=='CHoCH') && r.trend===1); }

// 3) CHoCH leading: alcista rompe el último SL SIN lower-high previo → CHoCH sin plus
{ let bars=[...hill(100,110)]; for(let c=106;c<=114;c+=2) bars.push(B(c-1,c+1,c-2,c)); // trend +1
  bars.push(...valley(112,108));                                     // SL en 108
  for(let c=107;c>=101;c-=2) bars.push(B(c+1,c+2,c-1,c));            // cierra bajo 108
  const r=detectStructure_v2(bars,O);
  const ch=r.events.find(e=>e.type==='CHoCH');
  ok('giro sin aviso → CHoCH BEAR leading (plus=false), trend=-1', ch && ch.dir==='BEAR' && ch.plus===false && r.trend===-1); }

// 4) CHoCH+: alcista hace LOWER-HIGH y recién ahí rompe el SL → CHoCH+ (plus=true)
{ let bars=[...hill(100,110)]; for(let c=106;c<=114;c+=2) bars.push(B(c-1,c+1,c-2,c)); // trend +1
  bars.push(...valley(112,108));                                     // SL 108
  bars.push(...hill(109,112));                                       // SH 112 < SH previo ⇒ lower-high
  for(let c=107;c>=101;c-=2) bars.push(B(c+1,c+2,c-1,c));            // rompe 108
  const r=detectStructure_v2(bars,O);
  const ch=r.events.find(e=>e.type==='CHoCH');
  ok('lower-high + break → CHoCH+ BEAR (plus=true)', ch && ch.dir==='BEAR' && ch.plus===true && r.trend===-1); }

// 5) ida y vuelta: CHoCH bajista y después CHoCH alcista → estado termina +1
{ let bars=[...hill(100,110)]; for(let c=106;c<=114;c+=2) bars.push(B(c-1,c+1,c-2,c));
  bars.push(...valley(112,108)); for(let c=107;c>=99;c-=2) bars.push(B(c+1,c+2,c-1,c)); // CHoCH bear
  bars.push(...hill(100,106));  for(let c=103;c<=111;c+=2) bars.push(B(c-1,c+1,c-2,c)); // CHoCH bull
  const r=detectStructure_v2(bars,O);
  const chs=r.events.filter(e=>e.type==='CHoCH');
  ok('doble giro → CHoCH BEAR luego CHoCH BULL, trend=+1', chs.length===2 && chs[0].dir==='BEAR' && chs[1].dir==='BULL' && r.trend===1); }

// 6) guard: pocas velas → salida vacía sin inventar
{ const r=detectStructure_v2(flat(100,4),O);
  ok('guard <2L+2 velas → sin eventos, trend=0', r.trend===0 && !r.choch && !r.bos && r.events.length===0); }

// 7) confirmación de cuerpo: la MECHA perfora el SH pero el cierre no → NO hay break
{ let bars=[...hill(100,110)];
  bars.push(B(105,111.5,104,106));                                   // mecha sobre 110, cierre 106
  bars.push(...flat(105,4));
  const r=detectStructure_v2(bars,O);
  ok('mecha sin cierre → no rompe (0 eventos)', r.events.length===0 && r.trend===0); }

// 8) confirm=2: un solo cierre no basta, el segundo sí (modo estricto del Pine)
{ let mk=()=>{ let bars=[...hill(100,110),...flat(105,3)]; bars.push(B(106,111,105,110.6)); return bars; };
  const r1=detectStructure_v2([...mk(),B(110,110.8,105,105.5),...flat(105,3)],{swingLen:2,confirm:2});
  const r2=detectStructure_v2([...mk(),B(110.6,112,110,111),...flat(111,3)],{swingLen:2,confirm:2});
  ok('confirm=2 → 1 cierre no dispara, 2 seguidos sí', r1.events.length===0 && r2.events.length===1 && r2.events[0].dir==='BULL'); }

console.log('\nRESULTADO: '+pass+'/'+(pass+fail));
process.exit(fail?1:0);
