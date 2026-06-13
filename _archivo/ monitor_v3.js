// ============================================================
//  monitor_v3.js — LiquidMap PRO · FRANCOTIRADOR
//  Lógica idéntica al mapa HTML crypto
//  Una señal por ticker · 4H manda · Confluencia obligatoria
//  23 Mayo 2026
// ============================================================

const fetch = require('node-fetch');

// ── CONFIG ────────────────────────────────────────────────
const TELEGRAM_TOKEN = '8676337394:AAEVIwDY2xGwAmE7hMWcjjAMedjws_vjzSU';
const CHAT_IDS       = ['1218461753', '1373309702'];
const FINNHUB_TOKEN  = 'd0qsf2hr01qgsn5hm2k0d0qsf2hr01qgsn5hm2kg';

// ── TICKERS — solo los 3 principales ─────────────────────
const CRYPTO_TICKERS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'];

// ── ESTADO GLOBAL ─────────────────────────────────────────
// Guarda la última señal y dirección por ticker
// Para no repetir la misma señal ni contradecirse
const state = {};
// state[ticker] = {
//   dir4H: 'BUY'|'SELL'|'NEUTRAL',   // dirección del 4H — el juez
//   lastSignal: 'BUY'|'SELL'|null,   // última señal disparada
//   lastTs: 0,                        // timestamp última señal
//   lastCandle4H: null,               // última vela 4H procesada
// }

const COOLDOWN_MS   = 4 * 60 * 60 * 1000; // 4H entre señales del mismo ticker
const SCAN_INTERVAL = 5 * 60 * 1000;      // revisar cada 5 min

// ── ATR por ticker ────────────────────────────────────────
const ATR_PCT = { BTCUSDT:0.022, ETHUSDT:0.028, XRPUSDT:0.035 };

// ── HELPERS ───────────────────────────────────────────────
function fmt(n, ref) {
  const p = parseFloat(n);
  if (isNaN(p)) return '—';
  if (ref >= 10000) return p.toFixed(0);
  if (ref >= 1000)  return p.toFixed(1);
  if (ref >= 10)    return p.toFixed(3);
  return p.toFixed(4);
}

function getATR(ticker, price) {
  return price * (ATR_PCT[ticker] || 0.025);
}

function evalQuality(score) {
  if (score >= 5) return '🔥 FUERTE';
  if (score >= 3) return '✅ VÁLIDA';
  if (score >= 1) return '⚡ MODERADA';
  return '❌ RUIDO';
}

function initState(ticker) {
  if (!state[ticker]) {
    state[ticker] = { dir4H:'NEUTRAL', lastSignal:null, lastTs:0, lastCandle4H:null };
  }
  return state[ticker];
}

// ── FETCH BINANCE ─────────────────────────────────────────
async function fetchCandles(symbol, interval, limit = 60) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r   = await fetch(url);
  const raw = await r.json();
  if (!Array.isArray(raw)) return [];
  return raw.map(k => ({
    t: k[0],                    // openTime — para detectar vela nueva
    o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
    closed: k[6] < Date.now()  // vela cerrada si closeTime < ahora
  }));
}

async function fetchFundingRate(symbol) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
    const r   = await fetch(url);
    const d   = await r.json();
    return Array.isArray(d) && d.length ? parseFloat(d[0].fundingRate) * 100 : 0;
  } catch { return 0; }
}

// ── VOLUME PROFILE → POC + VALUE AREA ────────────────────
// Exactamente igual al mapa HTML
function buildVP(candles, bins = 50) {
  const mn = Math.min(...candles.map(c => c.l));
  const mx = Math.max(...candles.map(c => c.h));
  const bs = (mx - mn) / bins;
  const profile = new Array(bins).fill(0);
  for (const c of candles) {
    const i = Math.max(0, Math.min(bins - 1, Math.floor((c.c - mn) / bs)));
    profile[i] += c.v;
  }
  return { profile, min: mn, max: mx, binSize: bs };
}

function getPOC(vp) {
  const i = vp.profile.indexOf(Math.max(...vp.profile));
  return vp.min + i * vp.binSize + vp.binSize / 2;
}

function getVA(vp) {
  const tot = vp.profile.reduce((a, b) => a + b, 0);
  const tgt = tot * 0.70;
  const mi  = vp.profile.indexOf(Math.max(...vp.profile));
  let lo = mi, hi = mi, acc = vp.profile[mi];
  while (acc < tgt) {
    const al = lo > 0 ? vp.profile[lo - 1] : 0;
    const ah = hi < vp.profile.length - 1 ? vp.profile[hi + 1] : 0;
    if (al >= ah && lo > 0)               { lo--; acc += al; }
    else if (hi < vp.profile.length - 1)  { hi++; acc += ah; }
    else break;
  }
  return { vah: vp.min + hi * vp.binSize + vp.binSize, val: vp.min + lo * vp.binSize };
}

// ── CVD — igual al mapa HTML ──────────────────────────────
function calcCVD(candles) {
  let cvd = 0, buyV = 0, sellV = 0;
  for (const c of candles) {
    if (c.c >= c.o) { buyV += c.v; cvd += c.v; }
    else            { sellV += c.v; cvd -= c.v; }
  }
  const total  = buyV + sellV || 1;
  const buyPct = buyV / total * 100;
  return { cvd, buyV, sellV, buyPct };
}

// ── ZONAS DE LIQUIDEZ — igual al mapa HTML ─────────────────
function buildZones(candles, mid) {
  const z   = [];
  const mv  = Math.max(...candles.map(b => b.v || 1));
  for (let i = 2; i < candles.length - 2; i++) {
    const b   = candles[i];
    const age = (candles.length - i) / candles.length;
    const st  = Math.min(1, 0.4 + (1 - age) * 0.5 + (b.v / mv) * 0.2);
    if (b.h >= candles[i-1].h && b.h >= candles[i-2].h &&
        b.h >= candles[i+1].h && b.h >= candles[i+2].h)
      z.push({ price: b.h, strength: st, side: b.h > mid ? 'above' : 'below' });
    if (b.l <= candles[i-1].l && b.l <= candles[i-2].l &&
        b.l <= candles[i+1].l && b.l <= candles[i+2].l)
      z.push({ price: b.l, strength: st, side: b.l < mid ? 'below' : 'above' });
  }
  return z;
}

// ── COMPUTE SIGNAL — IDÉNTICO AL MAPA HTML ────────────────
function computeSignal(price, candles, fundingRate) {
  const vp  = buildVP(candles, 50);
  const poc = getPOC(vp);
  const va  = getVA(vp);
  const { cvd, buyV, sellV, buyPct } = calcCVD(candles);
  const zones = buildZones(candles, price);

  let score = 0;
  const conf = [];

  // 1. Precio vs POC — igual al mapa
  if (price > poc)  { score += 1; conf.push('Precio > POC ✓'); }
  else              { score -= 1; conf.push('Precio < POC ✗'); }

  // 2. CVD + Buy% — igual al mapa
  if      (cvd > 0 && buyPct > 52) { score += 1; conf.push('CVD + Buy% ✓'); }
  else if (cvd < 0 && buyPct < 48) { score -= 1; conf.push('CVD − Sell% ✗'); }

  // 3. Funding Rate contrarian — igual al mapa
  if      (fundingRate < -0.02) { score += 1; conf.push('FR negativo (shorts pagando) ✓'); }
  else if (fundingRate >  0.05) { score -= 1; conf.push('FR alto (longs pagando) ✗'); }

  // 4. Zonas de liquidez — igual al mapa
  const nearSup = zones.find(z => z.side === 'below' && Math.abs(z.price - price)/price < 0.012 && z.strength > 0.6);
  const nearRes = zones.find(z => z.side === 'above' && Math.abs(z.price - price)/price < 0.012 && z.strength > 0.6);
  if (nearSup) { score += 1; conf.push('Soporte líquido ✓'); }
  if (nearRes) { score -= 1; conf.push('Resistencia líquida ✗'); }

  // 5. Value Area — igual al mapa
  if (price >= va.val && price <= va.vah) { score += 0.5; conf.push('En Value Area ✓'); }

  const type       = score >= 2 ? 'BUY' : score <= -2 ? 'SELL' : 'NEUTRAL';
  const finalScore = Math.round(Math.abs(score) * 1.5);

  return { type, score: finalScore, rawScore: score, conf, poc, va, cvd, buyPct };
}

// ── STOP HUNT — igual al mapa HTML ───────────────────────
// Solo en 4H y 1D (sin ruido de TF menores)
function detectSH(candle) {
  if (!candle) return null;
  const { o, h, l, c } = candle;
  const body  = Math.abs(c - o);
  const range = h - l;
  if (!range || !body) return null;

  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  // mecha >= 2x cuerpo Y >= 40% del rango — mismo criterio que el mapa
  const isBearSH = upperWick >= body * 2 && upperWick / range >= 0.40;
  const isBullSH = lowerWick >= body * 2 && lowerWick / range >= 0.40;

  if (!isBearSH && !isBullSH) return null;
  return isBullSH ? 'SH_BUY' : 'SH_SELL';
}

// ── CHOCH — Cambio de carácter (reversión) ────────────────
// Detecta cuando el precio rompe el último swing opuesto
// Más estricto que BOS — requiere romper estructura previa
function detectCHOCH(candles) {
  if (candles.length < 20) return null;
  const recent = candles.slice(-20);
  const mid    = candles.slice(-40, -20);
  if (!mid.length) return null;

  const midHigh  = Math.max(...mid.map(c => c.h));
  const midLow   = Math.min(...mid.map(c => c.l));
  const lastClose = recent[recent.length - 1].c;
  const prevClose = recent[recent.length - 2].c;

  // CHoCH alcista: precio rompe máximo de estructura bajista previa
  // con dos cierres consecutivos arriba
  if (lastClose > midHigh && prevClose > midHigh * 0.998)
    return { type: 'CHOCH_BUY', label: '⚡ CHoCH ALCISTA', desc: 'Cambio de carácter — posible reversión alcista' };

  // CHoCH bajista: precio rompe mínimo de estructura alcista previa
  if (lastClose < midLow && prevClose < midLow * 1.002)
    return { type: 'CHOCH_SELL', label: '⚡ CHoCH BAJISTA', desc: 'Cambio de carácter — posible reversión bajista' };

  return null;
}

// ── BOS — continuación de estructura ─────────────────────
function detectBOS(candles) {
  if (candles.length < 15) return null;
  const recent = candles.slice(-10);
  const prev   = candles.slice(-20, -10);
  if (!prev.length) return null;

  const prevHigh  = Math.max(...prev.map(c => c.h));
  const prevLow   = Math.min(...prev.map(c => c.l));
  const lastClose = recent[recent.length - 1].c;
  const lastHigh  = Math.max(...recent.map(c => c.h));
  const lastLow   = Math.min(...recent.map(c => c.l));

  if (lastClose > prevHigh && lastHigh > prevHigh)
    return { type: 'BOS_BUY',  label: '📈 BOS ALCISTA', desc: 'Quiebre de estructura alcista confirmado' };
  if (lastClose < prevLow && lastLow < prevLow)
    return { type: 'BOS_SELL', label: '📉 BOS BAJISTA', desc: 'Quiebre de estructura bajista confirmado' };

  return null;
}

// ── CONSTRUIR MENSAJE TELEGRAM ────────────────────────────
function buildMsg(ticker, price, sig, struct, sh, tf) {
  const isBuy = sig.type === 'BUY';
  const atr   = getATR(ticker, price);
  const ref   = price;

  const sl  = isBuy ? price - atr * 1.5 : price + atr * 1.5;
  const tp1 = isBuy ? price + atr * 2   : price - atr * 2;
  const tp2 = isBuy ? price + atr * 3   : price - atr * 3;
  const tp3 = isBuy ? price + atr * 5   : price - atr * 5;

  const arrow = isBuy ? '▲ BUY — COMPRA 🟢' : '▼ SELL — VENTA 🔴';
  const qual  = evalQuality(sig.score);
  const conf  = sig.conf.join('\n  • ');

  // Estructura detectada (CHoCH o BOS)
  const structLine = struct
    ? `\n🔷 ${struct.label} — ${struct.desc}` : '';

  // Stop Hunt si hubo
  const shLine = sh
    ? `\n🎯 Stop Hunt ${sh === 'SH_BUY' ? 'alcista 🐂' : 'bajista 🐻'} detectado` : '';

  return `🌐 <b>SEÑAL INSTITUCIONAL</b>
${arrow}

🎯 <b>${ticker}</b> · ${tf}
💰 Precio: <b>${fmt(price, ref)}</b>
⭐ Score: ${sig.score}/5 · ${qual}

📊 Confluencias:
  • ${conf}${structLine}${shLine}

🔴 CVD: ${sig.cvd > 0 ? '▲ Positivo' : '▼ Negativo'} · ${sig.buyPct.toFixed(0)}% Buy
📐 POC: ${fmt(sig.poc, ref)}

🛑 SL:  ${fmt(sl, ref)}
✅ TP1: ${fmt(tp1, ref)} (1:2)
✅ TP2: ${fmt(tp2, ref)} (1:3)
🔶 TP3: ${fmt(tp3, ref)} (1:5)

⚡ LiquidMap PRO · Señal Institucional`;
}

// ── ENVIAR TELEGRAM ───────────────────────────────────────
async function sendTelegram(text) {
  try {
    await Promise.all(CHAT_IDS.map(id =>
      fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      })
    ));
    console.log(`[TG] ${text.substring(0, 80).replace(/\n/g, ' ')}`);
  } catch(e) { console.error('[TG ERROR]', e.message); }
}

// ════════════════════════════════════════════════════════
//  SCANNER PRINCIPAL — LÓGICA FRANCOTIRADOR
// ════════════════════════════════════════════════════════
async function scanTicker(symbol) {
  const s = initState(symbol);

  try {
    // ── PASO 1: Obtener datos 4H (el juez) ──────────────
    const candles4H = await fetchCandles(symbol, '4h', 60);
    if (candles4H.length < 20) return;

    const lastCandle4H = candles4H[candles4H.length - 1];
    const price        = lastCandle4H.c;
    const fr           = await fetchFundingRate(symbol);

    // ── PASO 2: Detectar si la vela 4H es nueva ──────────
    // Solo procesamos cuando cierra una vela nueva de 4H
    // Evita spam entre velas
    const candleId = lastCandle4H.t;
    if (s.lastCandle4H === candleId) {
      // misma vela — no hacer nada
      return;
    }

    // ── PASO 3: Computar señal 4H — igual que el mapa ────
    const sig4H    = computeSignal(price, candles4H, fr);
    const struct4H = detectCHOCH(candles4H) || detectBOS(candles4H);
    const sh4H     = detectSH(lastCandle4H);

    // Actualizar dirección del juez
    s.dir4H = sig4H.type;

    console.log(`[${symbol}] 4H: ${sig4H.type} score=${sig4H.score} struct=${struct4H?.type||'—'} SH=${sh4H||'—'}`);

    // ── PASO 4: REGLAS DEL FRANCOTIRADOR ─────────────────

    // REGLA 1: Score mínimo 3 en 4H
    if (sig4H.score < 3) {
      console.log(`[${symbol}] Score insuficiente (${sig4H.score}/5) — silencio`);
      s.lastCandle4H = candleId;
      return;
    }

    // REGLA 2: No repetir la misma dirección
    if (s.lastSignal === sig4H.type && Date.now() - s.lastTs < COOLDOWN_MS) {
      console.log(`[${symbol}] Misma dirección en cooldown — silencio`);
      s.lastCandle4H = candleId;
      return;
    }

    // REGLA 3: Si la señal es NEUTRAL → silencio
    if (sig4H.type === 'NEUTRAL') {
      console.log(`[${symbol}] NEUTRAL — silencio`);
      s.lastCandle4H = candleId;
      return;
    }

    // REGLA 4: Confirmar con 1H en la MISMA dirección
    const candles1H = await fetchCandles(symbol, '1h', 30);
    const sig1H     = computeSignal(price, candles1H, fr);

    if (sig1H.type !== sig4H.type && sig1H.type !== 'NEUTRAL') {
      console.log(`[${symbol}] 1H (${sig1H.type}) contradice 4H (${sig4H.type}) — silencio`);
      s.lastCandle4H = candleId;
      return;
    }

    // REGLA 5: CHoCH tiene prioridad sobre BOS
    // Si hay CHoCH en dirección opuesta a la señal → silencio (mercado confuso)
    if (struct4H) {
      const structDir = struct4H.type.includes('BUY') ? 'BUY' : 'SELL';
      if (structDir !== sig4H.type) {
        console.log(`[${symbol}] Estructura (${struct4H.type}) contradice señal — silencio`);
        s.lastCandle4H = candleId;
        return;
      }
    }

    // ── PASO 5: TODAS LAS REGLAS PASADAS → DISPARAR ──────
    console.log(`[${symbol}] ✅ SEÑAL VALIDADA: ${sig4H.type} score=${sig4H.score} — DISPARANDO`);

    const msg = buildMsg(symbol, price, sig4H, struct4H, sh4H, '4H 🔴');
    await sendTelegram(msg);

    // Actualizar estado
    s.lastSignal   = sig4H.type;
    s.lastTs       = Date.now();
    s.lastCandle4H = candleId;

  } catch(e) {
    console.error(`[${symbol}] Error:`, e.message);
  }
}

// ── LOOP PRINCIPAL ────────────────────────────────────────
async function runScan() {
  const now = new Date().toISOString();
  console.log(`\n[SCAN] ${now}`);

  for (const sym of CRYPTO_TICKERS) {
    await scanTicker(sym);
    await new Promise(r => setTimeout(r, 800));
  }
  console.log(`[SCAN] Completo.`);
}

// ── ARRANQUE ──────────────────────────────────────────────
console.log('🎯 LiquidMap PRO Monitor v3 — FRANCOTIRADOR');
console.log(`   Tickers : ${CRYPTO_TICKERS.join(', ')}`);
console.log(`   Motor   : POC + CVD + FR + Zonas + CHoCH + BOS`);
console.log(`   TF Juez : 4H · confirmación 1H`);
console.log(`   Cooldown: 4 horas por ticker`);
console.log(`   Dispara : solo al cierre de vela 4H nueva con confluencia`);

runScan();
setInterval(runScan, SCAN_INTERVAL);
