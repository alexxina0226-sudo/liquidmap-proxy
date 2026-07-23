// bench_tggate.js — juez de la COMPUERTA DE EMISIÓN A TELEGRAM (s62)
// Extrae tgGate() del HTML REAL y la corre con estados controlados.
// Reglas: sólo mercado ABIERTO · serie fresca · feed al día · 5m/15m exigen BOS o CHoCH.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/LiquidityMap_BOLSA_v5.html', 'utf8');

const i0 = html.indexOf('const TF_MIN =');
const i1 = html.indexOf('function checkAlerts(');
if (i0 < 0 || i1 < 0 || i1 <= i0) { console.error('No pude extraer tgGate'); process.exit(1); }
const src = html.slice(i0, i1);

// fábrica: monta tgGate con el estado que le pasemos (mismo código del HTML, sin copias)
function makeGate(st) {
  const getMktStatus = () => st.mkt;
  let DATA_STALE = st.stale, DATA_LAST_LABEL = st.label || 'Jul 17',
      DATA_LAST_SEC = st.lastSec, tf = st.tf, struct = st.struct;
  return eval(src + '\n tgGate;');
}
const NOW = () => Math.floor(Date.now() / 1000);
const base = o => Object.assign({ mkt:'open', stale:false, lastSec:NOW()-60, tf:'60', struct:{bos:null,choch:null} }, o);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '  \u2713 ' : '  \u2717 ') + n); };
const gate = o => makeGate(base(o))();

let r;
// ── 1. SESIÓN ──
r = gate({ mkt:'closed' });
ok('mercado cerrado → BLOQUEA (el caso AMZN de las 23:53)', r.ok === false && /cerrado/.test(r.why));
r = gate({ mkt:'pre' });
ok('pre/after-hours → BLOQUEA', r.ok === false && /pre\/after/.test(r.why));
r = gate({ mkt:'open' });
ok('mercado abierto + todo sano → PASA', r.ok === true);

// ── 2. FRESCURA ──
r = gate({ stale:true });
ok('serie vieja (DATA_STALE) → BLOQUEA e informa la fecha', r.ok === false && /datos viejos/.test(r.why) && /Jul 17/.test(r.why));
r = gate({ lastSec:0 });
ok('sin timestamp de vela → BLOQUEA', r.ok === false && /sin timestamp/.test(r.why));
r = gate({ tf:'15', lastSec:NOW()-60*60, struct:{bos:{dir:'BULL'},choch:null} });
ok('15m con vela de hace 60min (>3 velas) → BLOQUEA por feed atrasado', r.ok === false && /feed atrasado/.test(r.why));
r = gate({ tf:'15', lastSec:NOW()-60*20, struct:{bos:{dir:'BULL'},choch:null} });
ok('15m con vela de hace 20min (<3 velas) → PASA', r.ok === true);
r = gate({ tf:'D', lastSec:NOW()-60*60*20 });
ok('diario con vela de hace 20h → PASA (D exento del lag)', r.ok === true);

// ── 3. GATILLO DE OPCIONES (5m/15m exigen estructura) ──
r = gate({ tf:'15', struct:{bos:null,choch:null} });
ok('15m SIN BOS/CHoCH → BLOQUEA (ruido de scalping)', r.ok === false && /sin BOS\/CHoCH/.test(r.why));
r = gate({ tf:'5', struct:{bos:null,choch:null} });
ok('5m SIN BOS/CHoCH → BLOQUEA', r.ok === false && /sin BOS\/CHoCH/.test(r.why));
r = gate({ tf:'15', struct:{bos:null,choch:{dir:'BULL',plus:false}} });
ok('15m CON CHoCH → PASA (el AMZN de anoche, en horario, sí saldría)', r.ok === true);
r = gate({ tf:'5', struct:{bos:{dir:'BEAR'},choch:null} });
ok('5m CON BOS → PASA', r.ok === true);
r = gate({ tf:'60', struct:{bos:null,choch:null} });
ok('1H sin estructura → PASA (el sesgo mayor no exige evento)', r.ok === true);
r = gate({ tf:'240', struct:{bos:null,choch:null} });
ok('4H sin estructura → PASA', r.ok === true);

// ── 4. PRECEDENCIA (la sesión manda sobre todo) ──
r = gate({ mkt:'closed', tf:'15', struct:{bos:{dir:'BULL'},choch:null} });
ok('cerrado + 15m con BOS → igual BLOQUEA (sesión manda)', r.ok === false && /cerrado/.test(r.why));

// ── 5. CABLEADO EN EL DISPARO ──
ok('BUY pasa por tgGate antes de sendTelegram', /sig\.type==='BUY'[\s\S]{0,260}tgGate\(\)[\s\S]{0,80}sendTelegram\('BUY'/.test(html));
ok('SELL pasa por tgGate antes de sendTelegram', /sig\.type==='SELL'[\s\S]{0,260}tgGate\(\)[\s\S]{0,80}sendTelegram\('SELL'/.test(html));
ok('no quedó ningún sendTelegram sin compuerta', (html.match(/sendTelegram\(/g) || []).length === 3); // 1 definición + 2 llamadas
ok('el popup del mapa NO fue tocado (sigue mostrando todo)', /showAlertPopup\('▲ BUY INSTITUCIONAL/.test(html) && /showAlertPopup\('▼ SELL INSTITUCIONAL/.test(html));

console.log('\nRESULTADO: ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
