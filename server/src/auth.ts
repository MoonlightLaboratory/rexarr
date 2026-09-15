/**
 * Settings → General → Security.
 *
 *   Authentication  none | basic (browser popup) | forms (login page, signed session cookie)
 *   Required        enabled | disabledForLocalAddresses
 *   API key         X-Api-Key header or ?apikey= always works (webhooks, scripts)
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { store } from './store.js';
import { isLocalAddress, safeEqual, verifyPassword } from './general.js';
import { appEvents } from './system.js';

const COOKIE = 'rexarr_session';
const SESSION_DAYS = 30;

/** Requests that never need credentials. */
function isPublic(url: string) {
  return url === '/api/health' || url.startsWith('/login') || url.startsWith('/logout') || url === '/favicon.ico' || url.startsWith('/api/auth/');
}

/** Sessions are signed with a key derived from the password hash and API key, so changing either signs everyone out. */
function sessionKey() {
  const s = store.settings.general.security;
  return crypto.createHash('sha256').update(`rexarr-session:${s.passwordHash}:${s.apiKey}`).digest();
}

function sign(payload: string) {
  return crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
}

export function createSession(username: string, remember: boolean) {
  const expires = Date.now() + (remember ? SESSION_DAYS * 86400_000 : 12 * 3600_000);
  const payload = `${Buffer.from(username).toString('base64url')}.${expires}`;
  return { value: `${payload}.${sign(payload)}`, expires: new Date(expires) };
}

function readSession(req: FastifyRequest): string | null {
  const raw = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [user, expires, sig] = decodeURIComponent(raw).split('.');
  if (!user || !expires || !sig) return null;
  if (!safeEqual(sig, sign(`${user}.${expires}`))) return null;
  if (Number(expires) < Date.now()) return null;
  const name = Buffer.from(user, 'base64url').toString();
  return name === store.settings.general.security.username ? name : null;
}

/** Client address; X-Forwarded-For is only believed when the direct peer is itself local (a reverse proxy). */
export function clientIp(req: FastifyRequest): string {
  const peer = req.socket.remoteAddress ?? '';
  const fwd = req.headers['x-forwarded-for'];
  if (fwd && isLocalAddress(peer)) return String(fwd).split(',')[0].trim();
  return peer;
}

function apiKeyOk(req: FastifyRequest) {
  const key = store.settings.general.security.apiKey;
  const given = (req.headers['x-api-key'] as string | undefined) ?? ((req.query as Record<string, string> | undefined)?.apikey ?? '');
  return Boolean(key && given && safeEqual(String(given), key));
}

const failures = new Map<string, { n: number; until: number }>();
function throttled(ip: string) {
  const f = failures.get(ip);
  return Boolean(f && f.until > Date.now());
}
function noteFailure(ip: string, user: string) {
  const f = failures.get(ip) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60_000, 2 ** (f.n - 5) * 30_000);
  failures.set(ip, f);
  appEvents.add('warning', 'Security', `Failed login for "${user}" from ${ip}`);
}

export function checkCredentials(username: string, password: string, ip: string): boolean {
  const s = store.settings.general.security;
  if (throttled(ip)) return false;
  const ok = Boolean(s.username && s.passwordHash) && safeEqual(username, s.username) && verifyPassword(password, s.passwordHash);
  if (ok) failures.delete(ip);
  else noteFailure(ip, username);
  return ok;
}

/** Is authentication actually in force (a method is chosen and credentials exist)? */
export function authActive() {
  const s = store.settings.general.security;
  return s.authentication !== 'none' && Boolean(s.username && s.passwordHash);
}

export function registerAuth(app: FastifyInstance, urlBase: string) {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = (req.raw.url ?? '/').split('?')[0];
    if (isPublic(url) || !authActive()) return;
    const s = store.settings.general.security;
    if (apiKeyOk(req)) return;
    if (s.authenticationRequired === 'disabledForLocalAddresses' && isLocalAddress(clientIp(req))) return;

    if (s.authentication === 'basic') {
      const h = req.headers.authorization ?? '';
      if (h.startsWith('Basic ')) {
        const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
        if (checkCredentials(user, rest.join(':'), clientIp(req))) return;
      }
      return reply.code(401).header('WWW-Authenticate', `Basic realm="${store.settings.general.host.instanceName || 'rexarr'}", charset="UTF-8"`).send({ error: 'authentication required' });
    }

    // forms
    if (readSession(req)) return;
    if (url.startsWith('/api/')) return reply.code(401).send({ error: 'authentication required', login: `${urlBase}/login` });
    return reply.redirect(`${urlBase}/login?returnUrl=${encodeURIComponent(`${urlBase}${req.raw.url ?? '/'}`)}`);
  });

  app.get('/login', async (req, reply) => {
    const q = req.query as { returnUrl?: string; failed?: string };
    if (!authActive() || store.settings.general.security.authentication !== 'forms') return reply.redirect(`${urlBase}/`);
    return reply.type('text/html').send(loginPage(urlBase, q.returnUrl, q.failed !== undefined, throttled(clientIp(req))));
  });

  app.post('/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string; rememberMe?: string; returnUrl?: string };
    const ip = clientIp(req);
    const back = safeReturn(urlBase, body.returnUrl);
    if (!checkCredentials(String(body.username ?? ''), String(body.password ?? ''), ip)) {
      return reply.redirect(`${urlBase}/login?failed&returnUrl=${encodeURIComponent(back)}`);
    }
    const session = createSession(String(body.username), body.rememberMe === 'on');
    appEvents.add('info', 'Security', `${body.username} signed in from ${ip}`);
    return reply.header('Set-Cookie', cookie(urlBase, session.value, body.rememberMe === 'on' ? session.expires : undefined, req)).redirect(back);
  });

  app.get('/logout', async (req, reply) => reply.header('Set-Cookie', cookie(urlBase, '', new Date(0), req)).redirect(`${urlBase}/login`));

  app.get('/api/auth/status', async () => {
    const s = store.settings.general.security;
    return { authentication: authActive() ? s.authentication : 'none', username: authActive() ? s.username : undefined };
  });
}

function cookie(urlBase: string, value: string, expires: Date | undefined, req: FastifyRequest) {
  const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=${urlBase || '/'}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}${expires ? `; Expires=${expires.toUTCString()}` : ''}`;
}

/** Only redirect back into this app. */
function safeReturn(urlBase: string, returnUrl?: string) {
  const r = String(returnUrl ?? '');
  return r.startsWith('/') && !r.startsWith('//') && !r.startsWith(`${urlBase}/login`) ? r : `${urlBase}/`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Standalone login page in the style of Sonarr's login.html. */
function loginPage(urlBase: string, returnUrl: string | undefined, failed: boolean, locked: boolean) {
  const name = esc(store.settings.general.host.instanceName || 'Rexarr');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login - ${name}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #202020; color: #ccc; font-family: "Roboto", "open sans", "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 14px; }
  .card { width: 100%; max-width: 350px; margin: 20px; border-radius: 4px; background: #333; box-shadow: 0 0 10px 1px rgba(0,0,0,.4); overflow: hidden; }
  .head { display: flex; align-items: center; justify-content: center; height: 72px; background: #2a2a2a; color: #fff; font-size: 26px; font-weight: 300; letter-spacing: .5px; }
  form { padding: 20px; }
  label { display: block; margin: 0 0 6px; font-weight: bold; }
  input[type=text], input[type=password] { box-sizing: border-box; width: 100%; height: 35px; margin-bottom: 15px; padding: 6px 16px; border: 1px solid #dde6e9; border-radius: 4px; background: #333; color: #ccc; font-size: 14px; box-shadow: inset 0 1px 1px rgba(0,0,0,.075); }
  input:focus { outline: none; border-color: #66afe9; box-shadow: inset 0 1px 1px rgba(0,0,0,.075), 0 0 8px rgba(102,175,233,.6); }
  .remember { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; }
  button { width: 100%; padding: 10px; border: 1px solid #5899eb; border-radius: 4px; background: #5d9cec; color: #fff; font-size: 16px; cursor: pointer; }
  button:hover { background: #3483e7; }
  .error { margin-bottom: 15px; padding: 10px 12px; border: 1px solid #a94442; border-radius: 4px; background: rgba(169,68,66,.4); color: #fff; }
  .foot { padding: 0 20px 18px; color: #909293; font-size: 12px; text-align: center; }
</style></head>
<body><div class="card"><div class="head">${name}</div>
<form method="post" action="${esc(urlBase)}/login">
  ${locked ? '<div class="error">Too many failed attempts. Try again in a few minutes.</div>' : failed ? '<div class="error">Incorrect username or password</div>' : ''}
  <input type="hidden" name="returnUrl" value="${esc(returnUrl ?? `${urlBase}/`)}">
  <label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" autofocus required>
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
  <div class="remember"><input id="rememberMe" name="rememberMe" type="checkbox"><label for="rememberMe" style="margin:0;font-weight:normal">Remember me</label></div>
  <button type="submit">Login</button>
</form><div class="foot">Forgot your password? Set <code>REXARR_RESET_AUTH=1</code> and restart to turn authentication off.</div></div></body></html>`;
}
