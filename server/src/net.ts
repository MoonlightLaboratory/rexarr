/**
 * Outgoing HTTP for Radarr / Sonarr / Prowlarr, AniDB and cover art, honouring Settings → General:
 *   Proxy                   HTTP(S) proxy with credentials, bypass list and "bypass for local addresses"
 *   Certificate validation  enabled | disabled for local addresses | disabled
 */
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { store } from './store.js';
import { isLocalHostname } from './general.js';

let cacheKey = '';
const dispatchers = new Map<string, Dispatcher>();

function settingsKey() {
  const g = store.settings.general;
  return JSON.stringify([g.proxy, g.security.certificateValidation]);
}

/** "*.local, 192.168.1.*, nas" → does the host match? */
export function matchesBypass(host: string, filter: string): boolean {
  const h = host.toLowerCase();
  return filter
    .split(/[,;\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .some((p) => {
      const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
      return re.test(h);
    });
}

function dispatcherFor(url: URL): Dispatcher | undefined {
  const key = settingsKey();
  if (key !== cacheKey) {
    for (const d of dispatchers.values()) void d.close().catch(() => undefined);
    dispatchers.clear();
    cacheKey = key;
  }
  const g = store.settings.general;
  const local = isLocalHostname(url.hostname);
  const useProxy = g.proxy.enabled && g.proxy.hostname && !(g.proxy.bypassLocalAddresses && local) && !matchesBypass(url.hostname, g.proxy.bypassFilter);
  const cv = g.security.certificateValidation;
  const insecure = url.protocol === 'https:' && (cv === 'disabled' || (cv === 'disabledForLocalAddresses' && local));
  if (!useProxy && !insecure) return undefined;
  const id = `${useProxy ? 'p' : 'd'}${insecure ? 'i' : 's'}`;
  let d = dispatchers.get(id);
  if (!d) {
    const tls = insecure ? { rejectUnauthorized: false } : undefined;
    if (useProxy) {
      const auth = g.proxy.username ? `Basic ${Buffer.from(`${g.proxy.username}:${g.proxy.password}`).toString('base64')}` : undefined;
      d = new ProxyAgent({ uri: `http://${g.proxy.hostname}:${g.proxy.port}`, token: auth, requestTls: tls });
    } else d = new Agent({ connect: tls });
    dispatchers.set(id, d);
  }
  return d;
}

/** fetch() with the proxy / certificate settings applied. */
export function httpFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? new URL(input) : input;
  const dispatcher = dispatcherFor(url);
  if (!dispatcher) return fetch(url, init);
  // A dispatcher from the undici package must go through undici's own fetch (Node's bundled copy may differ).
  return undiciFetch(url, { ...(init as object), dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}
