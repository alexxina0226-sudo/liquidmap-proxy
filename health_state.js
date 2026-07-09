// ══════════════════════════════════════════════════════════════════
// health_state.js — LATIDO DE MONITORES (singleton en proceso)
// ──────────────────────────────────────────────────────────────────
// Los monitores bolsa/crypto corren DENTRO del mismo proceso que server.js
// (require en server.js). Este módulo es un singleton compartido: cada monitor
// "late" en cada loop y registra sus señales; server.js expone snapshot() por /status.
// SIN DB, SIN archivos — memoria de proceso. Se reinicia con cada deploy (correcto:
// un deploy nuevo = estado nuevo). El dato es REAL o es "—". Cero sintético.
// ══════════════════════════════════════════════════════════════════
'use strict';

// ── Umbrales de frescura (segundos) — cuánto puede pasar sin latir antes de alarmar
const THRESHOLDS = {
  bolsa:  { stale: 180,  dead: 600  },   // late cada ~loop; 3min tibio, 10min muerto
  crypto: { stale: 180,  dead: 600  },   // idem, pero crypto es 24/7 (nunca en pausa)
};

// ── Estado por componente. lastBeat = último loop vivo. lastSignal = última señal disparada.
const state = {
  bolsa:  { lastBeat: null, lastSignal: null, lastSignalInfo: null, signalCount: 0, lastError: null, startedAt: Date.now() },
  crypto: { lastBeat: null, lastSignal: null, lastSignalInfo: null, signalCount: 0, lastError: null, startedAt: Date.now() },
};

// ── ¿Estamos en sesión regular de NY? (el monitor bolsa solo late en RTH; de noche
//    está en pausa LEGÍTIMA, no muerto — el tablero no debe marcarlo rojo por eso.)
function isBolsaSessionOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value;
  const wd  = get('weekday');                     // Mon..Sun
  if (wd === 'Sat' || wd === 'Sun') return false; // fin de semana: cerrado
  const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return mins >= 570 && mins < 960;               // 09:30–16:00 ET
}

// ── API que llaman los monitores ──────────────────────────────────
function beat(component) {
  if (!state[component]) return;
  state[component].lastBeat = Date.now();
}

function signal(component, info) {
  if (!state[component]) return;
  const s = state[component];
  s.lastSignal = Date.now();
  s.lastSignalInfo = (info == null ? null : String(info)).slice(0, 120);
  s.signalCount += 1;
  s.lastBeat = Date.now();          // una señal implica que está vivo
}

function error(component, msg) {
  if (!state[component]) return;
  state[component].lastError = { msg: String(msg).slice(0, 200), at: Date.now() };
}

// ── Clasificación honesta de estado ───────────────────────────────
// ok = latió hace poco · stale = tibio · dead = sin latir hace mucho
// paused = bolsa fuera de sesión (no es error) · unknown = nunca latió aún
function classify(component, now = Date.now(), sessionOpen = null) {
  const s = state[component];
  const th = THRESHOLDS[component] || { stale: 180, dead: 600 };
  if (!s || s.lastBeat == null) {
    // Nunca latió. Si es bolsa y el mercado está cerrado, es "pausa esperada", no "desconocido".
    if (component === 'bolsa') {
      const open = sessionOpen == null ? isBolsaSessionOpen(new Date(now)) : sessionOpen;
      if (!open) return 'paused';
    }
    return 'unknown';
  }
  const ageSec = (now - s.lastBeat) / 1000;
  if (component === 'bolsa') {
    const open = sessionOpen == null ? isBolsaSessionOpen(new Date(now)) : sessionOpen;
    if (!open && ageSec > th.stale) return 'paused';  // fuera de sesión y sin latir → pausa legítima
  }
  if (ageSec > th.dead)  return 'dead';
  if (ageSec > th.stale) return 'stale';
  return 'ok';
}

// ── Snapshot completo para /status y para el tablero ──────────────
function snapshot(now = Date.now()) {
  const bolsaOpen  = isBolsaSessionOpen(new Date(now));
  const out = { serverTime: new Date(now).toISOString(), bolsaSessionOpen: bolsaOpen, components: {} };
  for (const comp of Object.keys(state)) {
    const s = state[comp];
    const sessionOpen = comp === 'bolsa' ? bolsaOpen : null;
    out.components[comp] = {
      status:         classify(comp, now, sessionOpen),
      lastBeat:       s.lastBeat ? new Date(s.lastBeat).toISOString() : null,
      beatAgeSec:     s.lastBeat ? Math.round((now - s.lastBeat) / 1000) : null,
      lastSignal:     s.lastSignal ? new Date(s.lastSignal).toISOString() : null,
      signalAgeSec:   s.lastSignal ? Math.round((now - s.lastSignal) / 1000) : null,
      lastSignalInfo: s.lastSignalInfo,
      signalCount:    s.signalCount,
      lastError:      s.lastError ? { msg: s.lastError.msg, at: new Date(s.lastError.at).toISOString() } : null,
      uptimeSec:      Math.round((now - s.startedAt) / 1000),
    };
  }
  return out;
}

module.exports = { beat, signal, error, snapshot, classify, isBolsaSessionOpen, _state: state, THRESHOLDS };

// ══════════════════════════════════════════════════════════════════
// BANCO DE LÓGICA — corré `node health_state.js` para validar
// ══════════════════════════════════════════════════════════════════
if (require.main === module) {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } };

  const NOW = Date.parse('2026-07-08T14:00:00-04:00'); // martes 14:00 ET → sesión ABIERTA

  // 1) Sin latido, bolsa en sesión abierta → unknown
  ok('bolsa sin latir en sesión → unknown', classify('bolsa', NOW, true) === 'unknown');

  // 2) Sin latido, bolsa fuera de sesión → paused (no rojo)
  ok('bolsa sin latir fuera de sesión → paused', classify('bolsa', NOW, false) === 'paused');

  // 3) Latido reciente → ok
  state.bolsa.lastBeat = NOW - 10 * 1000;
  ok('bolsa latió hace 10s → ok', classify('bolsa', NOW, true) === 'ok');

  // 4) Latido tibio (4min) en sesión → stale
  state.bolsa.lastBeat = NOW - 240 * 1000;
  ok('bolsa latió hace 4min en sesión → stale', classify('bolsa', NOW, true) === 'stale');

  // 5) Latido viejo (11min) en sesión → dead
  state.bolsa.lastBeat = NOW - 660 * 1000;
  ok('bolsa latió hace 11min en sesión → dead', classify('bolsa', NOW, true) === 'dead');

  // 6) Latido viejo pero fuera de sesión → paused (no dead)
  ok('bolsa viejo fuera de sesión → paused', classify('bolsa', NOW, false) === 'paused');

  // 7) Crypto es 24/7: latido viejo SIEMPRE es dead, nunca paused
  state.crypto.lastBeat = NOW - 660 * 1000;
  ok('crypto latió hace 11min → dead (sin pausa)', classify('crypto', NOW) === 'dead');

  // 8) signal() actualiza señal, cuenta y latido
  const before = state.crypto.signalCount;
  signal('crypto', 'BTCUSDT BUY 7/10');
  ok('signal() incrementa contador', state.crypto.signalCount === before + 1);
  ok('signal() guarda info', state.crypto.lastSignalInfo === 'BTCUSDT BUY 7/10');
  ok('signal() refresca latido → ok', classify('crypto', Date.now()) === 'ok');

  // 9) beat() en componente inexistente no rompe
  beat('inexistente'); signal('inexistente', 'x'); error('inexistente', 'x');
  ok('componente inexistente no rompe', true);

  // 10) snapshot tiene forma esperada
  const snap = snapshot(NOW);
  ok('snapshot tiene serverTime', typeof snap.serverTime === 'string');
  ok('snapshot tiene bolsa y crypto', !!snap.components.bolsa && !!snap.components.crypto);
  ok('snapshot expone beatAgeSec numérico', typeof snap.components.crypto.beatAgeSec === 'number');

  // 11) isBolsaSessionOpen: sábado siempre cerrado
  ok('sábado → cerrado', isBolsaSessionOpen(new Date('2026-07-11T14:00:00-04:00')) === false);
  ok('martes 14:00 ET → abierto', isBolsaSessionOpen(new Date('2026-07-08T14:00:00-04:00')) === true);
  ok('martes 08:00 ET (pre) → cerrado', isBolsaSessionOpen(new Date('2026-07-08T08:00:00-04:00')) === false);

  console.log(`\n── ${pass} OK · ${fail} FAIL ──`);
  process.exit(fail ? 1 : 0);
}
