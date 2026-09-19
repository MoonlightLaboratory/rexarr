/**
 * Where to add a show or movie that is not in Sonarr / Radarr yet. Unless Settings name a root folder and profile,
 * Rexarr follows the library: the root folder and quality profile most used by titles of the same kind (anime or
 * not). Folders that are clearly not libraries – downloads, temp, the rip folder – are never picked.
 */

export interface LibraryEntry {
  path: string;
  /** Sonarr's series type says anime (Radarr has none). */
  animeType?: boolean;
  profileId?: number;
}

export interface AddTarget {
  rootFolderPath: string;
  qualityProfileId: number;
  /** How it was chosen, for the log. */
  why: string;
}

const NOT_A_LIBRARY = /download|temp|tmp|incomplete|rips?\b/i;

function under(root: string, p: string) {
  const r = root.replace(/[\\/]+$/, '');
  return p === r || p.startsWith(`${r}/`) || p.startsWith(`${r}\\`);
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function pickAddTarget(opts: {
  anime: boolean;
  roots: string[];
  profiles: { id: number; name: string }[];
  library: LibraryEntry[];
  /** Folders to never add into (e.g. the rip folder as the *arr app sees it). */
  exclude?: string[];
  /** Settings overrides; empty = automatic. */
  root?: string;
  profileId?: number;
}): AddTarget | null {
  const usable = opts.roots.filter((r) => !NOT_A_LIBRARY.test(r) && !(opts.exclude ?? []).some((x) => x && (under(r, x) || under(x, r))));
  const candidates = usable.length ? usable : opts.roots;
  if (!candidates.length || !opts.profiles.length) return null;

  // Libraries split into "Anime" and "TV" folders say what is anime better than Sonarr's series type, which many
  // anime keep at "standard"; without such folders the series type is all there is.
  const byFolder = opts.roots.some((r) => /anime/i.test(r)) && opts.roots.some((r) => !/anime/i.test(r) && !NOT_A_LIBRARY.test(r));
  const isAnime = (e: LibraryEntry) => (byFolder ? /anime/i.test(opts.roots.find((r) => under(r, e.path)) ?? e.path) : Boolean(e.animeType));
  const same = opts.library.filter((e) => isAnime(e) === opts.anime);
  let root = opts.root && opts.roots.includes(opts.root) ? opts.root : undefined;
  let why = root ? 'set in Settings' : '';
  if (!root) {
    // the folder most shows / movies of this kind already live in
    root = mostCommon(same.map((e) => candidates.find((r) => under(r, e.path))).filter((r): r is string => Boolean(r)));
    if (root) why = `like your other ${opts.anime ? 'anime' : 'titles'}`;
  }
  if (!root) {
    // nothing of this kind yet: go by the folder name
    root = candidates.find((r) => /anime/i.test(r) === opts.anime) ?? candidates[0];
    why = 'by folder name';
  }

  let profile = opts.profileId ? opts.profiles.find((p) => p.id === opts.profileId) : undefined;
  if (!profile) {
    const ids = (list: LibraryEntry[]) => list.map((e) => e.profileId).filter((id): id is number => id !== undefined);
    const id = mostCommon(ids(same.filter((e) => under(root!, e.path)))) ?? mostCommon(ids(same)) ?? mostCommon(ids(opts.library));
    profile = opts.profiles.find((p) => p.id === id) ?? opts.profiles.find((p) => p.name.toLowerCase() !== 'any') ?? opts.profiles[0];
  }
  return { rootFolderPath: root, qualityProfileId: profile.id, why };
}
