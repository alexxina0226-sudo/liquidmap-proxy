// ledger_store_github.js — DRIVER de persistencia GitHub Gist para el LEDGER.
// ---------------------------------------------------------------------------
// Backend $0 y persistente para Render free tier: guarda el JSONL del ledger en
// un GIST SECRETO dedicado (NO el repo de código — evita disparar redeploys).
// Implementa el mismo contrato SÍNCRONO que los otros drivers ({append, loadAll,
// replaceAll}) sobre un CACHE en memoria, con WRITE-THROUGH async al gist:
//   • loadAll() → lee del cache (instantáneo, cero red)
//   • append/replaceAll() → mutan el cache (sync) + encolan un PATCH al gist
//   • las escrituras se SERIALIZAN in-process (promise chain) → sin conflictos
//   • FAIL-OPEN: si el gist falla, el cache sigue vivo y se loguea (onError)
// Extra async: init() ceba el cache al bootear; flush() espera la cola (durabilidad).
'use strict';

function githubGistDriver(cfg){
  cfg = cfg || {};
  const _fetch   = cfg.fetch || require('node-fetch');
  const token    = cfg.token;
  const gistId   = cfg.gistId;
  const filename = cfg.filename || 'ledger_bolsa.jsonl';
  const H = () => ({ Authorization:'Bearer '+token, 'User-Agent':'liquidmap-ledger',
                     Accept:'application/vnd.github+json' });

  let cache = [];
  let chain = Promise.resolve();   // serializa las escrituras (mismo proceso)
  let dirty = false;

  function parse(content){
    const out = [];
    for(const line of String(content||'').split('\n')){
      const s = line.trim(); if(!s) continue;
      try { const o = JSON.parse(s); if(o && typeof o === 'object' && !Array.isArray(o)) out.push(o); } catch(_){ /* corrupta o placeholder: saltear */ }
    }
    return out;
  }
  function serialize(){ return cache.map(r => JSON.stringify(r)).join('\n') + (cache.length ? '\n' : ''); }

  // Ceba el cache desde el gist. Llamar UNA vez al bootear el monitor.
  async function init(){
    const r = await _fetch('https://api.github.com/gists/' + gistId, { headers: H() });
    if(!r.ok) throw new Error('gist init ' + r.status);
    const j = await r.json();
    const f = j.files && j.files[filename];
    let content = f ? f.content : '';
    if(f && f.truncated && f.raw_url){                 // la API trunca el content a 1MB → leer el archivo COMPLETO
      const rr = await _fetch(f.raw_url, { headers:{ 'User-Agent':'liquidmap-ledger' } });
      if(rr.ok) content = await rr.text();
    }
    cache = content ? parse(content) : [];
    return cache.length;
  }

  // Encola un write-through del estado actual del cache (coalescido, serializado).
  function queuePush(){
    dirty = true;
    chain = chain.then(async () => {
      if(!dirty) return; dirty = false;                       // coalesce mutaciones rápidas
      const body = { files: { [filename]: { content: serialize() || '\n' } } };
      const r = await _fetch('https://api.github.com/gists/' + gistId, {
        method:'PATCH',
        headers: Object.assign(H(), { 'Content-Type':'application/json' }),
        body: JSON.stringify(body)
      });
      if(!r.ok) throw new Error('gist write ' + r.status);
    }).catch(e => { if(typeof cfg.onError === 'function') cfg.onError(e); /* fail-open */ });
    return chain;
  }

  return {
    append(obj){ cache.push(obj); queuePush(); },
    loadAll(){ return cache.slice(); },
    replaceAll(next){ cache = Array.isArray(next) ? next.slice() : []; queuePush(); },
    init,
    flush(){ return chain; }        // await para asegurar que el PATCH aterrizó (durabilidad)
  };
}

module.exports = { githubGistDriver };
