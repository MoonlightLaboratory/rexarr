import type { ArrConnection, LookupResult, MediaFile, Movie, Release } from '../../../shared/types.js';
import { ArrHttp, type ArrQueueRecord } from './client.js';
import { detectDisc, isRemux, isRemuxQuality, resolutionFromQuality } from './remux.js';
import { toLocalPath } from '../paths.js';
import { proxiedImage } from '../routes/images.js';

// Minimal Radarr v3 API shapes used by rexarr.
interface RQuality { quality: { id: number; name: string; resolution?: number } }
interface RMovieFile {
  id: number;
  movieId: number;
  path: string;
  relativePath: string;
  size: number;
  quality: RQuality;
  languages?: { id: number; name: string }[];
  mediaInfo?: { videoCodec?: string; audioCodec?: string; audioChannels?: number; resolution?: string; audioLanguages?: string; subtitles?: string };
}
interface RMovie {
  alternateTitles?: { title: string }[];
  id: number;
  tmdbId: number;
  title: string;
  year: number;
  overview?: string;
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
  monitored: boolean;
  hasFile: boolean;
  movieFile?: RMovieFile;
  path: string;
  runtime: number;
  genres?: string[];
  qualityProfileId?: number;
  rootFolderPath?: string;
  status?: string;
  ratings?: { tmdb?: { value?: number }; imdb?: { value?: number } };
  originalLanguage?: { id: number; name: string };
  studio?: string;
  certification?: string;
  imdbId?: string;
}
interface RRelease {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  quality: RQuality;
  seeders?: number;
  leechers?: number;
  protocol: string;
  age?: number;
  languages?: { id: number; name: string }[];
  approved: boolean;
  rejected: boolean;
  rejections?: string[];
  movieId?: number;
}

/** Cover art goes through Rexarr's own image cache (Radarr's resized copy first, TMDB as fallback). */
function poster(images?: RMovie['images'], type: 'poster' | 'fanart' = 'poster') {
  return proxiedImage('radarr', images?.find((i) => i.coverType === type), type);
}

function mapFile(f: RMovieFile): MediaFile {
  return {
    id: f.id,
    path: f.path,
    localPath: toLocalPath(f.path, 'radarr'),
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

export function mapMovie(m: RMovie, profiles?: Map<number, string>): Movie {
  const tmdb = m.ratings?.tmdb?.value;
  const imdb = m.ratings?.imdb?.value;
  return {
    id: m.id,
    tmdbId: m.tmdbId,
    title: m.title,
    alternateTitles: m.alternateTitles?.length ? [...new Set(m.alternateTitles.map((a) => a.title))].slice(0, 20) : undefined,
    year: m.year,
    overview: m.overview ?? '',
    poster: poster(m.images),
    fanart: poster(m.images, 'fanart'),
    monitored: m.monitored,
    hasFile: m.hasFile,
    file: m.movieFile ? mapFile(m.movieFile) : undefined,
    path: m.path,
    runtime: m.runtime,
    genres: m.genres ?? [],
    status: m.status,
    rating: tmdb ? Math.round(tmdb * 10) : imdb ? Math.round(imdb * 10) : undefined,
    qualityProfile: m.qualityProfileId !== undefined ? profiles?.get(m.qualityProfileId) : undefined,
    originalLanguage: m.originalLanguage?.name,
    studio: m.studio,
    certification: m.certification,
    imdbId: m.imdbId,
  };
}

export function mapRadarrRelease(r: RRelease): Release {
  const q = r.quality?.quality?.name ?? '';
  const res = r.quality?.quality?.resolution ?? resolutionFromQuality(q);
  const disc = detectDisc(r.title, q, res);
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
    source: 'radarr',
  };
}

export class Radarr {
  http: ArrHttp;
  constructor(conn: ArrConnection) {
    this.http = new ArrHttp(conn, '/api/v3', 'Radarr');
  }
  get configured() {
    return this.http.configured;
  }

  status() {
    return this.http.get<{ version: string; appName: string }>('/system/status', undefined, 10_000);
  }

  async movies(): Promise<Movie[]> {
    const list = await this.http.get<RMovie[]>('/movie');
    return list.map((m) => mapMovie(m)).sort((a, b) => a.title.localeCompare(b.title));
  }

  async movie(id: number): Promise<Movie> {
    const [m, profiles] = await Promise.all([this.http.get<RMovie>(`/movie/${id}`), this.profileNames()]);
    return mapMovie(m, profiles);
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

  async movieFiles(movieId: number): Promise<MediaFile[]> {
    const files = await this.http.get<RMovieFile[]>('/moviefile', { movieId });
    return files.map(mapFile);
  }

  async lookup(term: string): Promise<LookupResult[]> {
    const list = await this.http.get<RMovie[]>('/movie/lookup', { term });
    return list.map((m) => ({
      kind: 'movie',
      arrId: m.id || undefined,
      externalId: m.tmdbId,
      title: m.title,
      year: m.year,
      overview: m.overview ?? '',
      poster: poster(m.images),
      inLibrary: Boolean(m.id),
    }));
  }

  async qualityProfiles() {
    return this.http.get<{ id: number; name: string }[]>('/qualityprofile');
  }
  async rootFolders() {
    return this.http.get<{ id: number; path: string; freeSpace?: number }[]>('/rootfolder');
  }

  /** Add a movie by TMDB id (monitored, no automatic search – Rexarr searches explicitly). */
  async add(tmdbId: number, qualityProfileId?: number, rootFolderPath?: string): Promise<Movie> {
    const [lookup] = await this.http.get<RMovie[]>('/movie/lookup', { term: `tmdb:${tmdbId}` });
    if (!lookup) throw new Error(`TMDB id ${tmdbId} not found`);
    const profiles = await this.qualityProfiles();
    const roots = await this.rootFolders();
    const body = {
      ...lookup,
      qualityProfileId: qualityProfileId ?? profiles[0]?.id,
      rootFolderPath: rootFolderPath ?? roots[0]?.path,
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { searchForMovie: false, monitor: 'movieOnly' },
    };
    return mapMovie(await this.http.post<RMovie>('/movie', body));
  }

  /** Interactive search – Radarr queries every indexer; this can take a while. */
  async releases(movieId: number): Promise<Release[]> {
    const list = await this.http.get<RRelease[]>('/release', { movieId }, 180_000);
    return list.map(mapRadarrRelease);
  }

  grab(guid: string, indexerId: number) {
    return this.http.post('/release', { guid, indexerId });
  }

  queue() {
    return this.http.get<{ records: ArrQueueRecord[] }>('/queue', { includeMovie: false, pageSize: 500 });
  }

  /** Drop a finished download from the queue (the download client keeps the files / keeps seeding). */
  removeFromQueue(id: number) {
    return this.http.delete<void>(`/queue/${id}`, { removeFromClient: false, blocklist: false });
  }

  rescan(movieId: number) {
    return this.http.post('/command', { name: 'RescanMovie', movieId });
  }
  refresh(movieId: number) {
    return this.http.post('/command', { name: 'RefreshMovie', movieIds: [movieId] });
  }
}
