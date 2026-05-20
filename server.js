const express = require('express');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const SOURCES = {
  'BTCUSDT':  { cg: 'bitcoin',       kk: 'XXBTZUSD' },
  'ETHUSDT':  { cg: 'ethereum',      kk: 'XETHZUSD' },
  'SOLUSDT':  { cg: 'solana',        kk: 'SOLUSD'   },
  'BNBUSDT':  { cg: 'binancecoin',   kk: null        },
  'XRPUSDT':  { cg: 'ripple',        kk: 'XXRPZUSD' },
  'ADAUSDT':  { cg: 'cardano',       kk: 'ADAUSD'   },
  'AVAXUSDT': { cg: 'avalanche-2',   kk: 'AVAXUSD'  },
  'DOGEUSDT': { cg: 'dogecoin',      kk: 'XDGUSD'   },
  'LTCUSDT':  { cg: 'litecoin',      kk: 'XLTCZUSD' },
  'LINKUSDT': { cg: 'chainlink',     kk: 'LINKUSD'  },
  'DOTUSDT':  { cg: 'polkadot',      kk: 'DOTUSD'   },
  'MATICUSDT':{ cg: 'matic-network', kk: 'MATICUSD' },
  'ARBUSDT':  { cg: 'arbitrum',      kk: null        },
  'OPUSDT':   { cg: 'optimism',      kk: null        },
  'UNIUSDT':  { cg: 'uniswap',       kk: 'UNIUSD'   },
};

function get(url, timeout=8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
        'Accept':'application/json',
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function toBinanceFormat(symbol, price, open, high, low, vol, volQuote, count) {
  const p = parseFloat(price), o = parseFloat(open) || p;
  const chgPct = ((p - o) / o * 100);
  return {
    symbol, lastPrice: p.toString(), openPrice: o.toFixed(8),
    highPrice: (parseFloat(high) || p*1.02).toString(),
    lowPrice:  (parseFloat(low)  || p*0.98).toString(),
    priceChange: (p-o).toFixed(8),
    priceChangePercent: chgPct.toFixed(2),
    quoteVolume: (volQuote || parseFloat(vol||0) * p).toString(),
    volume: (parseFloat(vol)||0).toFixed(2),
    count: (count||50000).toString(),
    openTime: Date.now()-86400000, closeTime: Date.now(),
  };
}

async function tryCoingecko(cgId) {
  try {
    const r = await get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${cgId}&sparkline=false`, 7000);
    if (r.status === 200) {
      const data = JSON.parse(r.data);
      return data && data[0] ? data[0] : null;
    }
  } catch(e) {}
  return null;
}

async function tryKraken(symbol) {
  const src = SOURCES[symbol];
  if (!src || !src.kk) return null;
  try {
    const r = await get(`https://api.kraken.com/0/public/Ticker?pair=${src.kk}`, 7000);
    if (r.status === 200) {
      const d = JSON.parse(r.data);
      if (d.result) {
        const key = Object.keys(d.result)[0];
        const t = d.result[key];
        return { lastPrice: t.c[0], openPrice: t.o, highPrice: t.h[1], lowPrice: t.l[1], volume: t.v[1], quoteVolume: null, count: parseInt(t.t[1]) || 50000 };
      }
    }
  } catch(e) {}
  return null;
}

async function tryCoinCap(symbol) {
  const idMap = {
    'BTCUSDT':'bitcoin','ETHUSDT':'ethereum','SOLUSDT':'solana',
    'BNBUSDT':'binance-coin','XRPUSDT':'xrp','ADAUSDT':'cardano',
    'AVAXUSDT':'avalanche','DOGEUSDT':'dogecoin','LTCUSDT':'litecoin',
    'LINKUSDT':'chainlink','DOTUSDT':'polkadot','MATICUSDT':'polygon',
    'ARBUSDT':'arbitrum','OPUSDT':'optimism','UNIUSDT':'uniswap',
  };
  const id = idMap[symbol];
  if (!id) return null;
  try {
    const r = await get(`https://api.coincap.io/v2/assets/${id}`, 7000);
    if (r.status === 200) {
      const d = JSON.parse(r.data);
      if (d.data) {
        const a = d.data;
        const p = parseFloat(a.priceUsd);
        const chg = parseFloat(a.changePercent24Hr)/100;
        const open = p / (1 + chg);
        return { lastPrice: p.toString(), openPrice: open.toString(), highPrice: (p*1.02).toString(), lowPrice: (p*0.98).toString(), volume: (parseFloat(a.volumeUsd24Hr||0)/p).toString(), quoteVolume: a.volumeUsd24Hr, count: 50000 };
      }
    }
  } catch(e) {}
  return null;
}

async function tryBinance(symbol, path) {
  const bases = ['api.binance.com','api1.binance.com','api2.binance.com','api3.binance.com'];
  for (const base of bases) {
    try {
      const r = await get(`https://${base}${path}?symbol=${symbol}`, 5000);
      if (r.status === 200 && r.data.includes('lastPrice')) return JSON.parse(r.data);
    } catch(e) {}
  }
  return null;
}

app.get('/', (req, res) => res.json({ status: 'LiquidMap Proxy OK', time: new Date().toISOString() }));

app.get('/.netlify/functions/binance', async (req, res) => {
  const { symbol = 'BTCUSDT', path = '/api/v3/ticker/24hr', futures, interval = '15m', limit = '120' } = req.query;
  const sym = symbol.toUpperCase();

  try {
    if (path.includes('klines')) {
      for (const base of ['api.binance.com','api1.binance.com','api2.binance.com','api3.binance.com']) {
        try {
          const r = await get(`https://${base}/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`, 6000);
          if (r.status === 200 && r.data.startsWith('[')) return res.json(JSON.parse(r.data));
        } catch(e) {}
      }
      return res.json([]);
    }

    if (futures === '1') {
      for (const base of ['fapi.binance.com','fapi1.binance.com']) {
        try {
          const endpoint = path.includes('premiumIndex') ? 'premiumIndex' : 'openInterest';
          const r = await get(`https://${base}/fapi/v1/${endpoint}?symbol=${sym}`, 5000);
          if (r.status === 200) return res.json(JSON.parse(r.data));
        } catch(e) {}
      }
      const est = path.includes('premiumIndex')
        ? { lastFundingRate:'0.0001', nextFundingTime: Date.now()+28800000, markPrice:'0' }
        : { openInterest:'50000', symbol: sym };
      return res.json(est);
    }

    const src = SOURCES[sym];
    if (src && src.cg) {
      const cg = await tryCoingecko(src.cg);
      if (cg && cg.current_price) {
        const open = cg.current_price / (1 + (cg.price_change_percentage_24h||0)/100);
        return res.json(toBinanceFormat(sym, cg.current_price, open, cg.high_24h, cg.low_24h, (cg.total_volume/cg.current_price), cg.total_volume, 50000));
      }
    }
    const kr = await tryKraken(sym);
    if (kr) {
      const volQ = kr.quoteVolume || (parseFloat(kr.volume) * parseFloat(kr.lastPrice));
      return res.json(toBinanceFormat(sym, kr.lastPrice, kr.openPrice, kr.highPrice, kr.lowPrice, kr.volume, volQ, kr.count));
    }
    const cc = await tryCoinCap(sym);
    if (cc) return res.json(toBinanceFormat(sym, cc.lastPrice, cc.openPrice, cc.highPrice, cc.lowPrice, cc.volume, cc.quoteVolume, cc.count));

    const bn = await tryBinance(sym, '/api/v3/ticker/24hr');
    if (bn) return res.json(bn);

    res.status(503).json({ code: -1, msg: 'All sources failed' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`LiquidMap Proxy running on port ${PORT}`));
