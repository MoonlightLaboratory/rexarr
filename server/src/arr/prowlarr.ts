import type { ArrConnection, Release } from '../../../shared/types.js';
import { ArrHttp } from './client.js';
import { detectDisc, isRemux } from './remux.js';
import { httpFetch } from '../net.js';

interface PRelease {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  seeders?: number;
  leechers?: number;
  protocol: string;
  age?: number;
  approved?: boolean;
  downloadUrl?: string;
  categories?: { id: number; name: string }[];
}

/** Rough resolution guess from a release title. */
function resolutionFromTitle(title: string) {
  const m = title.match(/(\d{3,4})p\b/i);
  if (m) return Number(m[1]);
  if (/\b(2160|4k|uhd)\b/i.test(title)) return 2160;
  return 0;
}

export class Prowlarr {
  http: ArrHttp;
  constructor(conn: ArrConnection) {
    this.http = new ArrHttp(conn, '/api/v1', 'Prowlarr');
  }
  get configured() {
    return this.http.configured;
  }
  status() {
    return this.http.get<{ version: string; appName: string }>('/system/status', undefined, 10_000);
  }

  /** Raw search across all indexers. categories: 2000 = movies, 5000 = TV. */
  async search(query: string, kind: 'movie' | 'tv' | 'all'): Promise<Release[]> {
    const cats = kind === 'movie' ? [2000] : kind === 'tv' ? [5000] : [2000, 5000];
    const base = this.http.conn;
    const u = new URL(base.url.replace(/\/+$/, '') + '/api/v1/search');
    u.searchParams.set('query', query);
    u.searchParams.set('type', 'search');
    for (const c of cats) u.searchParams.append('categories', String(c));
    const res = await httpFetch(u, { headers: { 'X-Api-Key': base.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`Prowlarr: HTTP ${res.status}`);
    const list = (await res.json()) as PRelease[];
    return list.map((r) => ({
      ...(() => {
        const d = detectDisc(r.title, '', resolutionFromTitle(r.title));
        return { isDisc: d.isDisc, discFormat: d.format };
      })(),
      guid: r.guid,
      indexerId: r.indexerId,
      indexer: r.indexer,
      title: r.title,
      size: r.size,
      quality: isRemux(r.title) ? `Remux-${resolutionFromTitle(r.title) || '?'}p` : detectDisc(r.title).isDisc ? `Disc-${resolutionFromTitle(r.title) || (detectDisc(r.title).format === 'dvd' ? 'DVD' : '?')}${resolutionFromTitle(r.title) ? 'p' : ''}` : 'Unknown',
      resolution: resolutionFromTitle(r.title),
      isRemux: isRemux(r.title),
      seeders: r.seeders ?? null,
      leechers: r.leechers ?? null,
      protocol: r.protocol,
      ageDays: r.age ?? 0,
      languages: [],
      approved: true,
      rejections: [],
      source: 'prowlarr' as const,
      downloadUrl: r.downloadUrl,
    }));
  }

  /** Send a release to the download client configured in Prowlarr. */
  grab(guid: string, indexerId: number) {
    return this.http.post('/search', { guid, indexerId });
  }
}
