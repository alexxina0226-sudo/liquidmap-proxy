// ════════════════════════════════════════════════════════════════════════════
// LIQUIDMAP PRO · RADAR — monitor_radar_v1.js
// Scanner de universo amplio (barrido) — TERCER bot, independiente del estructural.
// ────────────────────────────────────────────────────────────────────────────
// FUENTE: Alpaca free ($0). Precio real-time (IEX) + diarias completas (ambos planes).
//   Es a la vez el RADAR y el PILARTO para medir la calidad de Alpaca antes de pagar.
// DISPARA: RVOL ≥ umbral (volumen relativo) Y movimiento ≥ N×ATR (vs cierre previo).
//   Es un FLAGGER de candidatos, no un gatillo de ejecución — confirmá en el mapa/TV.
// ────────────────────────────────────────────────────────────────────────────
// Un paso, una verdad: sin data sintética, archivo completo, validado con node --check.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const http = require('http');   // mini-servidor para calificar como Web Service (tier Free de Render)
let LAST = { at: null, hits: 0, fired: 0, universe: 0, baseline: 0, error: 'aún no corrió' };

// ── CREDENCIALES (env vars en Render — NUNCA hardcodear) ────────────────────
const ALPACA_KEY    = process.env.ALPACA_KEY_ID     || '';
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY || '';
const TG_TOKEN      = process.env.TELEGRAM_TOKEN_RADAR || '';            // tercer bot de Telegram
const CHAT_IDS      = (process.env.RADAR_CHAT_IDS || '1218461753,1373309702').split(',');

const DATA_BASE = 'https://data.alpaca.markets';

// ── UNIVERSO (líquidos; ampliable a 500 agregando símbolos) ─────────────────
const UNIVERSE = [
  'SPY','QQQ','IWM','DIA',
  'AAPL','MSFT','NVDA','AMZN','META','GOOG','GOOGL','TSLA','AVGO','NFLX',
  'AMD','MU','INTC','QCOM','TXN','ARM','SMCI','MRVL','ASML','TSM',
  'PLTR','UBER','COIN','HOOD','SHOP','SNOW','CRWD','PANW','DDOG','NET','ABNB',
  'JPM','BAC','WFC','GS','MS','C','SCHW','V','MA','AXP','PYPL','SOFI',
  'XOM','CVX','OXY','SLB','COP',
  'BABA','BIDU','PDD','JD','NIO','LI','XPEV',
  'DIS','WMT','COST','HD','LOW','NKE','SBUX','MCD','TGT',
  'PFE','MRNA','LLY','UNH','JNJ','ABBV','BMY',
  'BA','CAT','GE','F','GM','DAL','UAL','AAL',
  'MSTR','MARA','RIOT','CLSK','SQ','RBLX','U','DKNG','CVNA','AFRM',
  'SPCE','LCID','RIVN','CCL','NCLH','PLUG','FCEL','GME','AMC','BBBY',
  'URA','TLT','GLD','SLV','USO','XLE','XLF','XLK','SMH','ARKK'
];

// ── UMBRALES (config — generales, no por ticker) ────────────────────────────
const RVOL_MIN     = 2.0;                  // volumen relativo mínimo (×promedio)
const ATR_MULT     = 2.0;                  // movimiento mínimo en múltiplos de ATR
const ATR_PERIOD   = 14;                   // días para ATR
const AVGVOL_DAYS  = 20;                   // días para volumen promedio
const HIST_DAYS    = 45;                   // ventana de diarias a pedir (cubre ATR+avgvol con aire)
const SCAN_INTERVAL = 5 * 60 * 1000;       // barrido cada 5 min
const COOLDOWN_MS   = 2 * 60 * 60 * 1000;  // anti-spam: 1 alerta por ticker cada 2h
const SNAP_BATCH    = 50;                  // símbolos por llamada de snapshot

// ── ESTADO (en memoria; dedup por ticker) ───────────────────────────────────
const STATE = {};                          // ticker -> { lastAlertTs, lastDir }
let BASELINE = {};                         // ticker -> { atr, avgVol, day }  (refresca 1×/día)
let baselineDay = null;

// ── HTTP a Alpaca ───────────────────────────────────────────────────────────
async function alpacaGet(path) {
  const r = await fetch(DATA_BASE + path, {
    headers: {
      'APCA-API-KEY-ID': ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
      'accept': 'application/json'
    }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Alpaca ${r.status} en ${path.split('?')[0]} :: ${body.slice(0, 140)}`);
  }
  return r.json();
}

// ── ATR Wilder sobre diarias (mismo método que el SuperTrend del mapa/bot) ──
function computeATR(bars, period) {
  if (!bars || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;   // seed = SMA
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

// ── BASELINE: diarias históricas completas (full-volume en free si end >15min) ──
async function buildBaseline() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  if (baselineDay === today && Object.keys(BASELINE).length) return;   // ya está para hoy

  console.log(`[RADAR] Construyendo baseline (ATR${ATR_PERIOD} + avgVol${AVGVOL_DAYS}) para ${UNIVERSE.length} tickers...`);
  const start = new Date(Date.now() - HIST_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // end ≥ 16 min atrás: en free, SIP histórico exige end > 15 min (data completa, no IEX)
  const end = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  const next = {};

  for (let i = 0; i < UNIVERSE.length; i += SNAP_BATCH) {
    const syms = UNIVERSE.slice(i, i + SNAP_BATCH).join(',');
    let pageToken = null;
    const bySym = {};
    do {
      const qs = `symbols=${syms}&timeframe=1Day&start=${start}&end=${encodeURIComponent(end)}` +
                 `&adjustment=raw&feed=sip&limit=10000` + (pageToken ? `&page_token=${pageToken}` : '');
      const d = await alpacaGet(`/v2/stocks/bars?${qs}`);
      for (const s in (d.bars || {})) {
        bySym[s] = (bySym[s] || []).concat(d.bars[s].map(b => ({ h: b.h, l: b.l, c: b.c, v: b.v })));
      }
      pageToken = d.next_page_token || null;
    } while (pageToken);

    for (const s in bySym) {
      const bars = bySym[s];
      const atr = computeATR(bars, ATR_PERIOD);
      const vols = bars.slice(-AVGVOL_DAYS).map(b => b.v);
      if (atr && vols.length) next[s] = { atr, avgVol: avg(vols) };
    }
  }

  BASELINE = next;
  baselineDay = today;
  console.log(`[RADAR] Baseline listo: ${Object.keys(BASELINE).length}/${UNIVERSE.length} tickers con ATR+avgVol.`);
}

// ── SNAPSHOT: precio real-time (IEX) + diaria de hoy + cierre previo ────────
async function fetchSnapshots() {
  const out = {};
  for (let i = 0; i < UNIVERSE.length; i += SNAP_BATCH) {
    const syms = UNIVERSE.slice(i, i + SNAP_BATCH).join(',');
    const d = await alpacaGet(`/v2/stocks/snapshots?symbols=${syms}&feed=iex`);
    Object.assign(out, d);
  }
  return out;
}

// ── DETECCIÓN ───────────────────────────────────────────────────────────────
function evaluate(sym, snap) {
  const base = BASELINE[sym];
  if (!base) return null;

  const last  = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c;
  const prevC = snap.prevDailyBar?.c;
  const todayVol = snap.dailyBar?.v;
  if (!last || !prevC || !todayVol) return null;

  const move    = last - prevC;
  const moveATR = base.atr ? move / base.atr : 0;
  const rvol    = base.avgVol ? todayVol / base.avgVol : 0;

  if (rvol >= RVOL_MIN && Math.abs(moveATR) >= ATR_MULT) {
    return {
      sym, last, prevC,
      pct: (move / prevC) * 100,
      moveATR, rvol,
      dir: move >= 0 ? 'up' : 'down'
    };
  }
  return null;
}

// ── TELEGRAM (HTML, a vos y Sucel — mismo patrón que el bot bolsa) ──────────
async function sendTelegram(text) {
  if (!TG_TOKEN) { console.log('[RADAR] (sin TELEGRAM_TOKEN_RADAR — alerta no enviada)\n' + text); return; }
  try {
    await Promise.all(CHAT_IDS.map(id =>
      fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id.trim(), text, parse_mode: 'HTML', disable_web_page_preview: true })
      })
    ));
  } catch (e) { console.error('[RADAR] Telegram error:', e.message); }
}

function buildAlert(h) {
  const arrow = h.dir === 'up' ? '🟢 ▲' : '🔴 ▼';
  const dirTxt = h.dir === 'up' ? 'ALCISTA' : 'BAJISTA';
  return `📡 <b>RADAR — ${h.sym}</b>\n` +
         `${arrow} ${dirTxt} · ${h.pct >= 0 ? '+' : ''}${h.pct.toFixed(2)}% del día\n` +
         `Precio $${h.last.toFixed(2)} · prev $${h.prevC.toFixed(2)}\n` +
         `⚡ RVOL ${h.rvol.toFixed(1)}× · movimiento ${Math.abs(h.moveATR).toFixed(1)}×ATR\n` +
         `🔎 Candidato — confirmá estructura en el mapa / TV antes de operar.`;
}

// ── BARRIDO ──────────────────────────────────────────────────────────────────
async function runScan() {
  const now = new Date().toLocaleString('es', { timeZone: 'America/New_York' });
  try {
    await buildBaseline();
    const snaps = await fetchSnapshots();

    let hits = 0, fired = 0;
    for (const sym of UNIVERSE) {
      const snap = snaps[sym];
      if (!snap) continue;
      const hit = evaluate(sym, snap);
      if (!hit) continue;
      hits++;

      const s = STATE[sym] || (STATE[sym] = { lastAlertTs: 0, lastDir: null });
      const fresh = (Date.now() - s.lastAlertTs) >= COOLDOWN_MS;
      const dirChanged = s.lastDir !== hit.dir;
      if (fresh || dirChanged) {
        await sendTelegram(buildAlert(hit));
        s.lastAlertTs = Date.now();
        s.lastDir = hit.dir;
        fired++;
      }
    }
    console.log(`[RADAR SCAN] ${now} · candidatos:${hits} · alertas:${fired} · universo:${UNIVERSE.length}`);
    LAST = { at: now, hits, fired, universe: UNIVERSE.length, baseline: Object.keys(BASELINE).length, error: null };
  } catch (e) {
    console.error(`[RADAR SCAN] ${now} · ERROR:`, e.message);
    LAST = { at: now, hits: 0, fired: 0, universe: UNIVERSE.length, baseline: Object.keys(BASELINE).length, error: e.message };
  }
}

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
console.log('════════════════════════════════════════════');
console.log('  LIQUIDMAP PRO · RADAR v1 — Alpaca free');
console.log('════════════════════════════════════════════');
console.log(`   Universo  : ${UNIVERSE.length} tickers`);
console.log(`   Umbrales  : RVOL ≥ ${RVOL_MIN}× · movimiento ≥ ${ATR_MULT}×ATR(${ATR_PERIOD})`);
console.log(`   Barrido   : cada ${SCAN_INTERVAL / 60000} min · cooldown ${COOLDOWN_MS / 3600000}h por ticker`);
console.log(`   Alpaca key: ${ALPACA_KEY ? 'OK' : 'FALTA (ALPACA_KEY_ID)'}`);
console.log(`   TG radar  : ${TG_TOKEN ? 'OK' : 'FALTA (TELEGRAM_TOKEN_RADAR)'}`);
console.log('   FLAGGER de candidatos — no es gatillo de ejecución.');
console.log('════════════════════════════════════════════\n');

// ── MINI-SERVIDOR HTTP (para calificar como Web Service free de Render) ──────
//   No toca la lógica del radar: solo escucha el puerto que Render asigna y
//   sirve una página de estado. El radar sigue corriendo en su setInterval.
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  const l = LAST;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8">
    <title>LiquidMap RADAR</title>
    <style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#cdd6e4;padding:32px;line-height:1.6}
    b{color:#7fd1ff}.ok{color:#5fd38a}.err{color:#ff6b6b}.k{color:#ffd66b}</style>
    <h2>📡 LiquidMap PRO · RADAR v1</h2>
    <p>Universo: <b>${UNIVERSE.length}</b> tickers · Umbrales: RVOL ≥ <b>${RVOL_MIN}×</b> · mov ≥ <b>${ATR_MULT}×ATR(${ATR_PERIOD})</b></p>
    <p>Alpaca key: <span class="${ALPACA_KEY ? 'ok' : 'err'}">${ALPACA_KEY ? 'OK' : 'FALTA'}</span> ·
       TG radar: <span class="${TG_TOKEN ? 'ok' : 'err'}">${TG_TOKEN ? 'OK' : 'FALTA'}</span></p>
    <hr>
    <p>Último barrido: <b>${l.at || 'aún no corrió'}</b></p>
    <p>Baseline: <b>${l.baseline}/${UNIVERSE.length}</b> tickers con ATR+avgVol</p>
    <p>Candidatos: <b class="k">${l.hits}</b> · Alertas enviadas: <b class="k">${l.fired}</b></p>
    ${l.error ? `<p class="err">Error: ${l.error}</p>` : ''}
    <p style="opacity:.6;margin-top:24px">FLAGGER de candidatos — no es gatillo de ejecución. Se refresca cada ${SCAN_INTERVAL / 60000} min.</p>`);
}).listen(PORT, '0.0.0.0', () => console.log(`[RADAR] HTTP de estado en puerto ${PORT}`));

runScan();
setInterval(runScan, SCAN_INTERVAL);
