import type { ArrConnection, Episode, LookupResult, MediaFile, Release, Series } from '../../../shared/types.js';
import { ArrHttp, type ArrQueueRecord } from './client.js';
import { detectDisc, isRemux, isRemuxQuality, resolutionFromQuality } from './remux.js';
import { toLocalPath } from '../paths.js';
import { proxiedImage } from '../routes/images.js';

interface SQuality { quality: { id: number; name: string; resolution?: number } }
interface SEpisodeFile {
  id: number;
  seriesId: number;
  seasonNumber: number;
  path: string;
  relativePath: string;
  size: number;
  quality: SQuality;
  languages?: { id: number; name: string }[];
  mediaInfo?: { videoCodec?: string; audioCodec?: string; audioChannels?: number; resolution?: string };
}
interface SEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDate?: string;
  hasFile: boolean;
  monitored: boolean;
  episodeFileId: number;
  episodeFile?: SEpisodeFile;
}
interface SSeries {
  alternateTitles?: { title: string; seasonNumber?: number }[];
  id: number;
  tvdbId: number;
  title: string;
  year: number;
  overview?: string;
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
  monitored: boolean;
  seriesType: 'standard' | 'anime' | 'daily';
  path: string;
  genres?: string[];
  status?: string;
  network?: string;
  runtime?: number;
  ratings?: { votes?: number; value?: number };
  firstAired?: string;
  lastAired?: string;
  originalLanguage?: { id: number; name: string };
  qualityProfileId?: number;
  certification?: string;
  imdbId?: string;
  seasons: { seasonNumber: number; monitored: boolean; statistics?: { episodeFileCount: number; episodeCount: number; totalEpisodeCount: number } }[];
  statistics?: { episodeFileCount: number; episodeCount: number; sizeOnDisk: number };
}
interface SRelease {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  quality: SQuality;
  seeders?: number;
  leechers?: number;
  protocol: string;
  age?: number;
  languages?: { id: number; name: string }[];
  approved: boolean;
  rejected: boolean;
  rejections?: string[];
  fullSeason?: boolean;
  seasonNumber?: number;
  episodeIds?: number[];
  mappedEpisodeInfo?: { id: number }[];
}

const REMUX_CACHE_MS = 60_000;
/** url -> seriesId -> per-season remux counts (Sonarr has no bulk episode-file endpoint). */
const remuxCache = new Map<string, Map<number, { at: number; bySeason: Map<number, number> }>>();

/** Cover art goes through Rexarr's own image cache (Sonarr's resized copy first, TheTVDB as fallback). */
function poster(images?: SSeries['images'], type: 'poster' | 'fanart' = 'poster') {
  return proxiedImage('sonarr', images?.find((i) => i.coverType === type), type);
}

function mapFile(f: SEpisodeFile): MediaFile {
  return {
    id: f.id,
    path: f.path,
    localPath: toLocalPath(f.path, 'sonarr'),
    size: f.size,
    quality: f.quality?.quality?.name ?? 'Unknown',
    isRemux: isRemuxQuality(f.quality?.quality?.name) || isRemux(f.relativePath),
    videoCodec: f.mediaInfo?.videoCodec,
    audioCodec: f.mediaInfo?.audioCodec,
    audioChannels: f.mediaInfo?.audioChannels,
    resolution: f.mediaInfo?.resolution,
    languages: f.languages?.map((l) => l.name),
  };
}

export function mapSonarrRelease(r: SRelease): Release {
  const q = r.quality?.quality?.name ?? '';
  const disc = detectDisc(r.title, q, r.quality?.quality?.resolution ?? resolutionFromQuality(q));
  return {
    isDisc: disc.isDisc,
    discFormat: disc.format,
    guid: r.guid,
    indexerId: r.indexerId,
    indexer: r.indexer,
    title: r.title,
    size: r.size,
    quality: q,
    resolution: r.quality?.quality?.resolution ?? resolutionFromQuality(q),
    isRemux: isRemux(r.title, q),
    seeders: r.seeders ?? null,
    leechers: r.leechers ?? null,
    protocol: r.protocol,
    ageDays: r.age ?? 0,
    languages: r.languages?.map((l) => l.name) ?? [],
    approved: r.approved && !r.rejected,
    rejections: r.rejections ?? [],
    source: 'sonarr',
    fullSeason: r.fullSeason,
    episodeIds: r.episodeIds ?? r.mappedEpisodeInfo?.map((e) => e.id),
  };
}

export class Sonarr {
  http: ArrHttp;
  constructor(conn: ArrConnection) {
    this.http = new ArrHttp(conn, '/api/v3', 'Sonarr');
  }
  get configured() {
    return this.http.configured;
  }

  status() {
    return this.http.get<{ version: string; appName: string }>('/system/status', undefined, 10_000);
  }

  private mapSeries(s: SSeries, remuxBySeason: Map<number, number> = new Map(), profiles?: Map<number, string>): Series {
    const endYear = s.status === 'ended' && s.lastAired ? new Date(s.lastAired).getFullYear() : undefined;
    return {
      id: s.id,
      tvdbId: s.tvdbId,
      title: s.title,
      alternateTitles: s.alternateTitles?.length ? [...new Set(s.alternateTitles.map((a) => a.title))].slice(0, 20) : undefined,
      seasonTitles: s.alternateTitles?.filter((a) => (a.seasonNumber ?? -1) > 0).map((a) => ({ title: a.title, seasonNumber: a.seasonNumber! })),
      year: s.year,
      overview: s.overview ?? '',
      poster: poster(s.images),
      fanart: poster(s.images, 'fanart'),
      monitored: s.monitored,
      seriesType: s.seriesType,
      path: s.path,
      genres: s.genres ?? [],
      status: s.status,
      network: s.network,
      runtime: s.runtime,
      rating: s.ratings?.value ? Math.round(s.ratings.value * 10) : undefined,
      endYear,
      qualityProfile: s.qualityProfileId !== undefined ? profiles?.get(s.qualityProfileId) : undefined,
      originalLanguage: s.originalLanguage?.name,
      certification: s.certification,
      imdbId: s.imdbId,
      seasons: s.seasons.map((se) => ({
        seasonNumber: se.seasonNumber,
        monitored: se.monitored,
        episodeCount: se.statistics?.episodeCount ?? 0,
        episodeFileCount: se.statistics?.episodeFileCount ?? 0,
        remuxCount: remuxBySeason.get(se.seasonNumber) ?? 0,
      })),
      statistics: {
        episodeFileCount: s.statistics?.episodeFileCount ?? 0,
        episodeCount: s.statistics?.episodeCount ?? 0,
        sizeOnDisk: s.statistics?.sizeOnDisk ?? 0,
        remuxFileCount: [...remuxBySeason.values()].reduce((a, b) => a + b, 0),
      },
    };
  }

  /**
   * Full library. Sonarr has no bulk episode-file endpoint, so remux counts require one
   * /episodefile call per series; they run in a small pool and are cached briefly.
   */
  async series(): Promise<Series[]> {
    const list = await this.http.get<SSeries[]>('/series');
    const counts = await this.remuxCounts(list.filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0).map((s) => s.id));
    return list.map((s) => this.mapSeries(s, counts.get(s.id))).sort((a, b) => a.title.localeCompare(b.title));
  }

  private async remuxCounts(ids: number[]): Promise<Map<number, Map<number, number>>> {
    const key = this.http.conn.url;
    const cached = remuxCache.get(key);
    const out = new Map<number, Map<number, number>>();
    const now = Date.now();
    const todo: number[] = [];
    for (const id of ids) {
      const hit = cached?.get(id);
      if (hit && now - hit.at < REMUX_CACHE_MS) out.set(id, hit.bySeason);
      else todo.push(id);
    }
    const store = cached ?? new Map<number, { at: number; bySeason: Map<number, number> }>();
    remuxCache.set(key, store);
    let cursor = 0;
    const worker = async () => {
      while (cursor < todo.length) {
        const id = todo[cursor++];
        try {
          const bySeason = await this.remuxBySeason(id);
          out.set(id, bySeason);
          store.set(id, { at: Date.now(), bySeason });
        } catch {
          /* leave count unknown for this series */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
    return out;
  }

  private async remuxBySeason(seriesId: number): Promise<Map<number, number>> {
    const files = await this.episodeFiles(seriesId);
    const bySeason = new Map<number, number>();
    for (const f of files) if (f.isRemux) bySeason.set(f.seasonNumber, (bySeason.get(f.seasonNumber) ?? 0) + 1);
    return bySeason;
  }

  private profileCache: { at: number; map: Map<number, string> } | null = null;
  private async profileNames(): Promise<Map<number, string>> {
    if (this.profileCache && Date.now() - this.profileCache.at < 5 * 60_000) return this.profileCache.map;
    try {
      const map = new Map((await this.qualityProfiles()).map((p) => [p.id, p.name]));
      this.profileCache = { at: Date.now(), map };
      return map;
    } catch {
      return new Map();
    }
  }

  async seriesById(id: number): Promise<Series> {
    const [s, bySeason, profiles] = await Promise.all([this.http.get<SSeries>(`/series/${id}`), this.remuxBySeason(id), this.profileNames()]);
    const key = this.http.conn.url;
    if (!remuxCache.has(key)) remuxCache.set(key, new Map());
    remuxCache.get(key)!.set(id, { at: Date.now(), bySeason });
    return this.mapSeries(s, bySeason, profiles);
  }

  async episodeFiles(seriesId: number): Promise<(MediaFile & { seasonNumber: number })[]> {
    const files = await this.http.get<SEpisodeFile[]>('/episodefile', { seriesId });
    return files.map((f) => ({ ...mapFile(f), seasonNumber: f.seasonNumber }));
  }

  async episodes(seriesId: number, seasonNumber?: number): Promise<Episode[]> {
    const [eps, files] = await Promise.all([
      this.http.get<SEpisode[]>('/episode', { seriesId, seasonNumber, includeEpisodeFile: true }),
      this.episodeFiles(seriesId),
    ]);
    const byId = new Map(files.map((f) => [f.id, f]));
    return eps
      .map((e) => ({
        id: e.id,
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
        title: e.title,
        airDate: e.airDate,
        hasFile: e.hasFile,
        monitored: e.monitored,
        file: e.episodeFileId ? byId.get(e.episodeFileId) ?? (e.episodeFile ? mapFile(e.episodeFile) : undefined) : undefined,
      }))
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  }

  async episode(id: number) {
    const e = await this.http.get<SEpisode>(`/episode/${id}`);
    return { ...e, file: e.episodeFile ? mapFile(e.episodeFile) : undefined };
  }

  async lookup(term: string): Promise<LookupResult[]> {
    const list = await this.http.get<SSeries[]>('/series/lookup', { term });
    return list.map((s) => ({
      kind: 'series',
      arrId: s.id || undefined,
      externalId: s.tvdbId,
      title: s.title,
      year: s.year,
      overview: s.overview ?? '',
      poster: poster(s.images),
      inLibrary: Boolean(s.id),
      seriesType: s.seriesType,
    }));
  }

  async qualityProfiles() {
    return this.http.get<{ id: number; name: string }[]>('/qualityprofile');
  }
  async rootFolders() {
    return this.http.get<{ id: number; path: string }[]>('/rootfolder');
  }

  async add(tvdbId: number, seriesType: 'standard' | 'anime' | 'daily' = 'standard', qualityProfileId?: number, rootFolderPath?: string): Promise<Series> {
    const [lookup] = await this.http.get<SSeries[]>('/series/lookup', { term: `tvdb:${tvdbId}` });
    if (!lookup) throw new Error(`TVDB id ${tvdbId} not found`);
    const profiles = await this.qualityProfiles();
    const roots = await this.rootFolders();
    const body = {
      ...lookup,
      seriesType,
      qualityProfileId: qualityProfileId ?? profiles[0]?.id,
      rootFolderPath: rootFolderPath ?? roots[0]?.path,
      monitored: true,
      seasonFolder: true,
      addOptions: { searchForMissingEpisodes: false, monitor: 'all' },
    };
    return this.mapSeries(await this.http.post<SSeries>('/series', body));
  }

  /** Interactive search for a season pack or a single episode. */
  async releases(opts: { seriesId: number; seasonNumber: number } | { episodeId: number }): Promise<Release[]> {
    const list = await this.http.get<SRelease[]>('/release', opts, 180_000);
    return list.map(mapSonarrRelease);
  }

  grab(guid: string, indexerId: number) {
    return this.http.post('/release', { guid, indexerId });
  }

  queue() {
    return this.http.get<{ records: ArrQueueRecord[] }>('/queue', { includeSeries: false, includeEpisode: false, pageSize: 500 });
  }

  /** Drop a finished download from the queue (the download client keeps the files / keeps seeding). */
  removeFromQueue(id: number) {
    return this.http.delete<void>(`/queue/${id}`, { removeFromClient: false, blocklist: false });
  }

  rescan(seriesId: number) {
    return this.http.post('/command', { name: 'RescanSeries', seriesId });
  }
  refresh(seriesId: number) {
    return this.http.post('/command', { name: 'RefreshSeries', seriesId });
  }
}
