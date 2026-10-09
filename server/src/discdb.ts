/**
 * TheDiscDB (https://thediscdb.com) – a community catalogue of physical disc releases: what is on each disc, and
 * the barcode, IMDb and TMDb ids that go with it. No account, no key.
 *
 * Rexarr uses it for the one thing it is uniquely good at: turning the barcode on a case into an exact title.
 * A shop listing has to be cleaned up and guessed at ("Reign Of The Supermen (4k Ultra Hd + Blu-ray + Digital)
 * Sealed With Slipcover"); a hit here comes back as the film with its TMDb id attached.
 */
import { APP_VERSION } from './config.js';
import { httpFetch } from './net.js';
import { store } from './store.js';

const BASE = 'https://thediscdb.com';

export interface DiscDbMatch {
  kind: 'movie' | 'series';
  title: string;
  /** The year in the slug, when it has one: "1917-2019" → 1917, 2019. */
  year?: number;
  slug: string;
  url: string;
  imdbId?: string;
  tmdbId?: number;
  upcs: string[];
  asins: string[];
}

interface RawResult {
  id?: string;
  type?: string;
  title?: string;
  relativeUrl?: string;
  identifiers?: string[];
  mediaItem?: { slug?: string };
}

/** The identifiers come as one flat list: "tt8579674", "530915", "191329125670", "BR61209848". */
export function parseIdentifiers(ids: string[] = []): { imdbId?: string; tmdbId?: number; upcs: string[]; asins: string[] } {
  const out: { imdbId?: string; tmdbId?: number; upcs: string[]; asins: string[] } = { upcs: [], asins: [] };
  for (const raw of ids) {
    const id = (raw ?? '').trim();
    if (!id) continue;
    if (/^tt\d{6,}$/i.test(id)) out.imdbId ??= id.toLowerCase();
    else if (/^\d{8,14}$/.test(id)) out.upcs.push(id);            // a barcode
    else if (/^\d{1,7}$/.test(id)) out.tmdbId ??= Number(id);     // TMDb ids are short numbers
    else if (/^[A-Z0-9]{8,12}$/.test(id)) out.asins.push(id);     // ASIN / catalogue number
  }
  return out;
}

export function toMatch(raw: RawResult): DiscDbMatch | null {
  const title = (raw.title ?? '').trim();
  const slug = raw.mediaItem?.slug ?? (raw.relativeUrl ?? '').split('/').filter(Boolean).pop() ?? '';
  if (!title || !slug) return null;
  const kind = (raw.type ?? '').toLowerCase() === 'series' ? 'series' : 'movie';
  const year = Number(slug.match(/-(\d{4})$/)?.[1]) || undefined;
  return { kind, title, year, slug, url: `${BASE}${raw.relativeUrl ?? `/${kind}/${slug}`}`, ...parseIdentifiers(raw.identifiers) };
}

const cache = new Map<string, { at: number; value: DiscDbMatch[] }>();

/** Ask TheDiscDB. Returns [] when it is switched off, knows nothing, or is having a bad day. */
export async function searchDiscDb(query: string): Promise<DiscDbMatch[]> {
  const q = query.trim();
  if (!q || store.settings.thediscdb?.enabled === false) return [];
  const hit = cache.get(q.toLowerCase());
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  try {
    const res = await httpFetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`, {
      headers: { accept: 'application/json', 'user-agent': `Rexarr/${APP_VERSION}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as RawResult[];
    const value = (Array.isArray(body) ? body : []).map(toMatch).filter((m): m is DiscDbMatch => m !== null);
    cache.set(q.toLowerCase(), { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return value;
  } catch {
    return [];
  }
}

/** A barcode is only a match when the release actually carries it - search is fuzzy, barcodes are not. */
export async function discDbByBarcode(code: string): Promise<DiscDbMatch | null> {
  const digits = code.replace(/\D+/g, '');
  if (digits.length < 8) return null;
  const results = await searchDiscDb(digits);
  return results.find((r) => r.upcs.some((u) => u.replace(/^0+/, '') === digits.replace(/^0+/, ''))) ?? null;
}
