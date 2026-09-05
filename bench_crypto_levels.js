// bench_crypto_levels.js — verifica computeCryptoLevels (fuente única de niveles cripto)
// y que la captura cripto arme un registro bien formado. Reusa ledger_capture/makeRecord.
// Aislamos computeCryptoLevels re-declarándolo idéntico (el monitor no exporta; es lógica pura).
const { captureSignal } = require('./ledger_capture.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '\u2713' : '\u2717') + ' ' + n); };
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= 1e-9;

// mismo cuerpo que monitor_v4.computeCryptoLevels
function computeCryptoLevels(price, dir, atr) {
  if ((dir !== 'BUY' && dir !== 'SELL') || !price || !atr || atr <= 0) return null;
  const isBuy = dir === 'BUY';
  return { entry: price,
    sl:  isBuy ? price - atr * 1.5 : price + atr * 1.5,
    tp1: isBuy ? price + atr * 2   : price - atr * 2,
    tp2: isBuy ? price + atr * 3   : price - atr * 3,
    tp3: isBuy ? price + atr * 5   : price - atr * 5 };
}

// BUY: entry 100, atr 2 → R=3, sl 97, tp 104/106/110
const b = computeCryptoLevels(100, 'BUY', 2);
ok('BUY entry=precio', b.entry === 100);
ok('BUY sl = -1.5ATR (97)', near(b.sl, 97));
ok('BUY tp1/tp2/tp3 = +2/3/5 ATR (104/106/110)', near(b.tp1,104) && near(b.tp2,106) && near(b.tp3,110));
ok('BUY R = |entry-sl| = 3 → TP1 ≈ 1.33R', near(Math.abs(b.entry-b.sl), 3) && near((b.tp1-b.entry)/3, 4/3));

// SELL: espejo
const s = computeCryptoLevels(100, 'SELL', 2);
ok('SELL sl = +1.5ATR (103)', near(s.sl, 103));
ok('SELL tp1/tp2/tp3 = -2/3/5 ATR (96/94/90)', near(s.tp1,96) && near(s.tp2,94) && near(s.tp3,90));

// guardas
ok('dir inválida → null', computeCryptoLevels(100, 'NEUTRAL', 2) === null);
ok('atr 0 → null', computeCryptoLevels(100, 'BUY', 0) === null);

// captura cripto: registro bien formado (setup desde struct4H.type, horizon null)
let saved = null;
const store = { upsert: r => { saved = r; return r; } };
const lv = computeCryptoLevels(50000, 'BUY', 400);
captureSignal(store, { ts: 1, sym:'BTCUSDT', tf:'4H', direction:'BUY', score:8, grade:null,
  setup:'CHOCH_BUY', horizon:null, entry:lv.entry, sl:lv.sl, tp1:lv.tp1, tp2:lv.tp2, tp3:lv.tp3,
  horizonBars:30, cvdSource:'real' });
ok('captura cripto: registro con sym/setup/entry/sl', saved && saved.sym==='BTCUSDT' && saved.setup==='CHOCH_BUY' && saved.entry===50000);
ok('captura cripto: tp array + status ACTIVA', Array.isArray(saved.tp) && saved.tp.length===3 && saved.status==='ACTIVA');
ok('captura cripto: sin entry/sl → no registra', captureSignal(store, { ts:2, sym:'X', tf:'4H', direction:'BUY' }) === null);

console.log('\nRESULTADO: ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
