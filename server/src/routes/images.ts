import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PATHS } from '../config.js';
import { store } from '../store.js';
import { httpFetch } from '../net.js';

/**
 * Cover-art proxy + disk cache, like the *arr MediaCover endpoints.
 *
 *   /api/image?arr=radarr&local=/MediaCover/97/poster.jpg&remote=https://image.tmdb.org/...
 *
 * The arr app's own (already downloaded, resized) copy is tried first over the LAN with the API key, then
 * the remote URL. Results are cached under data/images and served with long cache headers, so the browser
 * never talks to TMDB / TheTVDB directly and a slow or rate-limited CDN cannot leave posters blank.
 */
const ALLOWED_REMOTE = [/(^|\.)coverartarchive\.org$/, /(^|\.)archive\.org$/, /(^|\.)theaudiodb\.com$/, /(^|\.)lastfm\.freetls\.fastly\.net$/, /(^|\.)last\.fm$/, /(^|\.)discogs\.com$/, /(^|\.)tmdb\.org$/, /(^|\.)thetvdb\.com$/, /(^|\.)fanart\.tv$/, /(^|\.)themoviedb\.org$/, /(^|\.)anidb\.net$/, /(^|\.)githubusercontent\.com$/, /(^|\.)lidarr\.audio$/];
const CACHE_DIR = PATHS.images;
const inflight = new Map<string, Promise<{ file: string; type: string } | null>>();

function keyFor(parts: string[]) {
  return createHash('sha1').update(parts.join('|')).digest('hex');
}

async function fetchImage(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ buf: Buffer; type: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await httpFetch(url, { headers: { Accept: 'image/*', 'User-Agent': 'rexarr/0.1', ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const type = res.headers.get('content-type') ?? 'image/jpeg';
      if (!type.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return null;
      return { buf, type };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

function extFor(type: string) {
  return type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg';
}

/**
 * Paths to try on the arr app for a /MediaCover/ image. Lidarr (and any app behind forms login) does not serve
 * /MediaCover to API-key requests – it answers with the login page – but its API has the same files under
 * /api/v1/mediacover/{artist|album}/<id>/<file>. The resized variant may not exist yet, so the original follows.
 */
export function localCandidates(arr: 'radarr' | 'sonarr' | 'lidarr', local: string): string[] {
  const [pathname, query = ''] = local.split('?');
  const original = pathname.replace(/-(250|500|1280)(\.\w+)$/, '$2');
  const variants = [...new Set([pathname, original])];
  const out: string[] = [];
  if (arr === 'lidarr') {
    for (const v of variants) {
      const m = v.match(/^\/MediaCover\/(?:(Albums|Artists)\/)?(\d+)\/([^/]+)$/);
      if (m) out.push(`/api/v1/mediacover/${m[1] === 'Albums' ? 'album' : 'artist'}/${m[2]}/${m[3]}`);
    }
  }
  out.push(...variants.map((v) => (query ? `${v}?${query}` : v)));
  return out;
}

/** Resolve (download + cache) an image; returns the cached file and content type. */
async function resolve(arr: 'radarr' | 'sonarr' | 'lidarr' | undefined, local: string | undefined, remote: string | undefined): Promise<{ file: string; type: string } | null> {
  const key = keyFor([arr ?? '', local ?? '', remote ?? '']);
  // Cached already?
  for (const ext of ['jpg', 'png', 'webp', 'gif']) {
    const f = path.join(CACHE_DIR, `${key}.${ext}`);
    if (fs.existsSync(f)) return { file: f, type: `image/${ext === 'jpg' ? 'jpeg' : ext}` };
  }
  if (inflight.has(key)) return inflight.get(key)!;
  const job = (async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    let got: { buf: Buffer; type: string } | null = null;
    // 1. the *arr app's own copy (fast, local network, already resized)
    if (arr && local && local.startsWith('/MediaCover/')) {
      const conn = store.settings[arr];
      if (conn.enabled && conn.url && conn.apiKey) {
        const base = conn.url.replace(/\/+$/, '');
        for (const p of localCandidates(arr, local)) {
          got = await fetchImage(`${base}${p}`, { 'X-Api-Key': conn.apiKey }, 8000);
          if (got) break;
        }
      }
    }
    // 2. the remote source (TMDB / TheTVDB)
    if (!got && remote) {
      try {
        const host = new URL(remote).hostname;
        if (ALLOWED_REMOTE.some((re) => re.test(host))) got = await fetchImage(remote, {}, 20000);
      } catch {
        /* bad url */
      }
    }
    if (!got) return null;
    const file = path.join(CACHE_DIR, `${key}.${extFor(got.type)}`);
    fs.writeFileSync(`${file}.tmp`, got.buf);
    fs.renameSync(`${file}.tmp`, file);
    return { file, type: got.type };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Build a proxied image URL for the client. Prefers the arr's resized variant when one exists. */
export function proxiedImage(arr: 'radarr' | 'sonarr' | 'lidarr', img: { remoteUrl?: string; url?: string } | undefined, size: 'poster' | 'fanart'): string | undefined {
  if (!img) return undefined;
  let local = img.url;
  if (local) {
    // Strip any urlbase prefix before /MediaCover and pick the resized variant the arr app generates.
    const i = local.indexOf('/MediaCover/');
    local = i >= 0 ? local.slice(i) : undefined;
    if (local) local = local.replace(/\/(poster|fanart|banner|cover)\.(jpg|png)/, size === 'poster' ? '/$1-500.$2' : '/$1-1280.$2');
  }
  let remote = img.remoteUrl;
  if (remote) remote = remote.replace('image.tmdb.org/t/p/original/', size === 'poster' ? 'image.tmdb.org/t/p/w500/' : 'image.tmdb.org/t/p/w1280/');
  if (!local && !remote) return undefined;
  const q = new URLSearchParams();
  q.set('arr', arr);
  if (local) q.set('local', local);
  if (remote) q.set('remote', remote);
  // relative: resolves against <base href> so it works under a URL base
  return `api/image?${q.toString()}`;
}

export default async function imageRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { arr?: string; local?: string; remote?: string } }>('/api/image', async (req, reply) => {
    const arr = req.query.arr === 'radarr' || req.query.arr === 'sonarr' || req.query.arr === 'lidarr' ? req.query.arr : undefined;
    const local = req.query.local?.startsWith('/MediaCover/') ? req.query.local : undefined;
    const remote = req.query.remote?.startsWith('https://') ? req.query.remote : undefined;
    if (!local && !remote) return reply.code(400).send({ error: 'local or remote required' });
    let hit: { file: string; type: string } | null = null;
    try {
      hit = await resolve(arr, local, remote);
    } catch {
      hit = null;
    }
    if (!hit) return reply.code(502).header('Cache-Control', 'no-store').send({ error: 'image unavailable' });
    const etag = `"${path.basename(hit.file)}"`;
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.header('Content-Type', hit.type).header('Cache-Control', 'public, max-age=604800, immutable').header('ETag', etag);
    return reply.send(fs.createReadStream(hit.file));
  });
}
