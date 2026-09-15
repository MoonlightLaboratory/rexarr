/**
 * MusicBrainz + Cover Art Archive: CD identification (disc id from the table of contents) and release metadata.
 *
 *   TOC     macOS: .TOC.plist on the mounted Audio CD volume · Linux: cdparanoia -Q / cd-paranoia -Q
 *   Disc id MusicBrainz algorithm: SHA-1 of first / last track, lead-out and 99 offsets, base64 with ._- alphabet
 *   Lookup  https://musicbrainz.org/ws/2/discid/<id>?toc=… (rate limited to 1 request per second, identified UA)
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MusicBrainzRelease } from '../../../shared/types.js';
import { APP_VERSION } from '../config.js';
import { httpFetch } from '../net.js';

const run = promisify(execFile);

export interface CdToc {
  firstTrack: number;
  lastTrack: number;
  /** Lead-out LBA + 150. */
  leadout: number;
  /** Track start LBA + 150, by track number. */
  offsets: number[];
  /** Audio tracks with their start sector and length in sectors (LBA, no 150 offset). */
  tracks: { number: number; startSector: number; sectors: number }[];
}

/** MusicBrainz disc id for a TOC. */
export function discId(toc: CdToc): string {
  let s = toc.firstTrack.toString(16).toUpperCase().padStart(2, '0') + toc.lastTrack.toString(16).toUpperCase().padStart(2, '0') + toc.leadout.toString(16).toUpperCase().padStart(8, '0');
  for (let i = 1; i <= 99; i++) {
    const off = i >= toc.firstTrack && i <= toc.lastTrack ? toc.offsets[i - toc.firstTrack] : 0;
    s += (off ?? 0).toString(16).toUpperCase().padStart(8, '0');
  }
  return crypto.createHash('sha1').update(s, 'ascii').digest('base64').replace(/\+/g, '.').replace(/\//g, '_').replace(/=/g, '-');
}

/** "first last leadout off1 off2 …" as used by the MusicBrainz ?toc= parameter. */
export function tocString(toc: CdToc): string {
  return [toc.firstTrack, toc.lastTrack, toc.leadout, ...toc.offsets].join(' ');
}

/** cdparanoia -Q output (stderr). */
export function parseCdparanoiaToc(text: string): CdToc | null {
  const tracks: CdToc['tracks'] = [];
  for (const m of text.matchAll(/^\s*(\d+)\.\s+(\d+)\s+\[[\d:.]+\]\s+(\d+)\s+\[/gm)) {
    tracks.push({ number: Number(m[1]), sectors: Number(m[2]), startSector: Number(m[3]) });
  }
  if (!tracks.length) return null;
  const last = tracks[tracks.length - 1];
  return { firstTrack: tracks[0].number, lastTrack: last.number, leadout: last.startSector + last.sectors + 150, offsets: tracks.map((t) => t.startSector + 150), tracks };
}

/** macOS: the .TOC.plist macOS puts on a mounted Audio CD. */
export function parseTocPlist(xml: string): CdToc | null {
  const leadout = Number(xml.match(/<key>Leadout Block<\/key>\s*<integer>(\d+)<\/integer>/)?.[1]);
  const tracks: CdToc['tracks'] = [];
  for (const dict of xml.split('<dict>').slice(1)) {
    const num = dict.match(/<key>Point<\/key>\s*<integer>(\d+)<\/integer>/)?.[1];
    const start = dict.match(/<key>Start Block<\/key>\s*<integer>(\d+)<\/integer>/)?.[1];
    const data = /<key>Data<\/key>\s*<true\/>/.test(dict);
    if (num && start && !data) tracks.push({ number: Number(num), startSector: Number(start), sectors: 0 });
  }
  if (!tracks.length || !leadout) return null;
  tracks.sort((a, b) => a.number - b.number);
  tracks.forEach((t, i) => (t.sectors = (tracks[i + 1]?.startSector ?? leadout) - t.startSector));
  return { firstTrack: tracks[0].number, lastTrack: tracks[tracks.length - 1].number, leadout: leadout + 150, offsets: tracks.map((t) => t.startSector + 150), tracks };
}

/** Read the TOC of the CD in a drive. */
export async function readCdToc(device: string, ripperPath = ''): Promise<CdToc | null> {
  if (process.platform === 'darwin') {
    // an inserted Audio CD is mounted by macOS with a .TOC.plist at its root
    for (const vol of fs.existsSync('/Volumes') ? fs.readdirSync('/Volumes') : []) {
      const plist = path.join('/Volumes', vol, '.TOC.plist');
      if (fs.existsSync(plist)) {
        const toc = parseTocPlist(fs.readFileSync(plist, 'utf8'));
        if (toc) return toc;
      }
    }
  }
  for (const bin of [ripperPath, 'cdparanoia', 'cd-paranoia'].filter(Boolean)) {
    const out = await run(bin, ['-Q', ...(device ? ['-d', device] : [])], { timeout: 30_000 }).then(
      (r) => `${r.stdout}${r.stderr}`,
      (e: { stdout?: string; stderr?: string; code?: string }) => (e.code === 'ENOENT' ? '' : `${e.stdout ?? ''}${e.stderr ?? ''}`),
    );
    const toc = parseCdparanoiaToc(out);
    if (toc) return toc;
  }
  return null;
}

// ---------- web service ----------

const UA = `rexarr/${APP_VERSION} ( https://github.com/MoonlightLaboratory )`;
let lastCall = 0;

let chain: Promise<unknown> = Promise.resolve();

/**
 * One request at a time, at most one per second (MusicBrainz's rate limit per client). "503 busy / slow down"
 * answers are retried with a growing pause.
 */
export function mb<T>(pathAndQuery: string): Promise<T> {
  const run = async (): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      const res = await httpFetch(`https://musicbrainz.org/ws/2/${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}fmt=json`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) throw Object.assign(new Error('not found'), { status: 404 });
      if ((res.status === 503 || res.status === 429) && attempt < 5) {
        await res.body?.cancel().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`MusicBrainz: HTTP ${res.status}`);
      return (await res.json()) as T;
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

interface MbCredit {
  name: string;
  joinphrase?: string;
  artist?: { id: string; name: string };
}
interface MbRelease {
  id: string;
  title: string;
  date?: string;
  country?: string;
  barcode?: string;
  'artist-credit'?: MbCredit[];
  'release-group'?: { id: string; 'primary-type'?: string };
  'label-info'?: { label?: { name: string } }[];
  'cover-art-archive'?: { front?: boolean };
  media?: { position: number; discs?: { id: string }[]; tracks?: { position: number; number: string; title: string; length?: number; recording?: { id: string; title: string; length?: number }; 'artist-credit'?: MbCredit[] }[] }[];
}

const credit = (c?: MbCredit[]) => (c ?? []).map((x) => `${x.name}${x.joinphrase ?? ''}`).join('').trim();

export function mapMbRelease(r: MbRelease, discIdForMedium?: string, trackCount?: number): MusicBrainzRelease {
  const media = r.media ?? [];
  let medium = media.find((m) => m.discs?.some((d) => d.id === discIdForMedium));
  if (!medium && trackCount) medium = media.find((m) => m.tracks?.length === trackCount);
  medium ??= media[0];
  return {
    releaseId: r.id,
    releaseGroupId: r['release-group']?.id,
    title: r.title,
    artist: credit(r['artist-credit']) || 'Unknown Artist',
    artistId: r['artist-credit']?.[0]?.artist?.id,
    date: r.date,
    country: r.country,
    label: r['label-info']?.[0]?.label?.name,
    barcode: r.barcode || undefined,
    discNumber: medium?.position ?? 1,
    discCount: media.length || 1,
    tracks: (medium?.tracks ?? []).map((t) => ({ number: t.position, title: t.title || t.recording?.title || `Track ${t.position}`, artist: credit(t['artist-credit']) || undefined, lengthMs: t.length ?? t.recording?.length, recordingId: t.recording?.id })),
    coverUrl: r['cover-art-archive']?.front === false ? undefined : `https://coverartarchive.org/release/${r.id}/front-500`,
  };
}

/** Releases matching a CD: exact disc id first, then a fuzzy TOC match. */
export async function lookupDisc(toc: CdToc): Promise<{ discId: string; releases: MusicBrainzRelease[] }> {
  const id = discId(toc);
  const inc = 'inc=artist-credits+recordings+release-groups+labels';
  try {
    const r = await mb<{ releases?: MbRelease[] }>(`discid/${encodeURIComponent(id)}?${inc}&toc=${encodeURIComponent(tocString(toc))}`);
    return { discId: id, releases: (r.releases ?? []).map((x) => mapMbRelease(x, id, toc.tracks.length)) };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return { discId: id, releases: [] };
    throw err;
  }
}

/** Search releases by artist / album text (used when a disc has no MusicBrainz entry yet). */
export async function searchReleases(query: string, limit = 8): Promise<MusicBrainzRelease[]> {
  const r = await mb<{ releases?: MbRelease[] }>(`release?query=${encodeURIComponent(query)}&limit=${limit}`);
  return (r.releases ?? []).map((x) => mapMbRelease(x));
}

export async function getRelease(releaseId: string): Promise<MusicBrainzRelease> {
  return mapMbRelease(await mb<MbRelease>(`release/${encodeURIComponent(releaseId)}?inc=artist-credits+recordings+release-groups+labels`));
}

/** Download the front cover (Cover Art Archive redirects to archive.org). */
export async function downloadCover(url: string, file: string): Promise<boolean> {
  try {
    const res = await httpFetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return false;
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}
