// ledger_weekly.js — ENVÍO del resumen semanal del ledger por Telegram. FASE ledger, Etapa 3 (mitad Telegram).
// ---------------------------------------------------------------------------
// PURO salvo dependencias INYECTADAS (loadRecords, send, now). Usa el ledger_report
// ya sellado (weeklySummary/formatWeekly) para el texto. NO toca el mapa HTML ni la
// emisión de señales del monitor. Pensado para colgarse de un setInterval del server/
// monitor (job) O de un comando on-demand tipo /resumen. FAIL-OPEN: nunca throw.
'use strict';
const { weekKeyUTC, weeklySummary, formatWeekly } = require('./ledger_report.js');

const WEEK_MS = 7 * 24 * 3600 * 1000;

// Lunes (UTC) de la semana ANTERIOR a la que contiene ms → 'YYYY-MM-DD'.
function prevWeekKeyUTC(ms){
  return weekKeyUTC(ms - WEEK_MS);
}

// buildWeeklyReport(records, opts) → { week, text, hasData }
//   opts.which : 'last' (semana YA CERRADA, default — lo que se manda el lunes)
//              | 'current' (semana EN CURSO — para el /resumen on-demand)
//   opts.now   : ms (default Date.now())
// El texto sale del ledger_report (honesto con nulos). hasData=false cuando la semana
// objetivo no tiene señales RESUELTAS (el weeklySummary ya excluye ACTIVA).
function buildWeeklyReport(records, opts){
  opts = opts || {};
  const now = (opts.now != null) ? opts.now : Date.now();
  const which = opts.which || 'last';
  const targetWk = (which === 'current') ? weekKeyUTC(now) : prevWeekKeyUTC(now);
  const summary = weeklySummary(records || []);
  const weekObj = summary[targetWk] || null;
  const hasData = !!(weekObj && weekObj.overall);
  const text = hasData
    ? formatWeekly(weekObj)
    : ('📊 Resumen semanal · ' + targetWk + ': sin señales resueltas.');
  return { week: targetWk, text, hasData };
}

// maybeSendWeekly(deps) async → { sent, week, reason }
//   deps.loadRecords() → records | Promise<records>   (ej. () => store.load())
//   deps.send(text)    → Promise                       (ej. sendTelegram)
//   deps.now?          : ms
//   deps.which?        : 'last' | 'current'
//   deps.state?        : { lastSentWeek }  — se MUTA para dedup (no reenvía la misma semana)
//   deps.force?        : bool — manda igual (on-demand): saltea dedup Y "sin-datos",
//                        y NO toca state.lastSentWeek (para no pisar el envío programado).
// FAIL-OPEN: cualquier error → { sent:false, reason:'error:...' }, jamás throw.
async function maybeSendWeekly(deps){
  deps = deps || {};
  const state = deps.state || {};
  const force = !!deps.force;
  try {
    const records = await deps.loadRecords();
    const rep = buildWeeklyReport(records, { now: deps.now, which: deps.which });
    if(!force && state.lastSentWeek === rep.week) return { sent:false, week:rep.week, reason:'ya-enviada' };
    if(!force && !rep.hasData)                    return { sent:false, week:rep.week, reason:'sin-datos' };
    await deps.send(rep.text);
    if(!force) state.lastSentWeek = rep.week;      // dedup solo para el envío automático
    return { sent:true, week:rep.week, reason:'ok' };
  } catch(e){
    return { sent:false, reason:'error:' + ((e && e.message) || e) };
  }
}

// weeklyTrigger(now) → { fire, which } — ¿toca mandar el resumen y de qué semana?
// Regla: domingo tarde ET (>=18:00), una vez (el dedup de maybeSendWeekly evita repetir).
// 'which' se deriva del día UTC para ser robusto al cambio de horario (DST): si en UTC ya
// es lunes → 'last' (la semana cerrada ayer); si no → 'current' (la que termina hoy domingo).
function weeklyTrigger(now){
  now = now || new Date();
  let et;
  try { et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })); }
  catch(e){ et = now; }
  const fire  = (et.getDay() === 0 && et.getHours() >= 18);
  const which = (now.getUTCDay() === 1) ? 'last' : 'current';
  return { fire, which };
}

// parseResumenCommand(update, authChatId) → bool: ¿este update es un /resumen del DUEÑO?
// PURO (no red). Seguridad: solo responde al chat autorizado (authChatId), ignora a cualquier otro.
function parseResumenCommand(update, authChatId){
  try {
    const msg = update && update.message;
    if (!msg || typeof msg.text !== 'string') return false;
    if (String(msg.chat && msg.chat.id) !== String(authChatId)) return false;   // solo el dueño
    return /^\/resumen(@\w+)?\s*$/i.test(msg.text.trim());
  } catch (e) { return false; }
}

// processRadarUpdates(updates, offset, authChatId, onResumen) → nuevoOffset. PURO.
// Recorre los updates de getUpdates, avanza el offset (update_id+1) para ack, y llama
// onResumen(update) por cada /resumen del dueño. El monitor le pasa el fetch y el envío.
function processRadarUpdates(updates, offset, authChatId, onResumen){
  let off = offset;
  if (!Array.isArray(updates)) return off;
  for (const upd of updates){
    if (upd && typeof upd.update_id === 'number') off = upd.update_id + 1;
    if (parseResumenCommand(upd, authChatId) && typeof onResumen === 'function'){
      try { onResumen(upd); } catch (e) {}
    }
  }
  return off;
}

module.exports = { prevWeekKeyUTC, buildWeeklyReport, maybeSendWeekly, weeklyTrigger, parseResumenCommand, processRadarUpdates };
