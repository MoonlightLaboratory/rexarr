/**
 * Barcode → a title Rexarr can act on (Settings → Experiments).
 *
 * A disc's UPC / EAN says nothing by itself, so it is looked up in two places that need no account:
 * MusicBrainz, which indexes barcodes properly for music, and UPCitemdb's trial endpoint for everything else
 * (100 lookups a day per address). What comes back is a shop listing - "Blade Runner 2049 [4K UHD + Blu-ray]" -
 * so the edition noise is stripped before the title is matched against the library the same way a disc label is.
 */
import type { ExpectedDisc } from '../../shared/types.js';
import { APP_VERSION } from './config.js';
import { httpFetch } from './net.js';
import { matchLibrary, type LibraryCandidate } from './disc/identify.js';
import { discDbByBarcode } from './discdb.js';

export interface BarcodeProduct {
  code: string;
  /** What the lookup called it. */
  product: string;
  /** The title after the edition noise is removed. */
  title: string;
  year?: number;
  seasonNumber?: number;
  kind: 'movie' | 'series' | 'album';
  source: 'thediscdb' | 'musicbrainz' | 'upcitemdb';
  artist?: string;
  /** TheDiscDB knows exactly which release this is, so the *arr apps can be told rather than asked. */
  tmdbId?: number;
  imdbId?: string;
  /** Where the release can be read about. */
  url?: string;
}

/** A barcode is 8–14 digits; people read them off the box with spaces and dashes in. */
export function normaliseCode(input: string): string | null {
  const digits = (input || '').replace(/\D+/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

const EDITION = new RegExp(
  [
    '4k ultra hd', 'ultra hd', 'uhd', 'blu-?ray', 'bluray', 'bd', 'dvd', 'digital( copy| hd)?', 'steelbook',
    'collector\'?s edition', 'limited edition', 'special edition', 'deluxe edition', 'anniversary edition',
    'director\'?s cut', 'extended edition', 'remastered', 'box ?set', 'boxset', 'complete (series|collection|season)',
    'the complete \\w+', 'import', 'region [abc124]', 'ntsc', 'pal', 'widescreen', 'fullscreen', 'combo pack',
    'with digital', 'includes digital', '\\d+ disc', '\\d+-disc', 'disc \\d+', 'new & sealed', 'sealed',
    '(?:with |w/ ?)?slip ?cover', 'factory sealed', 'brand new', 'free shipping', 'oop', 'rare',
  ].join('|'),
  'gi',
);

/**
 * "Frieren: Beyond Journey's End - Season 1 [Blu-ray] (2024)" → title, season and year.
 *
 * Only a year in brackets counts as the year: plenty of titles end in one ("Blade Runner 2049", "1917"), and
 * Radarr and Sonarr can find a film without being told its year anyway.
 */
export function cleanProductTitle(product: string): { title: string; year?: number; seasonNumber?: number } {
  const s0 = ` ${product} `;
  const year = s0.match(/[([{]\s*(19\d{2}|20\d{2})\s*[)\]}]/)?.[1];
  const season = s0.match(/\b(?:season|series|staffel)\s*(\d{1,2})\b/i)?.[1] ?? s0.match(/\bvol(?:ume)?\.?\s*(\d{1,2})\b/i)?.[1];
  const title = s0
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')          // [Blu-ray], (2017), (Region A)
    .replace(EDITION, ' ')
    .replace(/\b(?:season|series|staffel)\s*\d{1,2}\b/gi, ' ')
    .replace(/\bvol(?:ume)?\.?\s*\d{1,2}\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/\b(?:with|and|plus|w\/)\s*$/i, '')     // "… Sealed With Slipcover" leaves a dangling "With"
    .replace(/[\s\-–—:,/|+]+$/, '')
    .replace(/^[\s\-–—:,/|+]+/, '')
    .trim();
  return { title, year: year ? Number(year) : undefined, seasonNumber: season ? Number(season) : undefined };
}

/** Music first: MusicBrainz knows barcodes, and an exact hit there is worth more than a shop listing. */
async function musicbrainz(code: string): Promise<BarcodeProduct | null> {
  const url = `https://musicbrainz.org/ws/2/release?query=barcode:${encodeURIComponent(code)}&fmt=json&limit=1`;
  const res = await httpFetch(url, { headers: { 'user-agent': `Rexarr/${APP_VERSION} ( https://github.com/MoonlightLaboratory/rexarr )` } });
  if (!res.ok) return null;
  const body = (await res.json()) as { releases?: { title?: string; date?: string; 'artist-credit'?: { name?: string }[] }[] };
  const r = body.releases?.[0];
  if (!r?.title) return null;
  return {
    code,
    product: r.title,
    title: r.title,
    year: r.date ? Number(r.date.slice(0, 4)) || undefined : undefined,
    kind: 'album',
    artist: r['artist-credit']?.[0]?.name,
    source: 'musicbrainz',
  };
}

async function upcitemdb(code: string): Promise<BarcodeProduct | null> {
  const res = await httpFetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`, {
    headers: { accept: 'application/json', 'user-agent': `Rexarr/${APP_VERSION}` },
  });
  if (res.status === 429) throw new Error('UPCitemdb has rate limited this address (100 lookups a day) – try again tomorrow, or type the title in by hand');
  if (!res.ok) return null;
  const body = (await res.json()) as { items?: { title?: string; category?: string; brand?: string }[] };
  const item = body.items?.find((i) => i.title);
  if (!item?.title) return null;
  const { title, year, seasonNumber } = cleanProductTitle(item.title);
  return {
    code,
    product: item.title,
    title: title || item.title,
    year,
    seasonNumber,
    kind: guessKind(item.title, item.category),
    source: 'upcitemdb',
  };
}

/** A shop listing usually says what it is somewhere in the title or the category. */
export function guessKind(title: string, category?: string): 'movie' | 'series' | 'album' {
  const s = `${title} ${category ?? ''}`.toLowerCase();
  if (/\b(cds?|vinyl|lps?|albums?|soundtracks?|music)\b/.test(s) && !/\b(dvd|blu-?ray|uhd)\b/.test(s)) return 'album';
  if (/\b(season|series|complete series|episodes|staffel|tv)\b/.test(s)) return 'series';
  return 'movie';
}

/** Look a barcode up. Music is tried first, then the general product database. */
export async function lookupBarcode(code: string): Promise<BarcodeProduct | null> {
  const clean = normaliseCode(code);
  if (!clean) throw new Error(`"${code}" is not a barcode (8 to 14 digits)`);
  // TheDiscDB first: it catalogues the disc itself, so a hit is the release, with its ids
  const disc = await discDbByBarcode(clean).catch(() => null);
  if (disc) {
    return {
      code: clean,
      product: `${disc.title}${disc.year ? ` (${disc.year})` : ''}`,
      title: disc.title,
      year: disc.year,
      kind: disc.kind,
      source: 'thediscdb',
      tmdbId: disc.tmdbId,
      imdbId: disc.imdbId,
      url: disc.url,
    };
  }
  const mb = await musicbrainz(clean).catch(() => null);
  if (mb) return mb;
  return upcitemdb(clean);
}

/** The library entries that could be what was scanned, best first. */
export function rankAgainstLibrary(product: BarcodeProduct, items: LibraryCandidate[]): { item: LibraryCandidate; score: number; season?: number } | null {
  const match = matchLibrary(product.title, items, { preferSeries: product.kind === 'series' });
  return match ? { item: match.item, score: match.score, season: match.season ?? product.seasonNumber } : null;
}

export function toExpected(product: BarcodeProduct, over: Partial<ExpectedDisc> = {}): ExpectedDisc {
  return {
    id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    code: product.code,
    title: product.title,
    year: product.year,
    kind: product.kind === 'album' ? 'movie' : product.kind,
    seasonNumber: product.seasonNumber,
    product: product.product,
    addedAt: new Date().toISOString(),
    ...over,
  };
}
