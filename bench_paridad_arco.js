// bench_paridad_arco.js — banco de PARIDAD del arco del mapa bolsa vs Pine BOSWaves (s58)
// Dos frentes: (1) PARIDAD MECÁNICA — una referencia Pine-LITERAL (escrita aparte, en el
// orden exacto del original: vwaps → atr → init sin continue → cruce/flip → recolocación →
// avance por cadencia → smooth) debe flipear en las MISMAS velas que computeArcSeries del
// mapa; (2) INVARIANCIA DE VENTANA — el triángulo NO baila: correr el mapa con la ventana
// completa y con la ventana corrida N velas debe dar los MISMOS flips (por timestamp) en la
// zona madura común. Con la cadencia vieja (i % smooth) esto fallaba: cada recarga corría
// la fase y los flips de meseta se movían.
'use strict';
const fs = require('fs');
const html = fs.readFileSync('./bolsa.html','utf8');
function extract(name){
  const i = html.indexOf('function ' + name);
  if(i < 0) throw new Error('no encontré ' + name);
  let d = 0, j = html.indexOf('{', i);
  for(let k = j; k < html.length; k++){
    if(html[k]==='{') d++;
    else if(html[k]==='}'){ d--; if(d===0) return html.slice(i, k+1); }
  }
}
// código real del mapa: computeArcSeries + helpers de tz + ARC_DEFAULTS
const defLine = html.match(/const ARC_DEFAULTS = \{[\s\S]*?\};/)[0];
const toMsLine = "const _arcToMs = t => (t < 1e12 ? t * 1000 : t);";
const src = [defLine, toMsLine, extract('_arcTzFmt').replace('function _arcTzFmt','function _arcTzFmt'),
  "const _arcFmtCache = new Map();",
  extract('_arcTzFmt'), extract('_arcTzParts'), extract('_arcDayKey'), extract('_arcWeekKey'), extract('_arcMonthKey'),
  extract('computeArcSeries')].join('\n');
const mapArc = new Function(src + '; return computeArcSeries;')();

// ───────── referencia Pine-LITERAL (independiente, para cotejar al mapa) ─────────
const tzSrc = [toMsLine, "const _arcFmtCache = new Map();", extract('_arcTzFmt'), extract('_arcTzParts'),
  extract('_arcDayKey'), extract('_arcWeekKey'), extract('_arcMonthKey'),
  'return { _arcToMs, _arcDayKey, _arcWeekKey, _arcMonthKey };'].join('\n');
const TZ = new Function(tzSrc)();
function pineRef(candles, o){
  const n = candles.length;
  const tr = candles.map((c,i)=> i===0 ? c.h-c.l : Math.max(c.h-c.l, Math.abs(c.h-candles[i-1].c), Math.abs(c.l-candles[i-1].c)));
  const dts=[]; for(let i=1;i<Math.min(n,80);i++) dts.push(TZ._arcToMs(candles[i].t)-TZ._arcToMs(candles[i-1].t));
  dts.sort((a,b)=>a-b); const tfMs = dts[Math.floor(dts.length/2)];
  let trend=true, arc=NaN, velocity=0, initDone=false, atr14=null, trSum=0, atrSlow=null;
  let cPvS=0,cVS=0,vS=NaN,dK=null, cPvW=0,cVW=0,vW=NaN,wK=null, cPvM=0,cVM=0,vM=NaN,mK=null;
  const flips=[], trendSeries=new Array(n).fill(null);
  for(let i=0;i<n;i++){
    const c=candles[i], hl2=(c.h+c.l)/2, vol=c.v||0, tMs=TZ._arcToMs(c.t);
    const dk=TZ._arcDayKey(tMs,o.anchorTz), wk=TZ._arcWeekKey(tMs,o.anchorTz), mk=TZ._arcMonthKey(tMs,o.anchorTz);
    if(dk!==dK){cPvS=0;cVS=0;dK=dk;} if(wk!==wK){cPvW=0;cVW=0;wK=wk;} if(mk!==mK){cPvM=0;cVM=0;mK=mk;}
    cPvS+=hl2*vol;cVS+=vol;vS=cVS>0?cPvS/cVS:hl2; cPvW+=hl2*vol;cVW+=vol;vW=cVW>0?cPvW/cVW:hl2; cPvM+=hl2*vol;cVM+=vol;vM=cVM>0?cPvM/cVM:hl2;
    atr14=(i<14)?(i===13?tr.slice(0,14).reduce((a,b)=>a+b,0)/14:atr14):(atr14*13+tr[i])/14;
    trSum+=tr[i]; if(i>=100) trSum-=tr[i-100]; atrSlow=i>=99?trSum/100:null;
    const sSlow=atrSlow!==null&&atrSlow>0?atrSlow:1, sAtr=atr14!==null&&atr14>0?atr14:1;
    if(!initDone && atrSlow!==null && i>o.initBars){ arc=c.l-sSlow*o.startMult; trend=true; initDone=true; } // Pine: SIN continue
    if(!initDone) continue;
    const prev=trend;
    if(c.c<arc) trend=false;
    if(c.c>arc) trend=true;
    const flipped = trend!==prev;
    if(flipped){ arc = trend ? c.l-sSlow*o.startMult : c.h+sSlow*o.startMult; velocity=0;
      flips.push({ t:tMs, index:i, bull:trend }); }
    const refV = o.filterPeriod==='Week'?vW : o.filterPeriod==='Month'?vM : vS;   // Pine: refVwap
    const dn = Math.min(Math.abs(c.c-refV)/(sAtr*4), 1.0);
    const eff = o.accelRate*(1.0+(o.vwapAccelBoost-1.0)*dn);
    if(Math.floor(tMs/tfMs)%o.smooth===0){ velocity+=eff; arc+=(trend?1:-1)*sSlow*0.15*velocity; }
    trendSeries[i]=trend;
  }
  return { flips, trendSeries };
}

// velas sintéticas 1h estilo bolsa: RTH 9:30-16 ET aprox (7 velas/día), sin findes,
// drift por tramos + ruido con semilla fija — tendencias, mesetas y reversiones
function mkCandles(nDays){
  let seed = 77; const rnd = () => (seed = (seed*9301+49297)%233280) / 233280;
  const out=[]; let px=700; let t = Date.UTC(2026,3,6,13,30);        // lunes 6 abr 2026
  for(let d=0; d<nDays; d++){
    const dow = new Date(t).getUTCDay();
    if(dow===6){ t+=2*86400000; } else if(dow===0){ t+=86400000; }
    const phase = d%22; const drift = phase<8 ? 0.9 : phase<13 ? -0.05 : phase<18 ? -1.1 : 0.5;
    for(let b=0;b<7;b++){
      px += drift/7 + (rnd()-0.5)*2.4;
      const h=px+rnd()*1.5, l=px-rnd()*1.5;
      out.push({ t: t+b*3600000, o:px-(rnd()-0.5), h, l, c:l+rnd()*(h-l), v:1e6+rnd()*5e5 });
    }
    t += 86400000;
  }
  return out;
}

const O = { accelRate:0.12, startMult:2.0, smooth:3, vwapAccelBoost:1.5, filterPeriod:'Session', initBars:100, maxLevels:10, anchorTz:'America/New_York' };
let pass=0, fail=0;
const check=(n,c)=>{ if(c){pass++;console.log('  ✓ '+n);} else {fail++;console.log('  ✗ FALLA: '+n);} };
console.log('BENCH PARIDAD ARCO — mapa vs Pine-literal + invariancia de ventana (código real)');

// 1) PARIDAD MECÁNICA total: mismas velas → mismos flips (vela y dirección) y misma tendencia
const candles = mkCandles(90);                                        // ~630 velas
const M = mapArc(candles, {}), R = pineRef(candles, O);
const fM = M.flips.map(f=>`${f.index}:${f.bull?'B':'S'}`), fR = R.flips.map(f=>`${f.index}:${f.bull?'B':'S'}`);
check(`flips idénticos mapa vs Pine-literal (${fM.length} flips)`, fM.join(',')===fR.join(',') && fM.length>3);
let same=0, tot=0;
for(let i=0;i<candles.length;i++){ if(M.trendSeries[i]!==null&&R.trendSeries[i]!==null){ tot++; if(M.trendSeries[i]===R.trendSeries[i]) same++; } }
check(`tendencia vela a vela 100% (${same}/${tot})`, tot>400 && same===tot);

// 2) PARIDAD con filterPeriod Week (prueba F2: turbo contra refVwap, no vwapSession)
const MW = mapArc(candles, {filterPeriod:'Week'}), RW = pineRef(candles, Object.assign({},O,{filterPeriod:'Week'}));
check('paridad también con filterPeriod=Week (turbo refVwap)',
  MW.flips.map(f=>`${f.index}:${f.bull?'B':'S'}`).join(',') === RW.flips.map(f=>`${f.index}:${f.bull?'B':'S'}`).join(','));

// 3) INVARIANCIA DE VENTANA — el triángulo NO baila (prueba F3):
//    misma serie con la ventana corrida 1..7 velas. Las corridas inicializan en velas
//    distintas → trayectorias distintas HASTA el primer flip común (ahí el arco se
//    recoloca idéntico en ambas: low/high de la vela ± atrSlow×2, velocity=0 → se
//    SINCRONIZAN). El invariante honesto: después del flip de sincronización, todos los
//    flips deben ser IDÉNTICOS por timestamp y dirección. Con la cadencia vieja
//    (i % smooth) esto fallaba incluso sincronizadas: la fase corrida movía los avances.
const full = mapArc(candles, {});
let estable = true, comparados = 0;
const key = f => `${TZ._arcToMs(f.t)}:${f.bull?'B':'S'}`;
for(const off of [1,3,7]){
  const shifted = mapArc(candles.slice(off), {});
  const kF = full.flips.map(key), kS = shifted.flips.map(key);
  const sync = kF.find(k => kS.includes(k));                         // primer flip común
  if(!sync){ estable = false; continue; }
  const a = kF.slice(kF.indexOf(sync)+1), b = kS.slice(kS.indexOf(sync)+1);
  comparados = Math.max(comparados, a.length);
  if(a.join(',') !== b.join(',')) estable = false;
}
check(`ventana corrida 1/3/7 velas → flips post-sincronización idénticos (${comparados} comparados)`, estable && comparados>=2);

// 4) Guard: pocas velas → no inicializa, sin flips fantasma
const chico = mapArc(candles.slice(0,60), {});
check('con <110 velas no inicializa y no inventa flips', chico.initialized===false && chico.flips.length===0);

// 5) Los niveles de flip anclan al low/high de la vela del giro (donde el Pine pone su ◆)
const okAnchor = M.flips.every(f=>{ const c=candles[f.index]; return f.price === (f.bull ? c.l : c.h); });
check('nivel/triángulo anclado al low/high del flip (ancla del ◆ del Pine)', okAnchor);

console.log(`\nRESULTADO: ${pass}/${pass+fail}`);
process.exit(fail ? 1 : 0);
