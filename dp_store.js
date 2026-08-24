'use strict';
/**
 * dp_store.js — STORE del baseline de dark pool (driver intercambiable).
 *
 * El baseline es UN blob JSON { v, tickers:{ SYM:{samples:[{t,p}]} } } que se
 * lee-modifica-escribe entero (a diferencia del ledger, que es JSONL append).
 * Reusa el patrón del ledger: driver swappable, cache RAM, write-through async,
 * FAIL-OPEN. Producción = un archivo nuevo dentro del gist que ya existe.
 */

const dpb = require('./dp_baseline');

/* ---------- drivers (blob JSON entero) ---------- */

function memoryBlobDriver(initial){
  let blob = (initial == null) ? null : String(initial);
  return {
    init(){ return Promise.resolve(); },
    loadBlob(){ return blob; },
    saveBlob(s){ blob = String(s); },
    flush(){ return Promise.resolve(); }
  };
}

// gistBlobDriver — 1 archivo JSON dentro de un gist; load/save del archivo entero.
// Endurecido igual que el ledger: maneja f.truncated (>1MB) vía raw_url.
function gistBlobDriver(cfg){
  const token = cfg.token, gistId = cfg.gistId, filename = cfg.filename;
  const _fetch = cfg.fetch, onError = cfg.onError;
  const url = 'https://api.github.com/gists/' + gistId;
  const headers = {
    'Authorization': 'token ' + token,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'liquidmap-dp'
  };
  let cache = null;                 // string | null
  let chain = Promise.resolve();    // cola de escritura serializada
  let dirty = false;
  function _err(e){ if(onError){ try{ onError(e); }catch(_){} } }

  async function init(){
    try{
      const r = await _fetch(url, { headers });
      if(!r.ok) throw new Error('gist GET ' + r.status);
      const j = await r.json();
      const f = j.files && j.files[filename];
      if(!f){ cache = null; return; }
      if(f.truncated && f.raw_url){
        const rr = await _fetch(f.raw_url, { headers });
        cache = rr.ok ? await rr.text() : (f.content != null ? f.content : null);
      } else {
        cache = (f.content != null) ? f.content : null;
      }
    }catch(e){ _err(e); cache = null; }
  }
  function loadBlob(){ return cache; }
  function saveBlob(s){
    cache = String(s);
    dirty = true;
    chain = chain.then(async () => {
      if(!dirty) return; dirty = false;
      const body = JSON.stringify({ files: { [filename]: { content: cache } } });
      try{
        const r = await _fetch(url, { method:'PATCH', headers, body });
        if(!r.ok) throw new Error('gist PATCH ' + r.status);
      }catch(e){ _err(e); }
    });
  }
  function flush(){ return chain; }
  return { init, loadBlob, saveBlob, flush };
}

/* ---------- store ---------- */

function createDpStore(driver){
  let state = { v:1, tickers:{} };
  let loaded = false;

  function _ensure(){
    if(loaded) return;
    const raw = driver.loadBlob();
    if(raw){
      try{
        const o = JSON.parse(raw);
        if(o && o.tickers && typeof o.tickers === 'object'){
          state = { v: o.v || 1, tickers: o.tickers };
        }
      }catch(_){ /* corrupto → arranca limpio, fail-open */ }
    }
    loaded = true;
  }
  async function init(){
    if(driver.init) await driver.init();
    loaded = false; _ensure();
  }
  let _dirty = false;
  // commit() escribe al gist UNA vez si hubo muestras nuevas (batch). Lo llama un
  // job periódico → evita un PATCH por muestra (la fuga de revisiones del gist).
  function commit(){ if(_dirty){ driver.saveBlob(JSON.stringify(state)); _dirty = false; return true; } return false; }

  // sample(sym,ts,pct) → {accepted,reason}. Persiste SOLO si accepted (no gasta escrituras en too-soon).
  function sample(sym, ts, pct, opts){
    if(!sym || typeof sym !== 'string') return { accepted:false, reason:'no-sym' };
    _ensure();
    const entry = state.tickers[sym] || { samples:[] };
    const r = dpb.addSample(entry, ts, pct, opts);
    if(r.accepted){ state.tickers[sym] = r.entry; _dirty = true; }  // en RAM ya; el commit periódico lo escribe en tanda
    return { accepted:r.accepted, reason:r.reason };
  }
  // bands(sym) → banda resuelta con procedencia (aprendido→seed→def)
  function bands(sym, seed, defBands, opts){
    _ensure();
    return dpb.resolveBands(state.tickers[sym], seed, defBands, opts);
  }
  // allBands(seeds,defBands) → { SYM: banda } para toda la watchlist (unión de vistos + sembrados)
  function allBands(seeds, defBands, opts){
    _ensure();
    const out = {};
    const syms = new Set([...Object.keys(state.tickers), ...Object.keys(seeds || {})]);
    for(const sym of syms){
      out[sym] = dpb.resolveBands(state.tickers[sym], (seeds || {})[sym], defBands, opts);
    }
    return out;
  }
  function flush(){ commit(); return driver.flush ? driver.flush() : Promise.resolve(); }
  function raw(){ _ensure(); return state; }

  return { init, sample, bands, allBands, commit, flush, raw };
}

module.exports = { createDpStore, memoryBlobDriver, gistBlobDriver };
