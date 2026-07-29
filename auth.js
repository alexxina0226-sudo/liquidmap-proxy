// ════════════════════════════════════════════════════════════════════
//  auth.js (s78) — núcleo PURO de seguridad (sin Express, testeable).
//  Sesión por cookie server-side. La contraseña vive en el SERVIDOR
//  (env LM_PASSWORD), nunca en el HTML. El token de sesión se deriva de
//  la contraseña (sha256) → estable, y si cambiás la clave, las sesiones
//  viejas se invalidan solas.
// ════════════════════════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

// token de sesión derivado de la contraseña (no reversible)
function makeToken(password, salt = 'lm_salt_v1') {
  return crypto.createHash('sha256').update(String(password) + salt).digest('hex').slice(0, 32);
}

// 'lm_sess=abc; foo=1' → { lm_sess:'abc', foo:'1' }
function parseCookies(cookieHeader) {
  const out = {};
  String(cookieHeader || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i < 0) return;
    const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; } }
  });
  return out;
}

// ¿la cookie trae una sesión válida?
function isAuthed(cookieHeader, token) {
  return !!token && parseCookies(cookieHeader).lm_sess === token;
}

// ¿la contraseña ingresada coincide con la del servidor?
function checkPassword(pass, envPass) {
  return !!envPass && String(pass) === String(envPass);
}

// cookie de sesión (HttpOnly: el JS del navegador NO la puede leer/robar)
function sessionCookie(token, maxAgeSec = 2592000) { // 30 días
  return `lm_sess=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax; Secure`;
}
function clearCookie() {
  return `lm_sess=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

module.exports = { makeToken, parseCookies, isAuthed, checkPassword, sessionCookie, clearCookie };
