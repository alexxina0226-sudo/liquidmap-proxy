// ════════════════════════════════════════════════════════════════════════════
// LIQUIDMAP PRO · RADAR — monitor_radar_v1.js   (v1.3 — pre-aviso con candado RTH + RVOL parcial)
// Scanner de universo amplio (barrido) — TERCER bot, independiente del estructural.
// ────────────────────────────────────────────────────────────────────────────
// FUENTE: Alpaca free ($0). TODO el cálculo sale del MISMO feed SIP retrasado
//   ~16 min (volumen 100% del mercado, no el 2.5% de IEX). Una sola fuente,
//   una sola verdad → el RVOL es apples-to-apples con el baseline.
//   Es a la vez el RADAR y el PILARTO para medir la calidad de Alpaca antes de pagar.
// DISPARA: RVOL ≥ umbral (normalizado por hora del día) Y movimiento ≥ N×ATR.
//   Es un FLAGGER de candidatos, no un gatillo de ejecución — confirmá en el mapa/TV.
// ────────────────────────────────────────────────────────────────────────────
// FIX (sesión 34): antes el volumen de hoy salía del snapshot feed=iex (~2.5% del
//   mercado) y el promedio del baseline salía de SIP (100%). RVOL ≈ 0.025 SIEMPRE →
//   nunca cruzaba el umbral → cero señales. Ahora hoy y promedio salen ambos de SIP.
// ────────────────────────────────────────────────────────────────────────────
// Un paso, una verdad: sin data sintética, archivo completo, validado con node --check.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const http = require('http');   // mini-servidor para calificar como Web Service (tier Free de Render)
let LAST = { at: null, hits: 0, fired: 0, preFired: 0, evaluated: 0, universe: 0, baseline: 0, frac: 0, top: [], error: 'aún no corrió' };

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
const RVOL_MIN     = 2.0;                  // volumen relativo mínimo (×esperado a esta hora)
const ATR_MULT     = 2.0;                  // movimiento mínimo en múltiplos de ATR
const ATR_PERIOD   = 14;                   // días para ATR
const AVGVOL_DAYS  = 20;                   // días para volumen promedio
const HIST_DAYS    = 45;                   // ventana de diarias para el baseline
const TODAY_DAYS   = 6;                    // ventana corta para hoy + cierre previo (cubre finde/feriado)
const DELAY_MS     = 16 * 60 * 1000;       // SIP free exige end > 15 min → pedimos a 16 min
const SCAN_INTERVAL = 5 * 60 * 1000;       // barrido cada 5 min
const COOLDOWN_MS   = 2 * 60 * 60 * 1000;  // anti-spam: 1 alerta por ticker cada 2h
const SNAP_BATCH    = 50;                  // símbolos por llamada
const MIN_FRAC      = 0.05;                // < 5% de sesión transcurrida → RVOL aún no confiable

// ── PRE-AVISO (capa temprana, precio en TIEMPO REAL IEX — sin delay) ────────
const PRE_ATR_MULT    = 1.2;               // movimiento mínimo para el pre-aviso (más bajo que el confirmado)
const PRE_RVOL_MIN    = 1.3;               // RVOL parcial mínimo (SIP, normalizado por hora) — filtra velas flojas
const PRE_COOLDOWN_MS = 60 * 60 * 1000;    // 1 pre-aviso por ticker por hora
// NOTA: el pre-aviso solo dispara en RTH (candado de hora, reloj real) → mata el ruido de after-hours.

// ── SESIÓN NY (para normalizar el RVOL por hora del día) ────────────────────
const SESSION_OPEN  = 9.5 * 3600;          // 09:30 ET en segundos desde medianoche
const SESSION_CLOSE = 16 * 3600;           // 16:00 ET
const SESSION_LEN   = SESSION_CLOSE - SESSION_OPEN;   // 23.400 s

// ── ESTADO (en memoria; dedup por ticker) ───────────────────────────────────
const STATE = {};                          // ticker -> { lastAlertTs, lastDir }
let BASELINE = {};                         // ticker -> { atr, avgVol }  (refresca 1×/día)
let baselineDay = null;

// ── HELPERS de fecha/hora NY ────────────────────────────────────────────────
function nyDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);   // YYYY-MM-DD
}
function nySecSinceMidnight(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d);
  const get = t => parseInt(parts.find(p => p.type === t).value, 10);
  let h = get('hour'); if (h === 24) h = 0;   // medianoche puede venir como 24
  return h * 3600 + get('minute') * 60 + get('second');
}
// fracción de la sesión transcurrida según el RELOJ RETRASADO (alinea con la data que tenemos)
function sessionFraction(dataClock) {
  const sec = nySecSinceMidnight(dataClock);
  if (sec <= SESSION_OPEN)  return 0;
  if (sec >= SESSION_CLOSE) return 1;
  return (sec - SESSION_OPEN) / SESSION_LEN;
}
// ¿mercado regular abierto AHORA? — CANDADO del pre-aviso, por RELOJ REAL (el precio es real-time, no el retrasado).
// Cubre fin de semana (Sat/Sun) y fuera de 09:30–16:00 ET. (Feriados: sin barra SIP + IEX devuelve cierre previo
// → moveLiveATR≈0, no dispara; no se hardcodea calendario de feriados.)
function isRTH(d) {
  const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
  if (dow === 'Sat' || dow === 'Sun') return false;
  const sec = nySecSinceMidnight(d);
  return sec >= SESSION_OPEN && sec < SESSION_CLOSE;
}

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

// ── Pedir diarias SIP (retrasadas 16 min, full-volume en free) ──────────────
//   Reutilizado por baseline (ventana larga) y por el barrido (ventana corta de hoy).
async function fetchDailyBars(days) {
  const start = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const end   = new Date(Date.now() - DELAY_MS).toISOString();
  const out = {};   // sym -> [{ date, h, l, c, v }, ...] en orden
  for (let i = 0; i < UNIVERSE.length; i += SNAP_BATCH) {
    const syms = UNIVERSE.slice(i, i + SNAP_BATCH).join(',');
    let pageToken = null;
    const bySym = {};
    do {
      const qs = `symbols=${syms}&timeframe=1Day&start=${start}&end=${encodeURIComponent(end)}` +
                 `&adjustment=raw&feed=sip&limit=10000` + (pageToken ? `&page_token=${pageToken}` : '');
      const d = await alpacaGet(`/v2/stocks/bars?${qs}`);
      for (const s in (d.bars || {})) {
        bySym[s] = (bySym[s] || []).concat(
          d.bars[s].map(b => ({ date: b.t.slice(0, 10), h: b.h, l: b.l, c: b.c, v: b.v }))
        );
      }
      pageToken = d.next_page_token || null;
    } while (pageToken);
    Object.assign(out, bySym);
  }
  return out;
}

// ── BASELINE: ATR + volumen promedio, EXCLUYENDO la barra parcial de hoy ────
async function buildBaseline() {
  const today = nyDate(new Date());
  if (baselineDay === today && Object.keys(BASELINE).length) return;   // ya está para hoy

  console.log(`[RADAR] Construyendo baseline (ATR${ATR_PERIOD} + avgVol${AVGVOL_DAYS}) para ${UNIVERSE.length} tickers...`);
  const bySym = await fetchDailyBars(HIST_DAYS);
  const next = {};
  for (const s in bySym) {
    const completed = bySym[s].filter(b => b.date !== today);   // fuera la parcial de hoy (no contamina el promedio)
    const atr  = computeATR(completed, ATR_PERIOD);
    const vols = completed.slice(-AVGVOL_DAYS).map(b => b.v);
    if (atr && vols.length) next[s] = { atr, avgVol: avg(vols) };
  }
  BASELINE = next;
  baselineDay = today;
  console.log(`[RADAR] Baseline listo: ${Object.keys(BASELINE).length}/${UNIVERSE.length} tickers con ATR+avgVol.`);
}

// ── DETECCIÓN ───────────────────────────────────────────────────────────────
//   Devuelve SIEMPRE las métricas (con bandera `passed`) para poder mostrar
//   los "top movers" en la página de estado aunque no crucen el umbral.
function evaluate(sym, bars, frac, today) {
  const base = BASELINE[sym];
  if (!base || !bars || bars.length < 2) return null;

  const last  = bars[bars.length - 1];
  const prev  = bars[bars.length - 2];
  if (last.date !== today) return null;            // aún no hay barra de hoy (pre-market/feriado/primeros ~16 min)
  if (frac < MIN_FRAC) return null;                // demasiado temprano: el RVOL todavía no es confiable

  const px = last.c, prevC = prev.c, todayVol = last.v;
  if (!px || !prevC || !todayVol) return null;

  const expectedVol = base.avgVol * frac;          // volumen ESPERADO a esta hora (aprox. uniforme en la sesión)
  const rvol    = expectedVol ? todayVol / expectedVol : 0;
  const move    = px - prevC;
  const moveATR = base.atr ? move / base.atr : 0;

  return {
    sym, last: px, prevC, todayVol,
    pct: (move / prevC) * 100,
    moveATR, rvol, frac,
    dir: move >= 0 ? 'up' : 'down',
    passed: rvol >= RVOL_MIN && Math.abs(moveATR) >= ATR_MULT
  };
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
  const arrow  = h.dir === 'up' ? '🟢 ▲' : '🔴 ▼';
  const dirTxt = h.dir === 'up' ? 'ALCISTA' : 'BAJISTA';
  return `📡 <b>RADAR — ${h.sym}</b>\n` +
         `${arrow} ${dirTxt} · ${h.pct >= 0 ? '+' : ''}${h.pct.toFixed(2)}% del día\n` +
         `Precio $${h.last.toFixed(2)} · prev $${h.prevC.toFixed(2)}\n` +
         `⚡ RVOL ${h.rvol.toFixed(1)}× · movimiento ${Math.abs(h.moveATR).toFixed(1)}×ATR\n` +
         `🕒 SIP ≈15 min retrasado · 🔎 Candidato — confirmá estructura en el mapa / TV.`;
}

// ── PRECIO EN TIEMPO REAL (IEX) — SOLO para el pre-aviso (sin volumen, sin delay) ──
//   IEX da precio real-time fiable; el volumen es parcial, por eso el pre-aviso
//   NO usa RVOL — es puro momentum de precio. La confirmación sigue por SIP.
async function fetchLivePrices() {
  const out = {};
  for (let i = 0; i < UNIVERSE.length; i += SNAP_BATCH) {
    const syms = UNIVERSE.slice(i, i + SNAP_BATCH).join(',');
    try {
      const d = await alpacaGet(`/v2/stocks/snapshots?symbols=${syms}&feed=iex`);
      const map = d.snapshots || d;   // tolera ambas formas del endpoint
      for (const s in map) {
        const snap = map[s];
        const px = (snap && snap.latestTrade && snap.latestTrade.p) ||
                   (snap && snap.minuteBar && snap.minuteBar.c) ||
                   (snap && snap.dailyBar && snap.dailyBar.c) || null;
        if (px) out[s] = px;
      }
    } catch (e) { /* best-effort: si falla un batch, ese no tiene pre-aviso este barrido */ }
  }
  return out;
}

// prevC = cierre del último día COMPLETADO (no la barra parcial de hoy)
function prevCloseOf(bars, today) {
  if (!bars || !bars.length) return null;
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].date !== today) return bars[i].c;
  return null;
}

function buildPreAlert(sym, last, prevC, moveATR, rvol) {
  const up = last >= prevC;
  const arrow = up ? '🟢 ▲' : '🔴 ▼';
  const pct = (last - prevC) / prevC * 100;
  const volLine = (rvol != null)
    ? `📊 RVOL parcial ${rvol.toFixed(1)}× (SIP)`
    : `📊 volumen aún sin barra SIP (primeros min)`;
  return `👀 <b>PRE-AVISO — ${sym}</b>\n` +
         `${arrow} moviéndose · ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%\n` +
         `Precio $${last.toFixed(2)} (tiempo real) · prev $${prevC.toFixed(2)}\n` +
         `⚡ ${Math.abs(moveATR).toFixed(1)}×ATR · ${volLine}\n` +
         `⏱ EN VIVO sin delay · ⚠ sin confirmar — vigilar (no es señal).`;
}

// ── BARRIDO ──────────────────────────────────────────────────────────────────
async function runScan() {
  const now = new Date().toLocaleString('es', { timeZone: 'America/New_York' });
  let frac = 0;
  try {
    await buildBaseline();
    const barsBySym = await fetchDailyBars(TODAY_DAYS);
    const livePrices = await fetchLivePrices();         // precio real-time IEX (best-effort)
    const today = nyDate(new Date());
    frac = sessionFraction(new Date(Date.now() - DELAY_MS));

    const evals = [];
    let hits = 0, fired = 0, preFired = 0;
    for (const sym of UNIVERSE) {
      const base = BASELINE[sym];
      if (!base) continue;
      const s = STATE[sym] || (STATE[sym] = { lastAlertTs: 0, lastDir: null, lastPreTs: 0, confirmedTs: 0 });

      // ── CONFIRMACIÓN (SIP retrasado: RVOL ≥ umbral Y mov ≥ N×ATR) ──
      const ev = evaluate(sym, barsBySym[sym], frac, today);
      if (ev) {
        evals.push(ev);
        if (ev.passed) {
          hits++;
          const fresh = (Date.now() - s.lastAlertTs) >= COOLDOWN_MS;
          const dirChanged = s.lastDir !== ev.dir;
          if (fresh || dirChanged) {
            await sendTelegram(buildAlert(ev));
            s.lastAlertTs = Date.now(); s.lastDir = ev.dir; s.confirmedTs = Date.now();
            fired++;
          }
          continue;   // ya confirmó → no mandamos pre-aviso del mismo ticker
        }
      }

      // ── PRE-AVISO (precio real-time IEX; sirve aunque aún no haya barra SIP de hoy) ──
      //   CANDADO DE HORA: solo en RTH (09:30–16:00 ET) por RELOJ REAL → mata after-hours/fin de semana.
      //   FILTRO DE VOLUMEN: si ya hay barra SIP de hoy, exige RVOL parcial ≥ PRE_RVOL_MIN (normalizado
      //   por hora) para descartar velas flojas. En los primeros ~16 min aún no hay barra SIP →
      //   se permite por momentum solo (es la ventana ÚNICA del pre-aviso, donde el confirmado ni puede).
      if (isRTH(new Date())) {
        const lp = livePrices[sym];
        const prevC = prevCloseOf(barsBySym[sym], today);
        if (lp != null && prevC != null && base.atr > 0) {
          const moveLiveATR = (lp - prevC) / base.atr;
          const recentlyConfirmed = (Date.now() - s.confirmedTs) < COOLDOWN_MS;
          const preFresh = (Date.now() - s.lastPreTs) >= PRE_COOLDOWN_MS;
          const hasVol = ev && isFinite(ev.rvol);             // ¿tenemos RVOL parcial SIP de hoy?
          const volOK  = !hasVol || ev.rvol >= PRE_RVOL_MIN;  // sin barra (ventana temprana) → momentum solo
          if (!recentlyConfirmed && preFresh && volOK && Math.abs(moveLiveATR) >= PRE_ATR_MULT) {
            await sendTelegram(buildPreAlert(sym, lp, prevC, moveLiveATR, hasVol ? ev.rvol : null));
            s.lastPreTs = Date.now();
            preFired++;
          }
        }
      }
    }

    // top movers por RVOL (para que SE VEA el dato real del pilarto, crucen o no el umbral)
    const top = evals.slice().sort((a, b) => b.rvol - a.rvol).slice(0, 8)
      .map(e => ({ sym: e.sym, rvol: e.rvol, moveATR: e.moveATR, pct: e.pct, dir: e.dir, passed: e.passed }));

    console.log(`[RADAR SCAN] ${now} · evaluados:${evals.length} · candidatos:${hits} · alertas:${fired} · pre-avisos:${preFired} · sesión:${(frac * 100).toFixed(0)}%`);
    LAST = { at: now, hits, fired, preFired, evaluated: evals.length, universe: UNIVERSE.length, baseline: Object.keys(BASELINE).length, frac, top, error: null };
  } catch (e) {
    console.error(`[RADAR SCAN] ${now} · ERROR:`, e.message);
    LAST = { at: now, hits: 0, fired: 0, preFired: 0, evaluated: 0, universe: UNIVERSE.length, baseline: Object.keys(BASELINE).length, frac, top: [], error: e.message };
  }
}

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
console.log('════════════════════════════════════════════');
console.log('  LIQUIDMAP PRO · RADAR v1.3 — pre-aviso (RTH + RVOL parcial) + confirmación SIP');
console.log('════════════════════════════════════════════');
console.log(`   Universo  : ${UNIVERSE.length} tickers`);
console.log(`   Umbrales  : RVOL ≥ ${RVOL_MIN}× (normalizado por hora) · movimiento ≥ ${ATR_MULT}×ATR(${ATR_PERIOD})`);
console.log(`   Pre-aviso : solo RTH 09:30–16:00 ET · mov ≥ ${PRE_ATR_MULT}×ATR · RVOL parcial ≥ ${PRE_RVOL_MIN}× (o momentum en primeros ~16 min)`);
console.log(`   Barrido   : cada ${SCAN_INTERVAL / 60000} min · cooldown ${COOLDOWN_MS / 3600000}h por ticker`);
console.log(`   Feed      : SIP retrasado ${DELAY_MS / 60000} min (100% volumen, free)`);
console.log(`   Alpaca key: ${ALPACA_KEY ? 'OK' : 'FALTA (ALPACA_KEY_ID)'}`);
console.log(`   TG radar  : ${TG_TOKEN ? 'OK' : 'FALTA (TELEGRAM_TOKEN_RADAR)'}`);
console.log('   FLAGGER de candidatos — no es gatillo de ejecución.');
console.log('════════════════════════════════════════════\n');

// ── MINI-SERVIDOR HTTP (para calificar como Web Service free de Render) ──────
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  const l = LAST;
  const rows = (l.top || []).map(t => {
    const arrow = t.dir === 'up' ? '🟢▲' : '🔴▼';
    const mark  = t.passed ? '<span class="ok">●</span>' : '<span style="opacity:.35">○</span>';
    return `<tr><td>${mark} <b>${t.sym}</b></td><td>${arrow} ${t.pct >= 0 ? '+' : ''}${t.pct.toFixed(2)}%</td>` +
           `<td class="k">${t.rvol.toFixed(2)}×</td><td>${Math.abs(t.moveATR).toFixed(2)}×ATR</td></tr>`;
  }).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="60">
    <title>LiquidMap RADAR</title>
    <style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#cdd6e4;padding:32px;line-height:1.6}
    b{color:#7fd1ff}.ok{color:#5fd38a}.err{color:#ff6b6b}.k{color:#ffd66b}
    table{border-collapse:collapse;margin-top:8px}td{padding:4px 16px 4px 0;border-bottom:1px solid #1c2230}
    th{text-align:left;padding:4px 16px 4px 0;color:#8aa;font-weight:600;font-size:.85em}</style>
    <h2>📡 LiquidMap PRO · RADAR v1.3</h2>
    <p>Universo: <b>${UNIVERSE.length}</b> · Confirmado: RVOL ≥ <b>${RVOL_MIN}×</b> · mov ≥ <b>${ATR_MULT}×ATR(${ATR_PERIOD})</b> · feed SIP ≈15 min</p>
    <p>👀 Pre-aviso: <b>solo RTH 09:30–16:00 ET</b> · mov ≥ <b>${PRE_ATR_MULT}×ATR</b> · RVOL parcial ≥ <b>${PRE_RVOL_MIN}×</b> ·
       mercado ahora: <b class="${isRTH(new Date()) ? 'ok' : 'err'}">${isRTH(new Date()) ? 'ABIERTO (RTH)' : 'CERRADO'}</b></p>
    <p>Alpaca key: <span class="${ALPACA_KEY ? 'ok' : 'err'}">${ALPACA_KEY ? 'OK' : 'FALTA'}</span> ·
       TG radar: <span class="${TG_TOKEN ? 'ok' : 'err'}">${TG_TOKEN ? 'OK' : 'FALTA'}</span></p>
    <hr>
    <p>Último barrido: <b>${l.at || 'aún no corrió'}</b> · sesión transcurrida: <b>${(l.frac * 100).toFixed(0)}%</b></p>
    <p>Baseline: <b>${l.baseline}/${UNIVERSE.length}</b> · evaluados: <b>${l.evaluated}</b> ·
       Candidatos: <b class="k">${l.hits}</b> · Alertas: <b class="k">${l.fired}</b> · 👀 Pre-avisos: <b class="k">${l.preFired|0}</b></p>
    ${l.error ? `<p class="err">Error: ${l.error}</p>` : ''}
    <h3 style="margin-top:24px">Top movers por RVOL <span style="opacity:.6;font-weight:400">(el dato del pilarto — el ● cruzó el umbral)</span></h3>
    ${rows ? `<table><tr><th>Ticker</th><th>% día</th><th>RVOL</th><th>Mov</th></tr>${rows}</table>`
           : '<p style="opacity:.6">Sin lecturas todavía (mercado cerrado o primeros minutos de la sesión).</p>'}
    <p style="opacity:.6;margin-top:24px">FLAGGER de candidatos — no es gatillo de ejecución. Refresca cada ${SCAN_INTERVAL / 60000} min.</p>`);
}).listen(PORT, '0.0.0.0', () => console.log(`[RADAR] HTTP de estado en puerto ${PORT}`));

runScan();
setInterval(runScan, SCAN_INTERVAL);
