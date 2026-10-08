/**
 * The ripping to-do list (Settings → Experiments).
 *
 * Radarr and Sonarr already keep a list of what they would like to improve - their "Cutoff Unmet" pages. Most of
 * those entries are waiting for a download that may never come, while the better copy is sitting on a shelf in
 * the next room. This turns that list around: what is still low quality, what kind of disc would actually improve
 * it, and whether you have already scanned that disc's barcode.
 */
import type { WantedDisc } from '../../shared/types.js';
import { arr } from './arr/index.js';
import { store } from './store.js';
import { nameScore } from './disc/identify.js';

/** What a rip would have to come from to be worth doing, given what is on disk now. */
export function upgradeFrom(quality?: string): { with: 'bluray' | 'uhd' | 'none'; from: string } {
  const q = (quality ?? '').toLowerCase();
  const from = quality || 'nothing on disk';
  if (!q) return { with: 'bluray', from };
  const remux = q.includes('remux');
  if (q.includes('2160') || q.includes('4k') || q.includes('uhd')) return { with: remux ? 'none' : 'uhd', from };
  if (remux) return { with: 'uhd', from };                       // a 1080p remux is already what a Blu-ray holds
  if (q.includes('1080')) return { with: 'bluray', from };        // an encode or a web rip: a remux beats it
  return { with: 'bluray', from };                                // 720p, DVD, SDTV, VHS, anything else
}

/** Episodes come one per row; a shelf holds seasons. */
export function groupEpisodes(
  episodes: { seriesId: number; seriesTitle: string; tvdbId?: number; seasonNumber: number; episodeNumber: number; quality?: string; sizeBytes?: number }[],
): WantedDisc[] {
  const bySeason = new Map<string, WantedDisc & { qualities: Set<string> }>();
  for (const e of episodes) {
    const key = `${e.seriesId}:${e.seasonNumber}`;
    let row = bySeason.get(key);
    if (!row) {
      row = {
        kind: 'series',
        arrId: e.seriesId,
        externalId: e.tvdbId,
        title: e.seriesTitle,
        seasonNumber: e.seasonNumber,
        episodes: 0,
        quality: e.quality ?? 'unknown',
        upgradeWith: upgradeFrom(e.quality).with,
        onShelf: false,
        qualities: new Set<string>(),
      };
      bySeason.set(key, row);
    }
    row.episodes = (row.episodes ?? 0) + 1;
    row.qualities.add(e.quality ?? 'unknown');
    // the season is only as good as its worst episode
    if (upgradeRank(e.quality) < upgradeRank(row.quality)) {
      row.quality = e.quality ?? 'unknown';
      row.upgradeWith = upgradeFrom(e.quality).with;
    }
  }
  return [...bySeason.values()].map(({ qualities, ...row }) => ({ ...row, quality: qualities.size > 1 ? `${row.quality} and others` : row.quality }));
}

/** Lower is worse, so the worst episode of a season wins. */
function upgradeRank(quality?: string): number {
  const q = (quality ?? '').toLowerCase();
  if (!q) return 0;
  if (q.includes('remux') && (q.includes('2160') || q.includes('4k'))) return 6;
  if (q.includes('2160') || q.includes('4k') || q.includes('uhd')) return 5;
  if (q.includes('remux')) return 4;
  if (q.includes('1080')) return 3;
  if (q.includes('720')) return 2;
  return 1;
}

/** Everything Radarr and Sonarr would like a better copy of, worst first, with what a disc would do for it. */
export async function wantedDiscs(): Promise<WantedDisc[]> {
  const { radarr, sonarr } = arr();
  const [movies, episodes] = await Promise.all([
    radarr.configured ? radarr.cutoffUnmet().catch(() => []) : Promise.resolve([]),
    sonarr.configured ? sonarr.cutoffUnmet().catch(() => []) : Promise.resolve([]),
  ]);
  const rows: WantedDisc[] = [
    ...movies.map((m) => ({
      kind: 'movie' as const,
      arrId: m.id,
      externalId: m.tmdbId,
      title: m.title,
      year: m.year,
      quality: m.quality ?? 'unknown',
      upgradeWith: upgradeFrom(m.quality).with,
      onShelf: false,
    })),
    ...groupEpisodes(episodes),
  ].filter((r) => r.upgradeWith !== 'none');
  // a barcode scan says the disc is already in the house
  const expected = store.expectedDiscs;
  for (const row of rows) {
    row.onShelf = expected.some((e) => (e.arrId && e.arrId === row.arrId) || nameScore(e.title, row.title) > 0);
  }
  return rows.sort((a, b) => Number(b.onShelf) - Number(a.onShelf) || upgradeRank(a.quality) - upgradeRank(b.quality) || a.title.localeCompare(b.title));
}
