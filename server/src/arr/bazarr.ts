/**
 * Bazarr: tell it about a disc that has just been imported, so the subtitles are looked for now rather than
 * whenever its own schedule next comes round.
 *
 * Rexarr already knows the two things Bazarr needs - whether this was a series or a film, and its Sonarr or
 * Radarr id - because that is what it just handed the files to. So the handover is two calls: look at the disk
 * again, because the file is new, then search for whatever is still missing.
 *
 * Bazarr is told, not asked. Nothing here changes what Rexarr does: a Bazarr that is down, misconfigured or
 * answering something unexpected is written to System → Events and the rip carries on, because a missing
 * subtitle is not a reason to fail a disc that ripped perfectly well.
 */
import type { ArrConnection } from '../../../shared/types.js';
import { httpFetch } from '../net.js';

export interface BazarrStatus {
  ok: boolean;
  version?: string;
  error?: string;
}

const base = (conn: ArrConnection) => conn.url.replace(/\/+$/, '');

export function configured(conn: ArrConnection | undefined): conn is ArrConnection {
  return Boolean(conn?.enabled && conn.url && conn.apiKey);
}

async function call(conn: ArrConnection, method: string, pathname: string, query: Record<string, string | number> = {}): Promise<unknown> {
  const u = new URL(`${base(conn)}/api${pathname}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await httpFetch(u, { method, headers: { 'X-API-KEY': conn.apiKey, Accept: 'application/json' }, signal: controller.signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Bazarr: ${res.status} ${res.statusText}${text ? ` – ${text.slice(0, 200)}` : ''}`);
    return text ? ((() => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })()) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Does this connection reach a Bazarr, and which one? For the Test button in Settings. */
export async function testBazarr(conn: ArrConnection): Promise<BazarrStatus> {
  if (!conn.url || !conn.apiKey) return { ok: false, error: 'URL and API key are both needed' };
  try {
    const body = (await call(conn, 'GET', '/system/status')) as { data?: { bazarr_version?: string } } | null;
    return { ok: true, version: body?.data?.bazarr_version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * A disc has landed. Have Bazarr notice the file and go looking for what is missing.
 *
 * `arrId` is the Sonarr series id or the Radarr movie id, which is what Bazarr indexes by too - it is reading
 * the same two apps. The disk scan comes first: searching for subtitles for a file Bazarr has not seen yet
 * finds nothing.
 */
export async function handOff(conn: ArrConnection, kind: 'series' | 'movie', arrId: number): Promise<string[]> {
  const path = kind === 'series' ? '/series' : '/movies';
  const key = kind === 'series' ? 'seriesid' : 'radarrid';
  const done: string[] = [];
  for (const action of ['scan-disk', 'search-missing']) {
    await call(conn, 'PATCH', path, { [key]: arrId, action });
    done.push(action);
  }
  return done;
}
