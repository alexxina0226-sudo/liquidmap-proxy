// ledger_store.js — PERSISTENCIA del LEDGER (etapa 2a). Driver INTERCAMBIABLE.
// ---------------------------------------------------------------------------
// El store es la FUENTE DE VERDAD del ledger. La lógica vive acá; el BACKEND
// (memoria / archivo JSONL / Postgres / Supabase / GitHub) es un DRIVER aparte.
// Así la decisión de dónde persistir NO toca ni el resolver ni la captura:
// solo se cambia el driver. Hoy shipeamos memoria (tests) + JSONL-archivo
// (sirve para Render Disk, local y /tmp). Un backend async futuro se envuelve.
//
// Contrato de DRIVER (síncrono): { append(obj), loadAll()->[], replaceAll(arr) }
'use strict';

// ── Driver en MEMORIA (tests / fallback efímero) ──────────────────────────
function memoryDriver(initial){
  let arr = Array.isArray(initial) ? initial.slice() : [];
  return {
    append(obj){ arr.push(obj); },
    loadAll(){ return arr.slice(); },
    replaceAll(next){ arr = Array.isArray(next) ? next.slice() : []; }
  };
}

// ── Driver JSONL sobre archivo (Render Disk / local) ──────────────────────
// Una línea JSON por registro. append O(1). loadAll tolera líneas vacías o
// corruptas (las saltea, no rompe). replaceAll escribe ATÓMICO (tmp + rename)
// para no corromper el archivo si hay un corte a mitad de escritura.
function fileJsonlDriver(filePath, _fs){
  const fs = _fs || require('fs');
  const path = require('path');
  function ensureDir(){ try { fs.mkdirSync(path.dirname(filePath), { recursive:true }); } catch(_){} }
  return {
    append(obj){
      ensureDir();
      fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
    },
    loadAll(){
      let raw;
      try { raw = fs.readFileSync(filePath, 'utf8'); }
      catch(e){ return []; }                       // no existe todavía → vacío honesto
      const out = [];
      for(const line of raw.split('\n')){
        const s = line.trim();
        if(!s) continue;
        try { const o = JSON.parse(s); if(o && typeof o === 'object' && !Array.isArray(o)) out.push(o); } catch(_){ /* corrupta o placeholder: saltear */ }
      }
      return out;
    },
    replaceAll(next){
      ensureDir();
      const tmp = filePath + '.tmp';
      const body = (next || []).map(r => JSON.stringify(r)).join('\n') + ((next && next.length) ? '\n' : '');
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, filePath);                // rename atómico dentro del mismo FS
    }
  };
}

// ── Store (lógica pura sobre cualquier driver) ────────────────────────────
// createLedgerStore(driver) → { append, load, get, update, upsert, count }
function createLedgerStore(driver){
  if(!driver) throw new Error('ledger_store: falta driver');
  return {
    append(rec){ driver.append(rec); return rec; },
    load(){ return driver.loadAll(); },
    get(id){ return driver.loadAll().find(r => r && r.id === id) || null; },
    // update(id, patch): aplica patch al registro con ese id y reescribe todo.
    // Devuelve el registro actualizado, o null si el id no existe.
    update(id, patch){
      const all = driver.loadAll();
      let hit = null;
      const next = all.map(r => {
        if(r && r.id === id){ hit = Object.assign({}, r, patch); return hit; }
        return r;
      });
      if(hit) driver.replaceAll(next);
      return hit;
    },
    // upsert(rec): si el id existe lo reemplaza, si no lo agrega. IDEMPOTENTE por id
    // → re-ejecutar la captura de una misma señal no la duplica.
    upsert(rec){
      const all = driver.loadAll();
      const idx = all.findIndex(r => r && r.id === rec.id);
      if(idx < 0){ driver.append(rec); return rec; }
      all[idx] = rec; driver.replaceAll(all); return rec;
    },
    count(){ return driver.loadAll().length; }
  };
}

module.exports = { memoryDriver, fileJsonlDriver, createLedgerStore };
