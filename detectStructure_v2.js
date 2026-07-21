// ─────────────────────────────────────────────────────────────────────────
// detectStructure_v2 — CAPA SWING (canónica SMC/ICT)
// Referencia: LuxAlgo Price Action Concepts (estándar de estructura de mercado)
//
// Diferencias clave vs el detector viejo del mapa:
//   • La TENDENCIA se define por ESTADO ESTRUCTURAL (se da vuelta con un CHoCH),
//     NO por una EMA (Pine) ni ignorada (mapa viejo).
//   • CHoCH = ruptura CONTRA el estado; BOS = ruptura A FAVOR (continuación).
//   • El primer break desde estado neutro ESTABLECE la tendencia (BOS init), no es CHoCH.
//   • CHoCH+ (soportado) = CHoCH precedido de una señal temprana de giro
//     (lower-high en tendencia alcista / higher-low en bajista).
//   • Confirmación = 1 cierre de cuerpo más allá del swing (canónico; opcional 2+).
//
// swingLen es el largo del pivote: se calibra en producción (canónico swing ~50).
// El banco prueba la LÓGICA con swingLen chico; la lógica no depende del valor.
// ─────────────────────────────────────────────────────────────────────────
function detectStructure_v2(bars, opts){
  opts = opts || {};
  const L = opts.swingLen || 5;       // fuerza del pivote (prod ~50)
  const NC = opts.confirm  || 1;      // cierres de cuerpo para confirmar (canónico = 1)
  const out = { choch:null, bos:null, trend:0, swings:[], events:[] };
  if(!bars || bars.length < (2*L + 2)) return out;

  // 1) Pivotes confirmados (fractal de fuerza L). Un pivote en i se CONFIRMA en i+L.
  const pivots = [];
  for(let i = L; i < bars.length - L; i++){
    let isH = true, isL = true;
    for(let k = 1; k <= L; k++){
      if(!(bars[i].h > bars[i-k].h && bars[i].h > bars[i+k].h)) isH = false;
      if(!(bars[i].l < bars[i-k].l && bars[i].l < bars[i+k].l)) isL = false;
    }
    if(isH) pivots.push({ i, confAt: i+L, t:'H', price: bars[i].h });
    if(isL) pivots.push({ i, confAt: i+L, t:'L', price: bars[i].l });
  }
  pivots.sort((a,b)=> a.confAt - b.confAt || a.i - b.i);

  // 2) Máquina de estados: recorre las barras, confirma pivotes a su tiempo,
  //    y clasifica cada ruptura como BOS (a favor) o CHoCH/CHoCH+ (en contra).
  let trend = 0;                    // +1 alcista, -1 bajista, 0 neutro
  let lastSH = null, prevSH = null; // últimos dos swing highs (precio)
  let lastSL = null, prevSL = null; // últimos dos swing lows (precio)
  let failedCont = false;           // señal temprana de giro presente (para CHoCH+)
  let brokenSH = false, brokenSL = false;
  let choch = null, bos = null;
  let confUp = 0, confDn = 0;
  let pIdx = 0;

  for(let b = 0; b < bars.length; b++){
    // registrar pivotes que se confirman en esta barra
    while(pIdx < pivots.length && pivots[pIdx].confAt <= b){
      const p = pivots[pIdx++];
      if(p.t === 'H'){
        prevSH = lastSH; lastSH = p.price; brokenSH = false;
        // en tendencia alcista, un lower-high (SH nuevo < SH previo) = señal temprana de giro
        if(trend > 0 && prevSH !== null && lastSH < prevSH) failedCont = true;
      } else {
        prevSL = lastSL; lastSL = p.price; brokenSL = false;
        // en tendencia bajista, un higher-low (SL nuevo > SL previo) = señal temprana de giro
        if(trend < 0 && prevSL !== null && lastSL > prevSL) failedCont = true;
      }
    }
    const c = bars[b].c;
    confUp = (lastSH !== null && c > lastSH) ? confUp + 1 : 0;
    confDn = (lastSL !== null && c < lastSL) ? confDn + 1 : 0;

    // ── ruptura ALCISTA del último swing high ──
    if(lastSH !== null && !brokenSH && confUp >= NC){
      if(trend < 0){                                   // contra tendencia = CHoCH
        const plus = failedCont;
        choch = { dir:'BULL', price:lastSH, plus, label:(plus?'CHoCH+ ':'CHoCH ')+'\u25B2 ALCISTA' };
        out.events.push({ b, type:'CHoCH', dir:'BULL', plus });
        trend = 1; failedCont = false;
      } else {                                          // a favor / init = BOS
        bos = { dir:'BULL', price:lastSH, label:'BOS \u25B2 ALCISTA' };
        out.events.push({ b, type:(trend===0?'BOS_init':'BOS'), dir:'BULL' });
        trend = 1; failedCont = false;                  // continuación invalida señal temprana
      }
      brokenSH = true;
    }
    // ── ruptura BAJISTA del último swing low ──
    if(lastSL !== null && !brokenSL && confDn >= NC){
      if(trend > 0){                                   // contra tendencia = CHoCH
        const plus = failedCont;
        choch = { dir:'BEAR', price:lastSL, plus, label:(plus?'CHoCH+ ':'CHoCH ')+'\u25BC BAJISTA' };
        out.events.push({ b, type:'CHoCH', dir:'BEAR', plus });
        trend = -1; failedCont = false;
      } else {
        bos = { dir:'BEAR', price:lastSL, label:'BOS \u25BC BAJISTA' };
        out.events.push({ b, type:(trend===0?'BOS_init':'BOS'), dir:'BEAR' });
        trend = -1; failedCont = false;
      }
      brokenSL = true;
    }
  }

  out.trend = trend; out.choch = choch; out.bos = bos;
  out.swings = pivots.map(p=>({ i:p.i, type:(p.t==='H'?'HH':'LL'), price:p.price }));
  return out;
}

if(typeof module !== 'undefined') module.exports = { detectStructure_v2 };
