/**
 * Settings → General helpers: host values (with environment overrides), passwords, API key, local address checks.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type { GeneralSettings, Settings } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../shared/presets.js';

export const IN_DOCKER = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');

/** Environment variables win over saved host settings (Docker compose files set them). */
export function envHost(): Partial<Pick<GeneralSettings['host'], 'bindAddress' | 'port' | 'urlBase'>> {
  const out: Partial<Pick<GeneralSettings['host'], 'bindAddress' | 'port' | 'urlBase'>> = {};
  const port = process.env.REXARR_PORT ?? process.env.PORT;
  if (port && Number(port) > 0) out.port = Number(port);
  if (process.env.REXARR_HOST) out.bindAddress = process.env.REXARR_HOST;
  if (process.env.REXARR_URL_BASE !== undefined) out.urlBase = normalizeUrlBase(process.env.REXARR_URL_BASE);
  return out;
}

/** "rexarr/", "/rexarr/" → "/rexarr"; "" and "/" → "". */
export function normalizeUrlBase(s: string): string {
  const t = s.trim().replace(/^\/+|\/+$/g, '');
  return t ? `/${t}` : '';
}

/** "*" → all interfaces. */
export function listenHost(bindAddress: string): string {
  const b = bindAddress.trim();
  return !b || b === '*' ? '0.0.0.0' : b;
}

export function effectiveHost(g: GeneralSettings) {
  return { ...g.host, ...envHost(), urlBase: envHost().urlBase ?? normalizeUrlBase(g.host.urlBase) };
}

export function newApiKey() {
  return crypto.randomBytes(16).toString('hex');
}

// ---------- passwords (scrypt) ----------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, n, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n) || 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- local addresses ----------

/** Loopback, private (RFC 1918 / ULA), link-local and CGNAT ranges. */
export function isLocalAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  let a = ip.trim();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a === 'localhost') return true;
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254) || (p === 100 && q >= 64 && q <= 127);
  }
  if (net.isIPv6(a)) {
    const first = a.toLowerCase().split(':')[0];
    return /^f[cd]/.test(first) || /^fe[89ab]/.test(first);
  }
  return false;
}

/** Host names that are local to the network: IPs in local ranges, localhost, *.local / *.lan / *.home.arpa, single-label names. */
export function isLocalHostname(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(h)) return isLocalAddress(h);
  return h === 'localhost' || !h.includes('.') || /\.(local|lan|home|internal|home\.arpa)$/.test(h);
}

// ---------- settings merge / redaction ----------

/** Fill in General settings added in this version, and generate the API key on first run. */
export function withGeneralDefaults(s: Partial<Settings>): GeneralSettings {
  const d = DEFAULT_SETTINGS.general as GeneralSettings;
  const g = (s.general ?? {}) as Partial<GeneralSettings>;
  const merged: GeneralSettings = {
    host: { ...d.host, ...(g.host ?? {}) },
    security: { ...d.security, ...(g.security ?? {}) },
    proxy: { ...d.proxy, ...(g.proxy ?? {}) },
    logging: { ...d.logging, ...(g.logging ?? {}) },
    updates: { ...d.updates, ...(g.updates ?? { mechanism: IN_DOCKER ? 'docker' : 'external' }) },
    backups: { ...d.backups, ...(g.backups ?? {}) },
  };
  if (!merged.security.apiKey) merged.security.apiKey = newApiKey();
  delete merged.security.password;
  delete merged.security.passwordSet;
  return merged;
}

/** Settings as sent to the browser: no password hash. */
export function redactGeneral(g: GeneralSettings): GeneralSettings {
  return { ...g, security: { ...g.security, passwordHash: '', passwordSet: Boolean(g.security.passwordHash) } };
}
