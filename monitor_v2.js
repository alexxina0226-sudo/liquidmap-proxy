// ============================================================
//  monitor_v2.js — LiquidMap PRO · Job 24/7 · Calidad Institucional
//  Misma lógica que el mapa HTML — Score, POC, CVD, Zonas, SL/TP
//  22 Mayo 2026
// ============================================================

const fetch = require('node-fetch');

// ── CONFIG ───────────────────────────────────────────────────
const TELEGRAM_TOKEN = '8676337394:AAEVIwDY2xGwAmE7hMWcjjAMedjws_vjzSU';
const CHAT_IDS       = ['1218461753', '1373309702'];
const FINNHUB_TOKEN  = 'd0qsf2hr01qgsn5hm2k0d0qsf2hr01qgsn5hm2kg';
const INTERVAL_MS    = 5 * 60 * 1000;

// ── TICKERS ──────────────────────────────────────────────────
const CRYPTO_TICKERS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT',
  // agregar más aquí
];
const STOCK_TICKERS = [
  'SPY','QQQ','AMZN','NVDA','IWM',
  'TSLA','AAPL','MSFT','GOOG','META',
  'WMT','DIA','AMD',
  // agregar más aquí
];

// ── ATR INSTITUCIONAL (% diario promedio) ─────────────────────
const ATR_MAP = {
  BTCUSDT:0.022, ETHUSDT:0.028, SOLUSDT:0.040, XRPUSDT:0.035,
  BNBUSDT:0.025, ADAUSDT:0.040, DOGEUSDT:0.050,
  SPY:0.008, QQQ:0.010, IWM:0.010, DIA:0.008,
  AAPL:0.012, MSFT:0.012, GOOG:0.013, META:0.018,
  AMZN:0.015, NVDA:0.022, TSLA:0.030, AMD:0.025, WMT:0.010,
};

// ── ESTADO — cooldown por ticker + tipo ──────────────────────
const lastAlert  = {};
const lastSigDir = {}; // BUY/SELL/NEUTRAL por ticker — evita repetir
const COOLDOWN   = 20 * 60 * 1000; // 20 min

// ── HELPERS ──────────────────────────────────────────────────
function getATR(ticker, price) {
  return parseFloat(price) * (ATR_MAP[ticker.toUpperCase()] || 0.022);
}

function fmt(n, price) {
  const p = parseFloat(n);
  if (isNaN(p)) return '—';
  if (price >= 10000) return p.toFixed(0);
  if (price >= 1000)  return p.toFixed(1);
  if (price >= 100)   return p.toFixed(2);
  if (price >= 1)     return p.toFixed(3);
  return p.toFixed(5);
}

function evalQuality(score) {
  if (score >= 5) return '🔥 FUERTE';
  if (score >= 3) return '✅ VÁLIDA';
  if (score >= 1) return '⚡ MODERADA';
  return '❌ RUIDO';
}

function canAlert(ticker, type) {
  const key  = `${ticker}_${type}`;
  const last = lastAlert[key] || 0;
  if (Date.now() - last < COOLDOWN) return false;
  lastAlert[key] = Date.now();
  return true;
}

async function sendTelegram(text) {
  try {
    await Promise.all(CHAT_IDS.map(id =>
      fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id:id, text, parse_mode:'HTML', disable_web_page_preview:true }),
      })
    ));
    console.log(`[TG] ${text.substring(0,100).replace(/\n/g,' ')}`);
  } catch(e) { console.error('[TG ERROR]', e.message); }
}

// ── FETCH BINANCE ─────────────────────────────────────────────
async function fetchBinanceCandles(symbol, interval, limit=50) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r   = await fetch(url);
  const raw = await r.json();
  if (!Array.isArray(raw)) return [];
  return raw.map(k => ({ o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
}

// ── FETCH FINNHUB ─────────────────────────────────────────────
function resToSec(res) {
  return { '60':3600, 'D':86400 }[res] || 3600;
}
async function fetchFinnhubCandles(symbol, resolution, count=50) {
  const to   = Math.floor(Date.now()/1000);
  const from = to - (count+10) * resToSec(resolution);
  const url  = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&token=${FINNHUB_TOKEN}`;
  const r    = await fetch(url);
  const d    = await r.json();
  if (!d || d.s === 'no_data' || !d.c) return [];
  return d.c.map((_,i) => ({ o:d.o[i], h:d.h[i], l:d.l[i], c:d.c[i], v:d.v[i] })).slice(-count);
}

// ════════════════════════════════════════════════════════════
//  MOTOR DE ANÁLISIS — igual al mapa HTML
// ════════════════════════════════════════════════════════════

// Volume Profile → POC + Value Area (70%)
function buildVP(candles, bins=50) {
  if (!candles.length) return null;
  const mn = Math.min(...candles.map(c=>c.l));
  const mx = Math.max(...candles.map(c=>c.h));
  const bs = (mx - mn) / bins;
  const profile = new Array(bins).fill(0);
  for (const c of candles) {
    const i = Math.max(0, Math.min(bins-1, Math.floor((c.c - mn)/bs)));
    profile[i] += c.v || 0;
  }
  return { profile, min:mn, max:mx, binSize:bs };
}

function getPOC(vp) {
  const i = vp.profile.indexOf(Math.max(...vp.profile));
  return vp.min + i * vp.binSize + vp.binSize/2;
}

function getVA(vp) {
  const tot = vp.profile.reduce((a,b)=>a+b,0), tgt = tot*0.70;
  const mi  = vp.profile.indexOf(Math.max(...vp.profile));
  let lo=mi, hi=mi, acc=vp.profile[mi];
  while(acc < tgt) {
    const al = lo>0 ? vp.profile[lo-1] : 0;
    const ah = hi<vp.profile.length-1 ? vp.profile[hi+1] : 0;
    if(al>=ah && lo>0){lo--;acc+=al;}
    else if(hi<vp.profile.length-1){hi++;acc+=ah;}
    else break;
  }
  return { vah: vp.min+hi*vp.binSize+vp.binSize, val: vp.min+lo*vp.binSize };
}

// CVD — Cumulative Volume Delta
function calcCVD(candles) {
  let cvd=0, buyV=0, sellV=0;
  for (const c of candles) {
    const delta = c.c >= c.o ? c.v : -c.v;
    cvd   += delta;
    buyV  += c.c >= c.o ? c.v : 0;
    sellV += c.c < c.o  ? c.v : 0;
  }
  const total  = buyV + sellV || 1;
  const buyPct = (buyV/total*100);
  return { cvd, buyV, sellV, buyPct, sellPct:100-buyPct };
}

// Zonas de liquidez (swing highs/lows de las últimas velas)
function buildZones(candles, mid) {
  const z   = [];
  const bars = candles.slice(-100);
  const mv  = Math.max(...bars.map(b=>b.v||1));
  for (let i=2; i<bars.length-2; i++) {
    const b   = bars[i];
    const age = (bars.length-i)/bars.length;
    const st  = Math.min(1, 0.4 + (1-age)*0.5 + (b.v/mv)*0.2);
    // Swing High
    if(b.h>=bars[i-1].h && b.h>=bars[i-2].h && b.h>=bars[i+1].h && b.h>=bars[i+2].h)
      z.push({ price:b.h, strength:st, side:b.h>mid?'above':'below' });
    // Swing Low
    if(b.l<=bars[i-1].l && b.l<=bars[i-2].l && b.l<=bars[i+1].l && b.l<=bars[i+2].l)
      z.push({ price:b.l, strength:st, side:b.l<mid?'below':'above' });
  }
  return z;
}

// BOS/CHOCH — detecta quiebre de estructura
function detectStructure(candles) {
  if (candles.length < 10) return null;
  const last = candles.slice(-10);
  const prev = candles.slice(-20, -10);
  if (!prev.length) return null;

  const prevHigh = Math.max(...prev.map(c=>c.h));
  const prevLow  = Math.min(...prev.map(c=>c.l));
  const lastHigh = Math.max(...last.map(c=>c.h));
  const lastLow  = Math.min(...last.map(c=>c.l));
  const lastClose= last[last.length-1].c;

  // BOS alcista: precio rompe máximo previo con cierre arriba
  if (lastClose > prevHigh && lastHigh > prevHigh)
    return { type:'BOS_BUY', label:'BOS ALCISTA 🟢', desc:'Quiebre de estructura alcista confirmado' };
  // BOS bajista: precio rompe mínimo previo con cierre abajo
  if (lastClose < prevLow && lastLow < prevLow)
    return { type:'BOS_SELL', label:'BOS BAJISTA 🔴', desc:'Quiebre de estructura bajista confirmado' };

  return null;
}

// Stop Hunt — mecha institucional por TF
function detectStopHunt(candle, tf) {
  if (!candle) return null;
  const { o, h, l, c } = candle;
  const body  = Math.abs(c - o);
  const range = h - l;
  if (!range || !body) return null;

  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  const isBearSH = upperWick >= body*2 && upperWick >= range*0.4;
  const isBullSH = lowerWick >= body*2 && lowerWick >= range*0.4;
  if (!isBearSH && !isBullSH) return null;

  const weights = { 60:3, 240:4, 1440:5 };
  const labels  = { 60:'1H 🔴', 240:'4H 🔴', 1440:'1D 🔴' };
  const notes   = { 60:'ALTO PESO', 240:'MUY ALTO PESO', 1440:'MÁXIMO PESO' };

  return {
    type  : isBullSH ? 'SH_BUY' : 'SH_SELL',
    score : weights[tf] || 3,
    label : labels[tf]  || `${tf}m`,
    note  : notes[tf]   || 'ALTO PESO',
  };
}

// ── COMPUTE SIGNAL — idéntico al mapa HTML ────────────────────
function computeSignal(price, candles, ticker) {
  const vp  = buildVP(candles, 50);
  if (!vp) return { type:'NEUTRAL', score:0, conf:[] };

  const poc = getPOC(vp);
  const va  = getVA(vp);
  const { cvd, buyPct } = calcCVD(candles);
  const zones = buildZones(candles, price);

  let score = 0;
  const conf = [];

  // 1. Precio vs POC (= lógica exacta del mapa)
  if (price > poc) { score += 1; conf.push('Precio > POC ✓'); }
  else             { score -= 1; conf.push('Precio < POC ✗'); }

  // 2. CVD + Buy%
  if      (cvd > 0 && buyPct > 52) { score += 1; conf.push('CVD + Buy% ✓'); }
  else if (cvd < 0 && buyPct < 48) { score -= 1; conf.push('CVD - Sell% ✗'); }

  // 3. Value Area
  if (price >= va.val && price <= va.vah) { score += 0.5; conf.push('En Value Area ✓'); }

  // 4. Zonas de liquidez
  const nearSup = zones.find(z => z.side==='below' && Math.abs(z.price-price)/price < 0.012 && z.strength>0.6);
  const nearRes = zones.find(z => z.side==='above' && Math.abs(z.price-price)/price < 0.012 && z.strength>0.6);
  if (nearSup) { score += 1; conf.push('Soporte líquido ✓'); }
  if (nearRes) { score -= 1; conf.push('Resistencia líquida ✗'); }

  // 5. BOS/CHOCH
  const bos = detectStructure(candles);
  if (bos) {
    if (bos.type === 'BOS_BUY')  { score += 1; conf.push('BOS Alcista ✓'); }
    if (bos.type === 'BOS_SELL') { score -= 1; conf.push('BOS Bajista ✗'); }
  }

  const finalScore = Math.round(Math.abs(score) * 1.5);
  const type = score >= 2 ? 'BUY' : score <= -2 ? 'SELL' : 'NEUTRAL';
  return { type, score:finalScore, rawScore:score, conf, poc, va, cvd, buyPct, bos };
}

// ── BUILDER MENSAJES TELEGRAM ─────────────────────────────────
function buildSignalMsg(ticker, price, sig, tfLabel, isCrypto) {
  const icon = isCrypto ? '🌐' : '📊';
  const isBuy = sig.type === 'BUY';
  const atr   = getATR(ticker, price);

  const sl  = isBuy ? price - atr*1.5 : price + atr*1.5;
  const tp1 = isBuy ? price + atr*2   : price - atr*2;
  const tp2 = isBuy ? price + atr*3   : price - atr*3;
  const tp3 = isBuy ? price + atr*5   : price - atr*5;

  const q     = evalQuality(sig.score);
  const arrow = isBuy ? '▲ BUY — COMPRA 🟢' : '▼ SELL — VENTA 🔴';
  const conf  = sig.conf.join('\n  • ');
  const bosLine = sig.bos ? `\n🔷 ${sig.bos.label} — ${sig.bos.desc}` : '';

  return `${icon} <b>SEÑAL INSTITUCIONAL</b>
${arrow}

🎯 <b>${ticker}</b> · ${tfLabel}
💰 Precio: <b>${fmt(price, price)}</b>
⭐ Score: ${sig.score}/5 · ${q}

📊 Confluencias:
  • ${conf}${bosLine}

🔴 CVD: ${sig.cvd > 0 ? '▲ Positivo' : '▼ Negativo'} (${sig.buyPct.toFixed(0)}% Buy)
📐 POC: ${fmt(sig.poc, price)}

🛑 SL:  ${fmt(sl, price)}
✅ TP1: ${fmt(tp1, price)} (1:2)
✅ TP2: ${fmt(tp2, price)} (1:3)
🔶 TP3: ${fmt(tp3, price)} (1:5)

⚡ LiquidMap PRO · Monitor 24/7`;
}

function buildSHMsg(ticker, price, sh, isCrypto) {
  const icon  = isCrypto ? '🌐' : '📊';
  const isBuy = sh.type === 'SH_BUY';
  const atr   = getATR(ticker, price);

  const sl  = isBuy ? price - atr*1.5 : price + atr*1.5;
  const tp1 = isBuy ? price + atr*2   : price - atr*2;
  const tp2 = isBuy ? price + atr*3   : price - atr*3;

  return `${icon} <b>STOP HUNT ${isBuy ? 'ALCISTA 🟢 🐂' : 'BAJISTA 🔴 🐻'}</b>

🎯 <b>${ticker}</b> · ${sh.label} · ${sh.note}
💰 Precio: <b>${fmt(price, price)}</b>
⭐ Score: ${sh.score}/5

🛑 SL:  ${fmt(sl, price)}
✅ TP1: ${fmt(tp1, price)}
✅ TP2: ${fmt(tp2, price)}

⚡ LiquidMap PRO · Monitor 24/7`;
}

function buildBOSMsg(ticker, price, bos, tfLabel, isCrypto) {
  const icon  = isCrypto ? '🌐' : '📊';
  const isBuy = bos.type === 'BOS_BUY';
  const atr   = getATR(ticker, price);

  const sl  = isBuy ? price - atr*1.5 : price + atr*1.5;
  const tp1 = isBuy ? price + atr*2   : price - atr*2;
  const tp2 = isBuy ? price + atr*3   : price - atr*3;

  return `${icon} <b>${bos.label}</b>

🎯 <b>${ticker}</b> · ${tfLabel}
💰 Precio: <b>${fmt(price, price)}</b>
📌 ${bos.desc}

🛑 SL:  ${fmt(sl, price)}
✅ TP1: ${fmt(tp1, price)}
✅ TP2: ${fmt(tp2, price)}

⚡ LiquidMap PRO · Monitor 24/7`;
}

// ── SCANNER CRYPTO ────────────────────────────────────────────
async function scanCrypto(symbol) {
  try {
    // Usamos 4H como TF principal (más confiable para señales)
    const tfs = [
      { interval:'1h',  tf:60,   label:'1H 🔴'  },
      { interval:'4h',  tf:240,  label:'4H 🔴'  },
      { interval:'1d',  tf:1440, label:'1D 🔴'  },
    ];

    for (const { interval, tf, label } of tfs) {
      const candles = await fetchBinanceCandles(symbol, interval, 60);
      if (candles.length < 10) continue;

      const price = candles[candles.length-1].c;
      const last  = candles[candles.length-1];

      // ① Señal principal (BUY/SELL) — misma lógica que el mapa
      const sig = computeSignal(price, candles, symbol);

      if (sig.type !== 'NEUTRAL' && sig.score >= 3) {
        const sigKey = `${symbol}_SIG_${sig.type}_${tf}`;
        // Solo dispara si cambió de dirección
        if (lastSigDir[`${symbol}_${tf}`] !== sig.type && canAlert(symbol, sigKey)) {
          lastSigDir[`${symbol}_${tf}`] = sig.type;
          await sendTelegram(buildSignalMsg(symbol, price, sig, label, true));
          await new Promise(r=>setTimeout(r,500));
        }
      } else if (sig.type === 'NEUTRAL') {
        lastSigDir[`${symbol}_${tf}`] = 'NEUTRAL';
      }

      // ② Stop Hunt
      const sh = detectStopHunt(last, tf);
      if (sh && canAlert(symbol, `SH_${sh.type}_${tf}`)) {
        await sendTelegram(buildSHMsg(symbol, price, sh, true));
        await new Promise(r=>setTimeout(r,500));
      }

      // ③ BOS independiente (aunque no haya señal completa)
      const bos = detectStructure(candles);
      if (bos && canAlert(symbol, `${bos.type}_${tf}`)) {
        await sendTelegram(buildBOSMsg(symbol, price, bos, label, true));
        await new Promise(r=>setTimeout(r,500));
      }

      await new Promise(r=>setTimeout(r,300));
    }
  } catch(e) { console.error(`[CRYPTO ${symbol}]`, e.message); }
}

// ── SCANNER STOCKS ────────────────────────────────────────────
async function scanStock(symbol) {
  try {
    const tfs = [
      { resolution:'60', tf:60,   label:'1H 🔴' },
      { resolution:'D',  tf:1440, label:'1D 🔴' },
    ];

    for (const { resolution, tf, label } of tfs) {
      const candles = await fetchFinnhubCandles(symbol, resolution, 60);
      if (candles.length < 10) continue;

      const price = candles[candles.length-1].c;
      const last  = candles[candles.length-1];

      // ① Señal principal
      const sig = computeSignal(price, candles, symbol);

      if (sig.type !== 'NEUTRAL' && sig.score >= 3) {
        const sigKey = `${symbol}_SIG_${sig.type}_${tf}`;
        if (lastSigDir[`${symbol}_${tf}`] !== sig.type && canAlert(symbol, sigKey)) {
          lastSigDir[`${symbol}_${tf}`] = sig.type;
          await sendTelegram(buildSignalMsg(symbol, price, sig, label, false));
          await new Promise(r=>setTimeout(r,500));
        }
      } else if (sig.type === 'NEUTRAL') {
        lastSigDir[`${symbol}_${tf}`] = 'NEUTRAL';
      }

      // ② Stop Hunt
      const sh = detectStopHunt(last, tf);
      if (sh && canAlert(symbol, `SH_${sh.type}_${tf}`)) {
        await sendTelegram(buildSHMsg(symbol, price, sh, false));
        await new Promise(r=>setTimeout(r,500));
      }

      // ③ BOS
      const bos = detectStructure(candles);
      if (bos && canAlert(symbol, `${bos.type}_${tf}`)) {
        await sendTelegram(buildBOSMsg(symbol, price, bos, label, false));
        await new Promise(r=>setTimeout(r,500));
      }

      await new Promise(r=>setTimeout(r,400));
    }
  } catch(e) { console.error(`[STOCK ${symbol}]`, e.message); }
}

// ── LOOP PRINCIPAL ────────────────────────────────────────────
async function runScan() {
  const now = new Date().toISOString();
  console.log(`\n[SCAN] ${now} — ${CRYPTO_TICKERS.length} crypto · ${STOCK_TICKERS.length} stocks`);

  for (const sym of CRYPTO_TICKERS) {
    await scanCrypto(sym);
    await new Promise(r=>setTimeout(r,500));
  }
  for (const sym of STOCK_TICKERS) {
    await scanStock(sym);
    await new Promise(r=>setTimeout(r,600));
  }
  console.log(`[SCAN] Completo.`);
}

// ── ARRANQUE ──────────────────────────────────────────────────
console.log('🚀 LiquidMap PRO Monitor v2 — Calidad Institucional');
console.log(`   Crypto : ${CRYPTO_TICKERS.join(', ')}`);
console.log(`   Stocks : ${STOCK_TICKERS.join(', ')}`);
console.log(`   Engine : POC + CVD + Zonas + BOS + Stop Hunt`);
console.log(`   TF     : 1H · 4H · 1D`);
console.log(`   Cada   : ${INTERVAL_MS/60000} min`);

runScan();
setInterval(runScan, INTERVAL_MS);
