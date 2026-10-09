/**
 * CDDB / freedb: track titles for audio CDs that MusicBrainz has no entry for.
 *
 *   Disc id  sum of the digits of every track's start second, mod 255, then the disc length and track count
 *   Query    cddb query <id> <ntracks> <offsets…> <seconds> over the HTTP CGI interface, proto 6 (UTF-8)
 *   Read     cddb read <category> <id> → an xmcd file: DTITLE, DYEAR, DGENRE, TTITLE0…n
 *
 * The protocol has no rate limit of its own; Rexarr only asks when a disc id found nothing at MusicBrainz.
 * gnudb.org, the maintained freedb successor, answers only applications registered with it ("500 Unknown
 * application, developer email for …"), which is why the server is a setting.
 */
import type { MusicBrainzRelease } from '../../../shared/types.js';
import { APP_VERSION } from '../config.js';
import { httpFetch } from '../net.js';
import { store } from '../store.js';
import type { CdToc } from './musicbrainz.js';

const digitSum = (n: number) => String(n).split('').reduce((a, c) => a + Number(c), 0);

/** The CDDB disc id of a TOC: eight hex digits, a different algorithm from MusicBrainz's. */
export function cddbDiscId(toc: CdToc): string {
  const seconds = toc.offsets.map((o) => Math.floor(o / 75));
  const length = Math.floor(toc.leadout / 75) - seconds[0];
  const n = seconds.reduce((a, s) => a + digitSum(s), 0) % 255;
  // (checksum << 24) | (seconds << 8) | track count, as unsigned 32-bit
  return (((n << 24) | (length << 8) | toc.offsets.length) >>> 0).toString(16).padStart(8, '0');
}

/** The argument list of a `cddb query`: disc id, track count, every frame offset, then the disc length. */
export function cddbQueryArgs(toc: CdToc): string[] {
  return [cddbDiscId(toc), String(toc.offsets.length), ...toc.offsets.map(String), String(Math.floor(toc.leadout / 75))];
}

export interface CddbMatch {
  category: string;
  discId: string;
  artist: string;
  title: string;
}

const splitSlash = (s: string): [string, string] => {
  const at = s.indexOf(' / ');
  return at < 0 ? [s.trim(), s.trim()] : [s.slice(0, at).trim(), s.slice(at + 3).trim()];
};

/**
 * A query answer. 200 is one match, 210 / 211 a list of them until a lone ".", 202 none. Anything else – a
 * server that refuses the client, a corrupt database – throws, so the disc log says what was wrong.
 */
export function parseCddbQuery(text: string): CddbMatch[] {
  const lines = text.split(/\r?\n/);
  const code = Number(lines[0]?.slice(0, 3));
  const one = (line: string): CddbMatch | null => {
    const m = line.match(/^(\S+)\s+([0-9a-fA-F]{8})\s+(.*)$/);
    if (!m) return null;
    const [artist, title] = splitSlash(m[3]);
    return { category: m[1], discId: m[2].toLowerCase(), artist, title };
  };
  if (code === 202 || code === 403) return [];
  if (code === 200) return [one(lines[0].slice(4))].filter((x): x is CddbMatch => Boolean(x));
  if (code === 210 || code === 211) {
    return lines
      .slice(1)
      .filter((l) => l.trim() && l.trim() !== '.')
      .map(one)
      .filter((x): x is CddbMatch => Boolean(x));
  }
  throw new Error(lines[0]?.trim() || 'no answer');
}

export interface XmcdEntry {
  discId?: string;
  artist: string;
  title: string;
  year?: number;
  genre?: string;
  tracks: { number: number; title: string; artist?: string }[];
}

/**
 * An xmcd file. A long value is split over several lines that repeat the key and are joined with nothing
 * between them, so "DTITLE=Pink Floyd / The" + "DTITLE= Wall" is one title. \n, \t and \\ are escapes.
 */
export function parseXmcd(text: string): XmcdEntry | null {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.trim() === '.') continue;
    const at = line.indexOf('=');
    if (at < 0) continue;
    const key = line.slice(0, at);
    fields.set(key, (fields.get(key) ?? '') + line.slice(at + 1));
  }
  const unescape = (v: string) => v.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\').trim();
  const dtitle = fields.get('DTITLE');
  if (dtitle === undefined) return null;
  const [albumArtist, title] = splitSlash(unescape(dtitle));
  const tracks: XmcdEntry['tracks'] = [];
  for (let i = 0; fields.has(`TTITLE${i}`); i++) {
    const raw = unescape(fields.get(`TTITLE${i}`)!);
    // on a compilation each title is "artist / track"; a plain title has no slash and keeps the album's artist
    const at = raw.indexOf(' / ');
    const artist = at < 0 ? undefined : raw.slice(0, at).trim();
    tracks.push({ number: i + 1, title: at < 0 ? raw : raw.slice(at + 3).trim(), artist });
  }
  const year = Number(fields.get('DYEAR')) || undefined;
  return { discId: fields.get('DISCID')?.trim().split(',')[0], artist: albumArtist || 'Unknown Artist', title: title || 'Unknown Album', year, genre: unescape(fields.get('DGENRE') ?? '') || undefined, tracks };
}

/** An xmcd entry as one of the release matches shown for a disc. */
export function toRelease(entry: XmcdEntry, match: Pick<CddbMatch, 'category' | 'discId'>): MusicBrainzRelease {
  return {
    source: 'cddb',
    releaseId: `${match.category}/${match.discId}`,
    cddbId: match.discId,
    title: entry.title,
    artist: entry.artist,
    date: entry.year ? String(entry.year) : undefined,
    genre: entry.genre,
    discNumber: 1,
    discCount: 1,
    format: 'CD',
    trackCount: entry.tracks.length,
    tracks: entry.tracks.map((t) => ({ number: t.number, title: t.title, artist: t.artist })),
  };
}

const hello = () => `user ${process.env.HOSTNAME || 'localhost'} rexarr ${APP_VERSION}`;

async function cddbCommand(cmd: string[]): Promise<string> {
  const base = store.settings.cddb.server.trim();
  if (!base) throw new Error('no CDDB server is set');
  const url = `${base}${base.includes('?') ? '&' : '?'}cmd=${encodeURIComponent(cmd.join(' '))}&hello=${encodeURIComponent(hello())}&proto=6`;
  const res = await httpFetch(url, { headers: { 'User-Agent': `rexarr/${APP_VERSION}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/** Every CDDB entry for a disc, best match first. Returns nothing when CDDB is off or the disc is unknown. */
export async function cddbLookup(toc: CdToc, limit = 5): Promise<MusicBrainzRelease[]> {
  if (!store.settings.cddb.enabled) return [];
  const matches = parseCddbQuery(await cddbCommand(['cddb', 'query', ...cddbQueryArgs(toc)]));
  const out: MusicBrainzRelease[] = [];
  for (const m of matches.slice(0, limit)) {
    const entry = parseXmcd(await cddbCommand(['cddb', 'read', m.category, m.discId]));
    if (entry) out.push(toRelease(entry, m));
  }
  return out;
}
