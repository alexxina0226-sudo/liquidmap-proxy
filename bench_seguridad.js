// ════════════════════════════════════════════════════════════════════
//  bench_seguridad.js (s78) — banco del blindaje.
//   A) auth.js (núcleo puro): token, cookies, sesión, password, flags.
//   B) server.js (estructural): guards, /login, /logout, protección por
//      prefijo, páginas gateadas, /health ABIERTA.
//   C) HTML (estructural): contraseña fuera del código, lock oculto,
//      auto-desbloqueo (el server ya autorizó).
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const A = require('./auth.js');
const srv = fs.readFileSync('./server.js', 'utf8');
const html = fs.readFileSync('./LiquidityMap_BOLSA_v5.html', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

console.log('── A) auth.js (núcleo puro) ──');
const tok = A.makeToken('trader2026');
ok('A1 makeToken determinista (misma clave → mismo token)', tok === A.makeToken('trader2026'), tok);
ok('A2 clave distinta → token distinto', A.makeToken('otra') !== tok);
ok('A3 token = 32 hex', /^[0-9a-f]{32}$/.test(tok), tok);
ok('A4 parseCookies básico', JSON.stringify(A.parseCookies('lm_sess=abc; foo=1')) === JSON.stringify({ lm_sess: 'abc', foo: '1' }));
ok('A5 parseCookies vacío → {}', JSON.stringify(A.parseCookies('')) === '{}' && JSON.stringify(A.parseCookies(undefined)) === '{}');
ok('A6 isAuthed: cookie con token válido → true', A.isAuthed('lm_sess=' + tok, tok) === true);
ok('A7 isAuthed: token equivocado → false', A.isAuthed('lm_sess=nope', tok) === false);
ok('A8 isAuthed: sin cookie → false', A.isAuthed('', tok) === false && A.isAuthed(undefined, tok) === false);
ok('A9 isAuthed: token vacío nunca autoriza (aunque cookie venga vacía)', A.isAuthed('lm_sess=', '') === false);
ok('A10 checkPassword correcto/incorrecto', A.checkPassword('x', 'x') === true && A.checkPassword('x', 'y') === false);
ok('A11 checkPassword con env vacío → false (no autoriza)', A.checkPassword('', '') === false);
ok('A12 sessionCookie es HttpOnly + SameSite + Secure + Path', /HttpOnly/.test(A.sessionCookie(tok)) && /SameSite=Lax/.test(A.sessionCookie(tok)) && /Secure/.test(A.sessionCookie(tok)) && /Path=\//.test(A.sessionCookie(tok)));
ok('A13 clearCookie expira (Max-Age=0)', /Max-Age=0/.test(A.clearCookie()));

console.log('\n── B) server.js (estructural) ──');
ok('B1 contraseña desde env LM_PASSWORD (no hardcodeada)', /process\.env\.LM_PASSWORD/.test(srv), 'env');
ok('B2 guards requirePage / requireApi', /function requirePage/.test(srv) && /function requireApi/.test(srv));
ok('B3 /login GET + POST y /logout', /app\.get\('\/login'/.test(srv) && /app\.post\('\/login'/.test(srv) && /app\.get\('\/logout'/.test(srv));
ok('B4 protección de rutas de datos por prefijo (/alpaca, /proxy…)', /API_PROTECT = \['\/proxy', '\/alpaca'/.test(srv) && /API_PROTECT\.some/.test(srv));
ok('B5 /bolsa y /crypto gateados con requirePage', /app\.get\('\/bolsa', requirePage/.test(srv) && /app\.get\('\/crypto', requirePage/.test(srv));
ok('B6 /health queda ABIERTA (health check de Render no se rompe)',
   /app\.get\('\/health'/.test(srv) && !/'\/health'/.test('[' + 'proxy,alpaca,diag,liquidations,deribit' + ']') && !srv.includes("'/health', require"));
ok('B7 POST /login setea cookie de sesión sólo si la clave coincide',
   /AUTH\.checkPassword\(pass, LM_PASSWORD\)[\s\S]*?setHeader\('Set-Cookie', AUTH\.sessionCookie/.test(srv), 'login');
ok('B8 login incorrecto → 401', /status\(401\)\.json\(\{ ok: false, error: 'clave incorrecta'/.test(srv));
ok('B9 la contraseña NO viaja al cliente (LOGIN_HTML no contiene LM_PASSWORD ni el valor)',
   !/LOGIN_HTML[\s\S]*?trader2026/.test(srv), 'leak');

console.log('\n── C) HTML (estructural) ──');
ok('C1 la contraseña NO está en el HTML', !/trader2026/.test(html) && !/DEFAULT_PASS/.test(html));
ok('C2 lock screen oculto de arranque', /<div id="lock-screen" class="hidden">/.test(html));
ok('C3 checkPass ahora auto-desbloquea (sin comparar clave)', /function checkPass\(\)\{ document\.getElementById\('lock-screen'\)\.classList\.add\('hidden'\); initAfterLock\(\); \}/.test(html));
ok('C4 auto-desbloqueo al cargar (el server ya autorizó)', /s78: el server ya autorizó[\s\S]*?try\{ checkPass\(\);/.test(html));
ok('C5 "cambiar contraseña" ahora es cerrar sesión (/logout)', /location\.href = '\/logout'/.test(html));

console.log(`\n${fail === 0 ? '✅' : '❌'} bench_seguridad: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
