// ════════════════════════════════════════════════════════════════════
//  conviction_governor.js — GOBERNADOR DE CONVICCIÓN (módulo canónico)
//  s63 · 23-jul-2026
//
//  Extraído BYTE A BYTE del mapa bolsa (LiquidityMap_BOLSA_v5.html,
//  líneas 1130-1188 del HTML 2664 · md5 788e9a70). Una sola fuente de
//  verdad: el mapa y el monitor gobiernan la convicción con el MISMO
//  código, igual que ya comparten detectStructure_v2.js desde s59.
//
//  NO toca dirección ni score. Gobierna el GRADO mostrado y explica
//  POR QUÉ lo capó. Cap = mínimo de los gates que apliquen.
//
//  Contrato de entrada:
//    sig = { type:'BUY'|'SELL'|'NEUTRAL', rawScore, adx:{adx,strong,bull,bear}|null,
//            layers:[{name,dir,abs}] }
//    ctx = { zoneDir, mtfBull, trendStr } | null   (null = gate no evaluado)
//    opts= { rawMax, adxMin, adxStrong, minPillars, minLiveFrac, stale, staleMsg }
//  Salida: { direction, grade, gradeIdx, caps[], reason, liveLayers,
//            totalLayers, pillars[], nPillars, partial }
// ════════════════════════════════════════════════════════════════════

const GOV_GRADES = ['ESPERAR','DÉBIL','VÁLIDA','FUERTE','SNIPER'];
const GOV_G = { ESPERAR:0, 'DÉBIL':1, 'VÁLIDA':2, FUERTE:3, SNIPER:4 };
const GOV_PILLAR = { 'SuperTrend':'Momentum','ADX':'Momentum','CVD':'Volumen','Presión':'Volumen',
  'BOS':'Estructura','CHoCH':'Estructura','VWAP':'Ubicación','Value Area':'Ubicación' };
function govBaseGrade(rawScore, rawMax){
  const frac = Math.min(1, Math.abs(rawScore)/(rawMax||12.5));
  if(frac>=0.72) return GOV_G.SNIPER;
  if(frac>=0.52) return GOV_G.FUERTE;
  if(frac>=0.32) return GOV_G['VÁLIDA'];
  if(frac>=0.16) return GOV_G['DÉBIL'];
  return GOV_G.ESPERAR;
}
function governConviction(sig, ctx, opts){
  opts = opts||{};
  const rawMax=opts.rawMax!=null?opts.rawMax:12.5, adxMin=opts.adxMin!=null?opts.adxMin:20,
        adxStrong=opts.adxStrong!=null?opts.adxStrong:30, minPillars=opts.minPillars!=null?opts.minPillars:3,
        minLiveFrac=opts.minLiveFrac!=null?opts.minLiveFrac:0.6;
  const dir=sig.type, dirSign=dir==='BUY'?1:dir==='SELL'?-1:0, caps=[], capList=[];
  let ceiling=govBaseGrade(sig.rawScore, rawMax);
  const capAt=(l,m)=>{ ceiling=Math.min(ceiling,l); capList.push({l,m}); caps.push(m); };
  if(dirSign===0) return { direction:'NEUTRAL', grade:'ESPERAR', gradeIdx:0, caps:[], reason:null, liveLayers:0,
    totalLayers:(sig.layers||[]).length, pillars:[], nPillars:0, partial:false };
  // GATE 0 · FRESCURA — serie vieja = no confiable, sin importar lo que griten las capas
  if(opts.stale){ capAt(GOV_G['DÉBIL'], opts.staleMsg || 'DATA VIEJA — no confiable'); }
  // GATE 1 · RÉGIMEN
  const adx = sig.adx ? sig.adx.adx : null;
  if(adx==null){ capAt(GOV_G['DÉBIL'], 'régimen sin ADX'); }
  else if(adx<adxMin){ capAt(GOV_G['DÉBIL'], 'rango — ADX '+adx.toFixed(1)+' <'+adxMin); }
  else if(adx<adxStrong){ capAt(GOV_G.FUERTE, 'régimen válido no fuerte (ADX '+adx.toFixed(1)+')'); }
  if(sig.adx && sig.adx.strong){
    const ok=(dirSign>0&&sig.adx.bull)||(dirSign<0&&sig.adx.bear);
    if(!ok){ capAt(GOV_G['VÁLIDA'], 'DMI no confirma'); }
  }
  // GATE 2 · UBICACIÓN — coherencia HTF primero (la usa el gate de ubicación)
  const mtfAg = ctx && ctx.mtfBull!=null && ((dirSign>0&&ctx.mtfBull===false)||(dirSign<0&&ctx.mtfBull===true));
  const trAg  = ctx && ctx.trendStr!=null && ((dirSign>0&&ctx.trendStr===false)||(dirSign<0&&ctx.trendStr===true));
  const htfAg = mtfAg || trAg;
  if(ctx && ctx.zoneDir){
    const good=(dirSign>0&&ctx.zoneDir>0)||(dirSign<0&&ctx.zoneDir<0);
    // CALIBRACIÓN s38: ubicación adversa SOLA → VÁLIDA si el HTF confirma; DÉBIL solo si HTF en contra.
    if(!good){ const w=dirSign>0?'comprando en PREMIUM (venta)':'vendiendo en DISCOUNT (compra)'; capAt(htfAg?GOV_G['DÉBIL']:GOV_G['VÁLIDA'], htfAg?w:w+' — HTF confirma → media'); }
  }
  if(ctx){
    if(mtfAg && trAg){ capAt(GOV_G['DÉBIL'], 'contra el HTF (MTF 4H + EMA200)'); }
    else if(mtfAg||trAg){ capAt(GOV_G['VÁLIDA'], mtfAg?'MTF 4H en contra':'lado equivocado de EMA200'); }
  }
  // GATE 3 · INTEGRIDAD
  const layers=sig.layers||[], pillars=new Set(); let live=0;
  for(const L of layers){ if(L&&L.dir!==0){ live++; if((dirSign>0&&L.dir>0)||(dirSign<0&&L.dir<0)){ const pi=GOV_PILLAR[L.name]; if(pi) pillars.add(pi); } } }
  const nP=pillars.size, total=layers.length, partial=total>0&&live<Math.ceil(total*minLiveFrac);
  if(partial){ capAt(GOV_G['DÉBIL'], 'DATOS PARCIALES ('+live+'/'+total+' capas)'); }
  if(nP<minPillars){ capAt(nP<=1?GOV_G['DÉBIL']:GOV_G['VÁLIDA'], 'confluencia floja ('+nP+'/4 pilares)'); }
  ceiling=Math.max(0,Math.min(GOV_G.SNIPER,ceiling));
  const binding=capList.filter(c=>c.l===ceiling).map(c=>c.m);
  const reason=binding.length?binding.join(' · '):(caps[0]||null);
  return { direction:dir, grade:GOV_GRADES[ceiling], gradeIdx:ceiling, caps, reason, liveLayers:live, totalLayers:total, pillars:[...pillars], nPillars:nP, partial };
}
function govLabel(g){ return ({ SNIPER:'🎯 SNIPER',FUERTE:'🔥 FUERTE','VÁLIDA':'✅ VÁLIDA','DÉBIL':'⚠️ DÉBIL',ESPERAR:'⏸️ ESPERAR' })[g]||g; }


module.exports = { GOV_GRADES, GOV_G, GOV_PILLAR, govBaseGrade, governConviction, govLabel };
