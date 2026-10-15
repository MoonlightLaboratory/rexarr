/**
 * RexDB: what somebody else already worked out about this disc.
 *
 * A disc does not say which episodes it holds, so Rexarr guesses - and the guess is wrong whenever a set is not
 * made of equal discs, which is often. RexDB is the shared answer to that: one entry per disc, keyed by a
 * fingerprint of the volume label and the playlist structure, which is known the moment a scan finishes and
 * needs nothing from the person at the keyboard.
 *
 *   https://github.com/MoonlightLaboratory/rexarr/tree/RexDB
 *
 * Reading it is a GET of one JSON file, cached on disk. Nothing is sent anywhere by looking something up.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DiscRip, DiscTitle, RexDbEntry, RexDbIndex, RexDbMatch, TitleRole } from '../../../shared/types.js';
import { httpFetch } from '../net.js';
import { PATHS } from '../config.js';
import { store } from '../store.js';

const CACHE_FILE = () => path.join(PATHS.cache, 'rexdb.json');
/** The index is small and changes when somebody contributes; a day is often enough to be worth nothing. */
const MAX_AGE_MS = 24 * 3600_000;

export function rexdbSettings() {
  return store.settings.rexdb ?? { enabled: true, url: 'https://raw.githubusercontent.com/MoonlightLaboratory/rexarr/RexDB/index.json' };
}

// ---- the fingerprint -----------------------------------------------------------------------------

/** The volume label as it goes into the hash: letters and digits, uppercase, nothing else. */
function normaliseLabel(label: string): string {
  return (label ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * A title's key: the playlist it comes from, or its index where the disc gives none - which is every DVD. It
 * has to match what a contributor's tool produced, so this is the one place the rule lives.
 */
export function titleKey(t: Pick<DiscTitle, 'id' | 'sourceFile'>): string {
  const file = (t.sourceFile ?? '').trim();
  return file ? file.toLowerCase() : String(t.id);
}

/**
 * FINGERPRINT.md, exactly. Two implementations that disagree about this do not share a database, so the payload
 * is spelled out rather than built from whatever happens to be convenient here.
 */
export function fingerprint(label: string, titles: { key: string; seconds: number }[]): string {
  const lines = titles.map((t) => `${t.key.toLowerCase()}=${Math.trunc(t.seconds)}`);
  const payload = ['rexdb1', normaliseLabel(label), ...lines].join('\n');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

/** The structure of a scanned disc, in the shape RexDB stores and hashes. */
export function discStructure(titles: DiscTitle[]): { key: string; seconds: number }[] {
  return titles.map((t) => ({ key: titleKey(t), seconds: Math.trunc(t.durationSeconds) }));
}

export function fingerprintOf(rip: Pick<DiscRip, 'label' | 'volumeName' | 'titles'>): string {
  return fingerprint(rip.volumeName || rip.label, discStructure(rip.titles));
}

// ---- the index -----------------------------------------------------------------------------------

let cached: { at: number; index: RexDbIndex } | null = null;

function readDisk(): { at: number; index: RexDbIndex } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8')) as { at: number; index: RexDbIndex };
    return raw?.index?.discs ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The index, from memory, then disk, then the network. A failed fetch falls back to whatever is on disk however
 * old it is: a stale answer about a disc pressed years ago is worth more than no answer.
 */
export async function rexdbIndex(force = false): Promise<RexDbIndex | null> {
  const s = rexdbSettings();
  if (!s.enabled) return null;
  if (!force && cached && Date.now() - cached.at < MAX_AGE_MS) return cached.index;
  if (!cached) cached = readDisk();
  if (!force && cached && Date.now() - cached.at < MAX_AGE_MS) return cached.index;

  try {
    const res = await httpFetch(s.url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const index = (await res.json()) as RexDbIndex;
    if (!Array.isArray(index?.discs)) throw new Error('not a RexDB index');
    cached = { at: Date.now(), index };
    fs.mkdirSync(path.dirname(CACHE_FILE()), { recursive: true });
    fs.writeFileSync(CACHE_FILE(), JSON.stringify(cached));
    return index;
  } catch (err) {
    if (cached) return cached.index; // stale beats nothing
    throw err;
  }
}

// ---- looking a disc up ---------------------------------------------------------------------------

/** How far apart two readings of the same disc are allowed to be, per title. Drives disagree by a second. */
const SECONDS_SLACK = 2;

function structureLooksLike(entry: RexDbEntry, mine: { key: string; seconds: number }[]): boolean {
  const theirs = entry.structure?.titles;
  if (!theirs || theirs.length !== mine.length) return false;
  return theirs.every((t, i) => Math.abs(t.seconds - mine[i].seconds) <= SECONDS_SLACK);
}

/**
 * What RexDB knows about this disc.
 *
 * An exact fingerprint is the answer. A structure that is merely very close is a suggestion - a drive that
 * reports the label differently, or a duration a second out, produces a different hash for the same disc, and
 * that is worth offering but not worth applying on its own. A disputed entry is never better than a suggestion,
 * whatever matched it.
 */
export async function lookupDisc(rip: Pick<DiscRip, 'label' | 'volumeName' | 'titles'>): Promise<RexDbMatch | null> {
  const index = await rexdbIndex().catch(() => null);
  if (!index) return null;
  const mine = discStructure(rip.titles);
  const fp = fingerprint(rip.volumeName || rip.label, mine);

  const exact = index.discs.find((d) => d.fingerprint === fp);
  if (exact) return { entry: exact, how: 'fingerprint', fingerprint: fp, confident: exact.status === 'verified' };

  // nothing is matched on a label alone: hundreds of discs are called DISC_1 and they are not the same disc
  const near = index.discs.find((d) => d.fingerprint && structureLooksLike(d, mine));
  if (near) return { entry: near, how: 'structure', fingerprint: fp, confident: false };
  return null;
}

// ---- turning an entry into a rip -----------------------------------------------------------------

/** `S02E08`, `S00E12`, `S01E04-E05`, `extra[:kind]`, `playall`, `skip`. */
function parseTitleValue(value: string): { season: number; episodes: number[] } | { role: TitleRole } | null {
  const ep = /^S(\d{1,3})E(\d{1,4})(?:-E(\d{1,4}))?$/.exec(value);
  if (ep) {
    const [from, to] = [Number(ep[2]), ep[3] ? Number(ep[3]) : Number(ep[2])];
    const episodes = [];
    for (let n = from; n <= to; n++) episodes.push(n);
    return { season: Number(ep[1]), episodes };
  }
  if (value === 'playall' || value === 'skip') return { role: { kind: 'extra', type: 'none' } };
  const extra = /^extra(?::(op|ed|trailer|interview|featurette|other))?$/.exec(value);
  if (extra) {
    const kind = extra[1];
    return { role: { kind: 'extra', type: kind === 'op' || kind === 'ed' ? kind : 'extra' } };
  }
  return null;
}

export interface AppliedMapping {
  episodeMap: Record<number, number>;
  titleRoles: Record<string, TitleRole>;
  seasonNumber?: number;
  episodeStart?: number;
  /** Titles RexDB says to leave out: the play-all compilation, and anything marked skip. */
  skip: number[];
  /** What was read, for the log. */
  summary: string;
}

/**
 * The entry as changes to a rip. Titles RexDB does not mention are left exactly as they were, so an entry that
 * only knows about half a disc does not quietly blank the rest.
 */
export function applyEntry(entry: RexDbEntry, titles: DiscTitle[]): AppliedMapping {
  const byKey = new Map(titles.map((t) => [titleKey(t), t]));
  const episodeMap: Record<number, number> = {};
  const titleRoles: Record<string, TitleRole> = {};
  const skip: number[] = [];
  let seasonNumber: number | undefined;
  const seasons = new Set<number>();

  for (const [key, value] of Object.entries(entry.titles ?? {})) {
    const title = byKey.get(key.toLowerCase()) ?? byKey.get(key);
    if (!title) continue;
    const parsed = parseTitleValue(String(value));
    if (!parsed) continue;
    if ('role' in parsed) {
      if (value === 'playall' || value === 'skip') skip.push(title.id);
      else titleRoles[String(title.id)] = parsed.role;
      continue;
    }
    seasons.add(parsed.season);
    if (parsed.season === 0) titleRoles[String(title.id)] = { kind: 'special', episode: parsed.episodes[0] };
    else {
      episodeMap[title.id] = parsed.episodes[0];
      titleRoles[String(title.id)] = { kind: 'episode' };
      seasonNumber = parsed.season;
    }
  }

  const numbers = Object.values(episodeMap);
  const episodeStart = numbers.length ? Math.min(...numbers) : undefined;
  const specials = Object.values(titleRoles).filter((r) => r.kind === 'special').length;
  const summary = [
    numbers.length ? `episodes ${Math.min(...numbers)}-${Math.max(...numbers)}` : 'no episodes',
    specials ? `${specials} special${specials > 1 ? 's' : ''}` : '',
    skip.length ? `${skip.length} title(s) left out` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return { episodeMap, titleRoles, seasonNumber, episodeStart, skip, summary };
}
