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

// Estado VIVO de qué está cocinando ahora (para la pestaña 🔥 EN COCCIÓN del mapa vía /coccion).
const COOKING_NOW = {};                     // { sym: { sym, score, rvol, moveATR, last, dir, conviction, read, ts } }
const COOKING_TTL_MS = 12 * 60 * 1000;      // una cocción "vigente" ~2 barridos

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
const DELAY_MS     = (process.env.RADAR_DELAY_MS != null && process.env.RADAR_DELAY_MS !== '')
  ? +process.env.RADAR_DELAY_MS              // Algo Trader Plus (real-time): bajar via env, ej. 30000 (30s) o 0
  : 16 * 60 * 1000;                          // default: SIP free exige end > 15 min → pedimos a 16 min
const SCAN_INTERVAL = 5 * 60 * 1000;       // barrido cada 5 min
const COOLDOWN_MS   = 2 * 60 * 60 * 1000;  // anti-spam: 1 alerta por ticker cada 2h
const SNAP_BATCH    = 50;                  // símbolos por llamada
const MIN_FRAC      = 0.05;                // < 5% de sesión transcurrida → RVOL aún no confiable

// ── PRE-AVISO (capa temprana, precio en TIEMPO REAL IEX — sin delay) ────────
const PRE_ATR_MULT    = 1.2;               // movimiento mínimo para el pre-aviso (más bajo que el confirmado)
const PRE_RVOL_MIN    = 1.3;               // RVOL parcial mínimo (SIP, normalizado por hora) — filtra velas flojas
const PRE_COOLDOWN_MS = 60 * 60 * 1000;    // 1 pre-aviso por ticker por hora

// ── CAPA 3: EN COCCIÓN (anticipación — volumen acelerando con precio aún quieto) ──
const COOK_COOLDOWN_MS = 60 * 60 * 1000;   // 1 cocción por ticker por hora
let scoreCooking = null;
try { ({ scoreCooking } = require('./cooking_detector.js')); }
catch (_) { console.log('[RADAR] cooking_detector.js no cargado — capa EN COCCIÓN desactivada'); }

// ── CAPA 2 (cara): DIRECCIÓN del finalista (CVD real + dark pool + GEX) — fail-open ──
const CAPA_CARA_WINDOW_MIN = +process.env.CAPA_CARA_WINDOW_MIN || 60;  // ventana de flujo (min)
let characterizeFinalist = null, fetchAggressorCVD = null, fetchLargePrints = null, getOptionsMetrics = null;
try { ({ characterizeFinalist } = require('./finalist_direction.js')); }
catch (_) { console.log('[RADAR] finalist_direction.js no cargado — dirección off'); }
try { ({ fetchAggressorCVD } = require('./cvd_live.js')); } catch (_) {}
try { ({ fetchLargePrints } = require('./prints_live.js')); } catch (_) {}
try { ({ getOptionsMetrics } = require('./options_live.js')); } catch (_) {}

// Corre la capa CARA SOLO sobre un finalista que ya cocina. Fail-open total:
// cualquier fetch que falle → null y la dirección queda "undetermined" (el aviso igual sale).
async function characterizeCooking(sym, price){
  if(!characterizeFinalist || !fetchAggressorCVD) return null;
  const end = new Date().toISOString();
  const start = new Date(Date.now() - CAPA_CARA_WINDOW_MIN*60000).toISOString();
  const [cvdR, darkR, gexR] = await Promise.allSettled([
    fetchAggressorCVD(sym, start, end, { rth:true }),
    fetchLargePrints ? fetchLargePrints(sym, start, end, { rth:true }) : Promise.resolve(null),
    getOptionsMetrics ? getOptionsMetrics(sym) : Promise.resolve(null),
  ]);
  const cvd  = cvdR.status  === 'fulfilled' ? cvdR.value  : null;
  const dark = darkR.status === 'fulfilled' ? darkR.value : null;
  const gexM = gexR.status  === 'fulfilled' ? gexR.value  : null;
  let buyPct = null;
  if(cvd && isFinite(cvd.buyV) && isFinite(cvd.sellV)){
    const tot = cvd.buyV + cvd.sellV;
    if(tot > 0) buyPct = cvd.buyV / tot * 100;
  }
  return characterizeFinalist({
    cvd:  cvd  ? { buyPct, cvd: cvd.cvd, cvdReal: cvd.cvdReal, partial: cvd.partial } : {},
    dark: dark ? { offExchangePct: dark.offExchangePct, offExchangeNotional: dark.offExchangeNotional, count: dark.count } : {},
    gex:  (gexM && gexM.ok && gexM.gex) ? { callWall: gexM.gex.callWall, putWall: gexM.gex.putWall, gammaFlip: gexM.gex.gammaFlip } : null,
    price: (gexM && gexM.spot) ? gexM.spot : price,
  });
}
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

function buildCookAlert(h, cook, dir) {
  const arrow = h.dir === 'up' ? '🟢 ▲' : '🔴 ▼';
  const lines = [
    `🍳 <b>EN COCCIÓN — ${h.sym}</b>`,
    `🔥 Volumen acelerando ${cook.rvol.toFixed(1)}× (Δ+${cook.accel.toFixed(1)}) con precio aún quieto (${Math.abs(cook.moveATR).toFixed(1)}×ATR)`,
    `Precio $${h.last.toFixed(2)} · sesgo ${arrow} · score ${cook.score}/100`,
  ];
  if (dir && dir.read) lines.push(`📡 ${dir.read}`);
  lines.push(`⚠ Anticipación (más temprano que el pre-aviso) — se está cargando un movimiento. Vigilar, no es señal.`);
  return lines.join('\n');
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
    let hits = 0, fired = 0, preFired = 0, cookFired = 0;
    for (const sym of UNIVERSE) {
      const base = BASELINE[sym];
      if (!base) continue;
      const s = STATE[sym] || (STATE[sym] = { lastAlertTs: 0, lastDir: null, lastPreTs: 0, confirmedTs: 0, lastRvol: null, lastCookTs: 0 });

      // ── CONFIRMACIÓN (SIP retrasado: RVOL ≥ umbral Y mov ≥ N×ATR) ──
      const ev = evaluate(sym, barsBySym[sym], frac, today);
      if (ev) {
        evals.push(ev);
        const prevRvol = s.lastRvol;        // rvol del barrido anterior (para ver la aceleración)
        s.lastRvol = ev.rvol;               // guardar SIEMPRE para el próximo barrido
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
        // ── CAPA 3 · EN COCCIÓN (anticipación: volumen acelerando + precio aún quieto) ──
        if (scoreCooking && isRTH(new Date())) {
          const cook = scoreCooking({ rvol: ev.rvol, rvolPrev: prevRvol, moveATR: ev.moveATR, frac: ev.frac });
          if (cook && cook.cooking) {
            // estado vivo para la pestaña 🔥 (SIEMPRE que cocina, barato — sin capa cara)
            const prevC = COOKING_NOW[sym] || {};
            COOKING_NOW[sym] = { sym, score: cook.score, rvol: cook.rvol, moveATR: cook.moveATR, last: ev.last,
                                 dir: prevC.dir || null, conviction: prevC.conviction != null ? prevC.conviction : null, read: prevC.read || null, ts: Date.now() };
            const recentlyConfirmed = (Date.now() - s.confirmedTs) < COOLDOWN_MS;
            const cookFresh = (Date.now() - (s.lastCookTs || 0)) >= COOK_COOLDOWN_MS;
            if (!recentlyConfirmed && cookFresh) {
              let dirRead = null;
              try { dirRead = await characterizeCooking(sym, ev.last); } catch (_) {}
              if (dirRead) { COOKING_NOW[sym].dir = dirRead.direction; COOKING_NOW[sym].conviction = dirRead.conviction; COOKING_NOW[sym].read = dirRead.read; }
              await sendTelegram(buildCookAlert(ev, cook, dirRead));
              s.lastCookTs = Date.now();
              cookFired++;
              continue;   // ya avisamos cocción → no duplicar con pre-aviso este barrido
            }
          }
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

    console.log(`[RADAR SCAN] ${now} · evaluados:${evals.length} · candidatos:${hits} · alertas:${fired} · pre-avisos:${preFired} · cocción:${cookFired} · sesión:${(frac * 100).toFixed(0)}%`);
    LAST = { at: now, hits, fired, preFired, cookFired, evaluated: evals.length, universe: UNIVERSE.length, baseline: Object.keys(BASELINE).length, frac, top, error: null };
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
console.log(`   Feed      : SIP · ${DELAY_MS >= 15*60*1000 ? 'retrasado ' + (DELAY_MS/60000).toFixed(0) + ' min (free)' : (DELAY_MS/1000).toFixed(0) + 's ≈ TIEMPO REAL (Algo Trader Plus)'} · 100% volumen`);
console.log(`   Alpaca key: ${ALPACA_KEY ? 'OK' : 'FALTA (ALPACA_KEY_ID)'}`);
console.log(`   TG radar  : ${TG_TOKEN ? 'OK' : 'FALTA (TELEGRAM_TOKEN_RADAR)'}`);
console.log('   FLAGGER de candidatos — no es gatillo de ejecución.');
console.log('════════════════════════════════════════════\n');

// ── MINI-SERVIDOR HTTP (para calificar como Web Service free de Render) ──────

// ════════════════════════════════════════════════════════════════════════════
// /backtest — geometría + SELECTIVIDAD + RÉGIMEN (aditivo, display puro)
//   Re-resuelve el ledger del gist contra BARES REALES (Alpaca SIP), prueba
//   geometrías, y desglosa por atributo + por RÉGIMEN (¿la señal va con la
//   tendencia de fondo o en contra?) para separar "señal mala" de "régimen malo".
//   Régimen = EMA50 en 4H (dirección + pendiente) + ratio de eficiencia (chop vs
//   tendencia). Ordering intrabar PESIMISTA (stop-first). Abrí /backtest.
//   Filtros: ?setup= ?grade= ?side= ?minscore= ?cvd= ?regime=up|down|neutral
//            ?align=alineada|contra|neutral ?eff=tendencia|mixto|chop
//            ?geom=G1_estructural ?order=optimistic ?limit=N
// ════════════════════════════════════════════════════════════════════════════
const BT_GIST_ID  = process.env.BACKTEST_GIST_ID || 'd92ed46ade54195d8164f7e58d010866';
const BT_TFMAP    = { '5m':'5Min','15m':'15Min','1H':'1Hour','4H':'4Hour','1D':'1Day' };
const BT_TFMS     = { '5m':3e5,'15m':9e5,'1H':36e5,'4H':1.44e7,'1D':8.64e7 };
const BT_ATR_LEN  = 14, BT_ATR_LOOKBACK = 40, BT_REGIME_LOOKBACK = 60;
// Régimen tunables:
const BT_GAP_FACTOR = 6;     // velas intradía solo existen en horario mercado → agrandar la ventana de fetch en calendario
const BT_EMA_SLOW = 50;      // EMA de tendencia de fondo (en la TF de la señal)
const BT_SLOPE_BARS = 6;     // pendiente: EMA ahora vs hace N barras (~1 día en 4H)
const BT_ER_WIN = 20;        // ventana del ratio de eficiencia (chop vs tendencia)
const BT_ER_TREND = 0.5, BT_ER_MIX = 0.3;   // umbrales eficiencia
// EXPANSIÓN del mapa (paridad EXACTA con computeFlow L963-970): atrFast(7)/atrSlow(21) sobre TR.
// Solo para el CROSS-TAB vs eficiencia — NO cambia el régimen que decide (ese es EMA50 + ER).
const BT_EXP_FAST = 7, BT_EXP_SLOW = 21, BT_EXP_HI = 1.15, BT_EXP_LO = 0.85;
// ↓↓↓ EDITÁ las geometrías. slAtr=stop en ATR; tps=[{r,size}]; beAfter=BE tras R; trail={afterR,atrMult}
const BT_GEOMS = [
  { name:'BASE_actual',    slAtr:0.5,  tps:[{r:6.0,size:1.0}],                                  beAfter:null, trail:null },
  { name:'G1_estructural', slAtr:1.25, tps:[{r:1.0,size:0.34},{r:2.0,size:0.33},{r:3.5,size:0.33}], beAfter:1.0, trail:{afterR:2.0,atrMult:1.0} },
  { name:'G2_2step',       slAtr:1.5,  tps:[{r:1.0,size:0.5},{r:2.5,size:0.5}],                  beAfter:1.0, trail:null },
  { name:'G3_runner',      slAtr:1.5,  tps:[{r:1.0,size:0.34},{r:2.5,size:0.33}],                beAfter:1.0, trail:{afterR:1.5,atrMult:1.2} },
];
const BT_ROUND = x => Math.round(x*1000)/1000;

async function btFetchLedger() {
  const r = await fetch(`https://api.github.com/gists/${BT_GIST_ID}`,
    { headers: { 'accept':'application/vnd.github+json', 'user-agent':'liquidmap-backtest' } });
  if (!r.ok) throw new Error(`gist ${r.status} (¿id/privacidad?)`);
  const j = await r.json();
  let text = '';
  for (const f of Object.values(j.files || {})) {
    let c = f.content || '';
    if (f.truncated && f.raw_url) { const rr = await fetch(f.raw_url, { headers:{ 'user-agent':'liquidmap-backtest' } }); c = await rr.text(); }
    text += c + '\n';
  }
  const sigs = [];
  for (let line of text.split('\n')) {
    line = line.trim(); if (!line) continue;
    if (line[0] !== '{') { if (line.includes('"id"')) line = '{' + line.replace(/^[^{]*/, ''); else continue; }
    try { const o = JSON.parse(line); if (o.sym && o.entry && o.type) sigs.push(o); } catch {}
  }
  return sigs;
}

async function btFetchTfBars(sym, tf, startISO, endISO) {
  const timeframe = BT_TFMAP[tf] || tf;
  let pageToken = null; const out = [];
  do {
    const qs = `symbols=${sym}&timeframe=${timeframe}&start=${startISO}&end=${encodeURIComponent(endISO)}` +
               `&adjustment=raw&feed=sip&limit=10000` + (pageToken ? `&page_token=${pageToken}` : '');
    const d = await alpacaGet(`/v2/stocks/bars?${qs}`);
    for (const b of ((d.bars && d.bars[sym]) || [])) out.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c });
    pageToken = d.next_page_token || null;
  } while (pageToken);
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ── RÉGIMEN: dirección de fondo (EMA50 + pendiente) + eficiencia (chop vs tendencia) ──
function btEMASeries(vals, p){ const k = 2/(p+1); let e = vals[0]; const out = [e]; for (let i=1;i<vals.length;i++){ e = vals[i]*k + e*(1-k); out.push(e);} return out; }
function btRegime(bars, idx) {
  if (idx < BT_EMA_SLOW + 5) return null;
  const closes = bars.slice(0, idx + 1).map(b => b.c);
  const ema = btEMASeries(closes, BT_EMA_SLOW);
  const px = closes[idx], es = ema[idx], esPrev = ema[Math.max(0, idx - BT_SLOPE_BARS)];
  let dir = 'neutral';
  if (px > es && es > esPrev) dir = 'up'; else if (px < es && es < esPrev) dir = 'down';
  const n = Math.min(BT_ER_WIN, idx);
  let net = Math.abs(closes[idx] - closes[idx - n]), path = 0;
  for (let i = idx - n + 1; i <= idx; i++) path += Math.abs(closes[i] - closes[i - 1]);
  const er = path > 0 ? net / path : 0;
  const eff = er >= BT_ER_TREND ? 'tendencia' : er >= BT_ER_MIX ? 'mixto' : 'chop';
  return { dir, eff };
}

// EXPANSIÓN del mapa AS-OF la señal — espejo BYTE-A-BYTE de computeFlow (mapa L957-970).
// atrN = media de los últimos min(n,len) TR; expRatio = atrFast(7)/atrSlow(21).
function btExpRegime(bars, idx) {
  const w = bars.slice(0, idx + 1);
  if (w.length < BT_EXP_SLOW + 1) return null;
  const tr = [];
  for (let i = 1; i < w.length; i++) {
    const pc = w[i - 1].c;
    tr.push(Math.max(w[i].h - w[i].l, Math.abs(w[i].h - pc), Math.abs(w[i].l - pc)));
  }
  const atrN = (arr, n) => arr.length ? arr.slice(-Math.min(n, arr.length)).reduce((a, v) => a + v, 0) / Math.min(n, arr.length) : 0;
  const fast = atrN(tr, BT_EXP_FAST), slow = atrN(tr, BT_EXP_SLOW);
  const ratio = slow > 0 ? fast / slow : 1;
  return ratio >= BT_EXP_HI ? 'EXPANSIÓN' : ratio <= BT_EXP_LO ? 'COMPRESIÓN' : 'NEUTRAL';
}

// Resuelve UNA señal bajo UNA geometría contra bares reales. long = BUY.
function btResolve(sig, geom, bars, order) {
  const entryIdx = bars.findIndex(b => b.t >= sig.ts);
  if (entryIdx < BT_ATR_LEN + 1) return null;
  const atr = computeATR(bars.slice(Math.max(0, entryIdx - BT_ATR_LOOKBACK), entryIdx), BT_ATR_LEN);
  if (!atr || atr <= 0) return null;
  const long = sig.type === 'BUY', entry = sig.entry, dir = long ? 1 : -1;
  const Rprice = geom.slAtr * atr; if (Rprice <= 0) return null;
  let stop = entry - dir * Rprice, remaining = 1.0, realizedR = 0, beMoved = false;
  const tps = geom.tps.map(t => ({ px: entry + dir * t.r * Rprice, size: t.size, r: t.r, hit: false }));
  const favR = px => dir * (px - entry) / Rprice;
  const win = sig.horizonBars || 30, last = Math.min(bars.length - 1, entryIdx + win);
  for (let i = entryIdx + 1; i <= last; i++) {
    const bar = bars[i], hiFav = long ? bar.h : bar.l;
    const stopHit = long ? bar.l <= stop : bar.h >= stop;
    const nextTP = tps.find(t => !t.hit);
    const tpHit = nextTP && (long ? bar.h >= nextTP.px : bar.l <= nextTP.px);
    const seq = order === 'optimistic' ? ['tp','stop'] : ['stop','tp'];
    let closed = false;
    for (const ev of seq) {
      if (ev === 'stop' && stopHit) { realizedR += remaining * (dir * (stop - entry) / Rprice); remaining = 0; closed = true; break; }
      if (ev === 'tp' && tpHit) {
        realizedR += nextTP.size * nextTP.r; remaining = Math.max(0, remaining - nextTP.size); nextTP.hit = true;
        if (geom.beAfter != null && !beMoved && favR(hiFav) >= geom.beAfter) { stop = entry; beMoved = true; }
        if (remaining <= 1e-9) closed = true;
      }
    }
    if (closed) return BT_ROUND(realizedR);
    if (geom.beAfter != null && !beMoved && favR(hiFav) >= geom.beAfter) { stop = entry; beMoved = true; }
    if (geom.trail && favR(hiFav) >= geom.trail.afterR) {
      const t = hiFav - dir * geom.trail.atrMult * atr; stop = long ? Math.max(stop, t) : Math.min(stop, t);
    }
  }
  if (remaining > 1e-9) realizedR += remaining * (dir * (bars[last].c - entry) / Rprice);
  return BT_ROUND(realizedR);
}

const BT_mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const BT_median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };

function btBucketTable(rowsForGeom, keyFn, label) {
  const b = {};
  for (const r of rowsForGeom) { const k = String(keyFn(r.sig) ?? '—'); (b[k] ??= []).push(r.R); }
  const entries = Object.entries(b).map(([k, arr]) => ({ k, exp: BT_mean(arr), win: 100*arr.filter(x=>x>0).length/arr.length, n: arr.length, sum: arr.reduce((a,c)=>a+c,0) }))
    .sort((a, c) => c.exp - a.exp);
  return `<h4 style="color:#8aa;margin:18px 0 4px">por ${label}</h4><table><tr><th>${label}</th><th>exp</th><th>win%</th><th>n</th><th>suma</th></tr>` +
    entries.map(e => `<tr><td><b>${e.k}</b></td><td class="${e.exp>0?'ok':'err'}">${e.exp>=0?'+':''}${e.exp.toFixed(2)}R</td><td class="k">${e.win.toFixed(0)}%</td><td>${e.n}</td><td>${e.sum.toFixed(1)}R</td></tr>`).join('') + `</table>`;
}

async function runBacktest(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const order = q.get('order') === 'optimistic' ? 'optimistic' : 'pessimistic';
  const limit = +q.get('limit') || 0;
  const gName = q.get('geom') || 'G1_estructural';
  const fSetup = q.get('setup'), fGrade = q.get('grade'), fSide = q.get('side'), fCvd = q.get('cvd'), fMin = +q.get('minscore') || 0;
  const fRegime = q.get('regime'), fAlign = q.get('align'), fEff = q.get('eff');
  const EXP_MAP = { expansion: 'EXPANSIÓN', compresion: 'COMPRESIÓN', neutral: 'NEUTRAL' };
  const fExpQ = q.get('exp'); const fExp = fExpQ ? (EXP_MAP[fExpQ.toLowerCase()] || fExpQ) : null;
  let sigs = await btFetchLedger();
  sigs = sigs.filter(s => BT_TFMAP[s.tf]);
  sigs = sigs.filter(s =>
    (!fSetup || s.setup === fSetup) && (!fGrade || s.grade === fGrade) &&
    (!fSide || s.type === fSide) && (!fCvd || String(s.cvdSource || 'null') === fCvd) &&
    (!fMin || (s.score || 0) >= fMin));
  if (limit > 0) sigs = sigs.slice(-limit);

  const groups = {};
  for (const s of sigs) (groups[`${s.sym}|${s.tf}`] ??= []).push(s);
  const rows = [];
  let usable = 0, skipped = 0;
  for (const key in groups) {
    const [sym, tf] = key.split('|'); const g = groups[key];
    const tfms = BT_TFMS[tf] || 1.44e7;
    const preBars = Math.max(BT_ATR_LOOKBACK, BT_REGIME_LOOKBACK) + 2;
    const minTs = Math.min(...g.map(s => s.ts)) - preBars * tfms * BT_GAP_FACTOR;
    const maxTs = Math.max(...g.map(s => s.ts)) + 40 * tfms * BT_GAP_FACTOR;
    let bars = [];
    try { bars = await btFetchTfBars(sym, tf, new Date(minTs).toISOString(), new Date(Math.min(maxTs, Date.now())).toISOString()); }
    catch (e) { skipped += g.length; continue; }
    for (const sig of g) {
      // régimen (una vez por señal)
      const eIdx = bars.findIndex(b => b.t >= sig.ts);
      const rgm = eIdx >= 0 ? btRegime(bars, eIdx) : null;
      sig._dir = rgm ? rgm.dir : '?';
      sig._eff = rgm ? rgm.eff : '?';
      sig._exp = eIdx >= 0 ? (btExpRegime(bars, eIdx) || '?') : '?';   // EXPANSIÓN del mapa (para el cross-tab)
      sig._align = !rgm ? '?' : (rgm.dir === 'neutral' ? 'neutral' :
        ((sig.type === 'BUY' && rgm.dir === 'up') || (sig.type === 'SELL' && rgm.dir === 'down')) ? 'alineada' : 'contra');
      let any = false;
      for (const geom of BT_GEOMS) { const R = btResolve(sig, geom, bars, order); if (R != null) { rows.push({ geom: geom.name, R, sig }); any = true; } }
      if (any) usable++; else skipped++;
    }
  }

  // filtros de régimen a nivel row (necesitan bares ya computados)
  const rowsF = rows.filter(r =>
    (!fRegime || r.sig._dir === fRegime) && (!fAlign || r.sig._align === fAlign) && (!fEff || r.sig._eff === fEff) &&
    (!fExp || r.sig._exp === fExp));

  const byGeom = {}; for (const r of rowsF) (byGeom[r.geom] ??= []).push(r);
  const abTable = BT_GEOMS.map(G => {
    const rs = (byGeom[G.name] || []).map(x => x.R);
    if (!rs.length) return '';
    const exp = BT_mean(rs), win = 100 * rs.filter(x => x > 0).length / rs.length;
    return `<tr${G.name===gName?' style="background:#101828"':''}><td><b>${G.name}</b></td><td class="${exp>0?'ok':'err'}">${exp>=0?'+':''}${exp.toFixed(2)}R</td>` +
           `<td class="k">${win.toFixed(0)}%</td><td>${BT_median(rs)>=0?'+':''}${BT_median(rs).toFixed(2)}R</td><td>${rs.reduce((a,b)=>a+b,0).toFixed(1)}R</td><td>${rs.length}</td></tr>`;
  }).join('');

  const gRows = byGeom[gName] || [];
  const sel = gRows.length ? (
    `<div style="border:1px solid #24406a;border-radius:8px;padding:2px 16px 12px;margin:12px 0;background:#0c1220">
       <h4 style="color:#7fd1ff;margin:12px 0 0">🎯 RÉGIMEN — ¿señal vs tendencia de fondo? (el corte que decide)</h4>` +
    btBucketTable(gRows, s => s._align, 'alineación (con/contra la tendencia)') +
    btBucketTable(gRows, s => `${s._align} · ${s._eff}`, 'alineación × eficiencia') +
    btBucketTable(gRows, s => s._dir, 'régimen de fondo') +
    btBucketTable(gRows, s => s._eff, 'eficiencia (tendencia/chop) — NUESTRO corte, define el edge') +
    `<h4 style="color:#ffb066;margin:18px 0 0">🔬 CROSS-TAB — ¿la EXPANSIÓN del mapa mide lo mismo que la eficiencia?</h4>` +
    btBucketTable(gRows, s => s._exp, 'EXPANSIÓN del mapa (volatilidad ATR7/ATR21) — el gate candidato') +
    btBucketTable(gRows, s => `${s._eff} · ${s._exp}`, 'eficiencia × EXPANSIÓN (si coincidieran: tendencia↔EXPANSIÓN, chop↔COMPRESIÓN)') +
    `</div>` +
    btBucketTable(gRows, s => s.setup, 'setup') +
    btBucketTable(gRows, s => s.grade, 'grade') +
    btBucketTable(gRows, s => s.type, 'lado') +
    btBucketTable(gRows, s => s.score, 'score') +
    btBucketTable(gRows, s => s.cvdSource || 'null', 'fuente CVD')
  ) : '<p style="opacity:.6">sin filas para esa geometría/filtros</p>';

  const activeFilters = [fSetup&&`setup=${fSetup}`, fGrade&&`grade=${fGrade}`, fSide&&`side=${fSide}`, fCvd&&`cvd=${fCvd}`, fMin&&`minscore=${fMin}`, fRegime&&`regime=${fRegime}`, fAlign&&`align=${fAlign}`, fEff&&`eff=${fEff}`, fExpQ&&`exp=${fExpQ}`].filter(Boolean).join(' · ') || 'ninguno';

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Backtest geometría + selectividad + régimen</title>
    <style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#cdd6e4;padding:32px;line-height:1.6}
    b{color:#7fd1ff}.ok{color:#5fd38a}.err{color:#ff6b6b}.k{color:#ffd66b}
    table{border-collapse:collapse;margin:6px 0 18px}td,th{padding:6px 18px 6px 0;border-bottom:1px solid #1c2230;text-align:left}
    th{color:#8aa;font-weight:600;font-size:.85em}h2,h3{color:#7fd1ff}small{opacity:.65}</style>
    <h2>🔬 Backtest · geometría + selectividad + <span style="color:#5fd38a">régimen</span></h2>
    <p>Señales usables: <b>${usable}</b> · descartadas: <b>${skipped}</b> · en el corte: <b>${rowsF.length/BT_GEOMS.length|0}</b> · ordering: <b>${order}</b> · filtros: <b class="k">${activeFilters}</b></p>
    <p><small>Régimen = EMA${BT_EMA_SLOW} en la TF de la señal (dirección + pendiente ${BT_SLOPE_BARS} barras) · eficiencia = |mov neto|/|recorrido| en ${BT_ER_WIN} barras (≥${BT_ER_TREND}=tendencia, ≥${BT_ER_MIX}=mixto, si no chop). "alineada" = la señal va CON la tendencia de fondo. EXPANSIÓN del mapa = atrFast(7)/atrSlow(21) (≥1.15=EXPANSIÓN, ≤0.85=COMPRESIÓN) — es VOLATILIDAD, distinto eje que la eficiencia; el cross-tab lo prueba. Filtros: ?regime= ?align= ?eff= ?exp=expansion|compresion|neutral + ?setup= ?grade= ?side= ?minscore= ?cvd= ?geom= ?order=optimistic. Editá en BT_* / BT_GEOMS.</small></p>
    <h3>A/B de geometrías${activeFilters!=='ninguno'?' (subset filtrado)':''}</h3>
    <table><tr><th>Geometría</th><th>Expectativa</th><th>win%</th><th>mediana</th><th>suma</th><th>n</th></tr>${abTable||'<tr><td colspan=6>sin datos</td></tr>'}</table>
    <h3>Desglose de <b>${gName}</b> <small>(verdes = subset con expectativa &gt; 0)</small></h3>
    ${sel}
    <p><small>Aditivo · no toca el generador de señales · flagger de calibración, no gatillo de ejecución.</small></p>`);
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  // ── /coccion : lista viva de finalistas cocinando (JSON) para la pestaña 🔥 del mapa ──
  if (req.url === '/coccion' || req.url.startsWith('/coccion?')) {
    const now = Date.now();
    const cooking = Object.values(COOKING_NOW)
      .filter(c => now - c.ts < COOKING_TTL_MS)
      .sort((a, b) => b.score - a.score)
      .map(c => ({ sym: c.sym, score: c.score, rvol: +(+c.rvol).toFixed(2), moveATR: +Math.abs(c.moveATR).toFixed(2),
                   last: c.last, dir: c.dir, conviction: c.conviction, read: c.read, ageSec: Math.round((now - c.ts) / 1000) }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, at: LAST.at, rth: isRTH(new Date()), count: cooking.length, cooking }));
    return;
  }
  // ── /backtest : geometría + selectividad + régimen (HTML) ──
  if (req.url === '/backtest' || req.url.startsWith('/backtest?')) {
    runBacktest(req, res).catch(e => {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<pre style="color:#ff6b6b;background:#0b0e14;padding:24px;font-family:system-ui;white-space:pre-wrap">Error /backtest: ${String(e && e.message || e).replace(/</g,'&lt;')}</pre>`);
    });
    return;
  }
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
