/**
 * Lidarr (API v1): artists, albums, tracks and track files, interactive release search and imports.
 */
import type { Album, Artist, ArrConnection, LookupResult, MusicFile, Release, Track } from '../../../shared/types.js';
import { ArrHttp, type ArrQueueRecord } from './client.js';
import { proxiedImage } from '../routes/images.js';
import { toLocalPath } from '../paths.js';
import { musicFormatFromText } from '../music/format.js';

type Img = { coverType: string; url?: string; remoteUrl?: string };

interface LArtist {
  id: number;
  artistName: string;
  sortName?: string;
  foreignArtistId: string;
  overview?: string;
  images?: Img[];
  path: string;
  genres?: string[];
  status?: string;
  monitored: boolean;
  qualityProfileId?: number;
  ratings?: { value?: number };
  links?: { name: string; url: string }[];
  statistics?: { albumCount?: number; trackCount?: number; trackFileCount?: number; totalTrackCount?: number; sizeOnDisk?: number };
}

interface LAlbum {
  id: number;
  artistId: number;
  artist?: { artistName: string };
  foreignAlbumId: string;
  title: string;
  overview?: string;
  releaseDate?: string;
  albumType?: string;
  secondaryTypes?: string[];
  genres?: string[];
  images?: Img[];
  monitored: boolean;
  ratings?: { value?: number };
  mediumCount?: number;
  statistics?: { trackCount?: number; trackFileCount?: number; totalTrackCount?: number; sizeOnDisk?: number };
  remoteCover?: string;
}

interface LTrack {
  id: number;
  albumId: number;
  trackNumber: string;
  absoluteTrackNumber: number;
  mediumNumber: number;
  title: string;
  duration: number;
  explicit?: boolean;
  hasFile: boolean;
  trackFileId: number;
}

interface LTrackFile {
  id: number;
  albumId: number;
  path: string;
  size: number;
  quality?: { quality?: { name?: string } };
  mediaInfo?: { audioBitrate?: string | number; audioBits?: number; audioChannels?: number; audioCodec?: string; audioSampleRate?: string | number };
}

interface LRelease {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  quality?: { quality?: { name?: string } };
  seeders?: number;
  leechers?: number;
  protocol: string;
  age?: number;
  approved: boolean;
  rejected?: boolean;
  rejections?: string[];
  albumTitle?: string;
  artistName?: string;
  discography?: boolean;
  mappedAlbumInfo?: { id: number }[];
}

const img = (images: Img[] | undefined, type: string, size: 'poster' | 'fanart' = 'poster') => proxiedImage('lidarr', images?.find((i) => i.coverType === type), size);

const num = (v: string | number | undefined) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function mapTrackFile(f: LTrackFile): MusicFile {
  const quality = f.quality?.quality?.name ?? 'Unknown';
  const codec = f.mediaInfo?.audioCodec;
  // Lidarr reports sample rates in kHz strings ("44.1") or Hz numbers depending on version
  let sampleRate = num(f.mediaInfo?.audioSampleRate);
  if (sampleRate && sampleRate < 1000) sampleRate = Math.round(sampleRate * 1000);
  return {
    id: f.id,
    path: f.path,
    localPath: toLocalPath(f.path, 'lidarr'),
    size: f.size,
    quality,
    codec,
    bitDepth: f.mediaInfo?.audioBits || undefined,
    sampleRate,
    bitrate: num(f.mediaInfo?.audioBitrate),
    channels: f.mediaInfo?.audioChannels,
    lossless: /flac|alac|wav|aiff|ape|wavpack|pcm|lossless/i.test(`${quality} ${codec ?? ''}`),
  };
}

export function mapArtist(a: LArtist): Artist {
  return {
    id: a.id,
    foreignArtistId: a.foreignArtistId,
    name: a.artistName,
    sortName: a.sortName,
    overview: a.overview ?? '',
    poster: img(a.images, 'poster') ?? img(a.images, 'banner'),
    fanart: img(a.images, 'fanart', 'fanart'),
    path: a.path,
    genres: a.genres ?? [],
    status: a.status,
    monitored: a.monitored,
    rating: a.ratings?.value ? Math.round(a.ratings.value * 10) : undefined,
    links: a.links,
    statistics: {
      albumCount: a.statistics?.albumCount ?? 0,
      trackCount: a.statistics?.totalTrackCount ?? a.statistics?.trackCount ?? 0,
      trackFileCount: a.statistics?.trackFileCount ?? 0,
      sizeOnDisk: a.statistics?.sizeOnDisk ?? 0,
    },
  };
}

export function mapAlbum(a: LAlbum): Album {
  const year = a.releaseDate ? new Date(a.releaseDate).getFullYear() : undefined;
  return {
    id: a.id,
    artistId: a.artistId,
    artist: a.artist?.artistName,
    foreignAlbumId: a.foreignAlbumId,
    title: a.title,
    overview: a.overview,
    releaseDate: a.releaseDate,
    year: year && year > 1800 ? year : undefined,
    albumType: a.albumType ?? 'Album',
    secondaryTypes: a.secondaryTypes,
    genres: a.genres,
    cover: img(a.images, 'cover') ?? (a.remoteCover ? proxiedImage('lidarr', { remoteUrl: a.remoteCover }, 'poster') : undefined),
    monitored: a.monitored,
    rating: a.ratings?.value ? Math.round(a.ratings.value * 10) : undefined,
    mediumCount: a.mediumCount,
    statistics: {
      trackCount: a.statistics?.totalTrackCount ?? a.statistics?.trackCount ?? 0,
      trackFileCount: a.statistics?.trackFileCount ?? 0,
      sizeOnDisk: a.statistics?.sizeOnDisk ?? 0,
    },
  };
}

/** Release names for single-file album images: "FLAC+CUE", "image+cue", "(img+cue)", "[CUE]". */
export const isCueTitle = (t: string) => /(^|[^a-z])(cue|img\s*\+\s*cue|image\s*\+\s*cue)([^a-z]|$)/i.test(t);

export function mapLidarrRelease(r: LRelease): Release {
  const quality = r.quality?.quality?.name ?? '';
  const fmt = musicFormatFromText(`${quality} ${r.title}`);
  return {
    guid: r.guid,
    indexerId: r.indexerId,
    indexer: r.indexer,
    title: r.title,
    size: r.size,
    quality: quality || fmt.format || 'Unknown',
    resolution: 0,
    isRemux: false,
    seeders: r.seeders ?? null,
    leechers: r.leechers ?? null,
    protocol: r.protocol,
    ageDays: r.age ?? 0,
    languages: [],
    approved: r.approved && !r.rejected,
    rejections: r.rejections ?? [],
    source: 'lidarr',
    fullSeason: r.discography,
    music: { format: fmt.format, bitDepth: fmt.bitDepth, sampleRate: fmt.sampleRate, bitrate: fmt.bitrate, cue: isCueTitle(r.title) || undefined },
    albumIds: r.mappedAlbumInfo?.map((a) => a.id),
  };
}

export class Lidarr {
  http: ArrHttp;
  constructor(conn: ArrConnection) {
    this.http = new ArrHttp(conn, '/api/v1', 'Lidarr');
  }
  get configured() {
    return this.http.configured;
  }

  status() {
    return this.http.get<{ version: string; appName: string }>('/system/status', undefined, 10_000);
  }

  async artists(): Promise<Artist[]> {
    const list = await this.http.get<LArtist[]>('/artist');
    return list.map(mapArtist).sort((a, b) => (a.sortName ?? a.name).localeCompare(b.sortName ?? b.name));
  }

  async artist(id: number): Promise<Artist> {
    return mapArtist(await this.http.get<LArtist>(`/artist/${id}`));
  }

  async albums(artistId?: number): Promise<Album[]> {
    const list = await this.http.get<LAlbum[]>('/album', artistId ? { artistId } : undefined, 60_000);
    return list.map(mapAlbum).sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
  }

  async album(id: number): Promise<Album> {
    return mapAlbum(await this.http.get<LAlbum>(`/album/${id}`));
  }

  /** Tracks of an album with their files (quality, bit depth, sample rate). */
  async tracks(albumId: number): Promise<Track[]> {
    const [tracks, files] = await Promise.all([this.http.get<LTrack[]>('/track', { albumId }), this.http.get<LTrackFile[]>('/trackfile', { albumId })]);
    const byId = new Map(files.map((f) => [f.id, mapTrackFile(f)]));
    return tracks
      .map((t) => ({
        id: t.id,
        albumId: t.albumId,
        trackNumber: t.trackNumber,
        absoluteTrackNumber: t.absoluteTrackNumber,
        mediumNumber: t.mediumNumber,
        title: t.title,
        durationMs: t.duration,
        explicit: t.explicit,
        hasFile: t.hasFile,
        file: t.trackFileId ? byId.get(t.trackFileId) : undefined,
      }))
      .sort((a, b) => a.mediumNumber - b.mediumNumber || a.absoluteTrackNumber - b.absoluteTrackNumber);
  }

  async trackFiles(albumId: number): Promise<MusicFile[]> {
    return (await this.http.get<LTrackFile[]>('/trackfile', { albumId })).map(mapTrackFile);
  }

  /** Album lookup (MusicBrainz via Lidarr's metadata server). */
  async lookupAlbums(term: string): Promise<LookupResult[]> {
    const list = await this.http.get<(LAlbum & { artist?: { artistName: string; id?: number; foreignArtistId?: string } })[]>('/album/lookup', { term }, 30_000);
    return list.map((a) => {
      const m = mapAlbum(a);
      return {
        kind: 'album' as const,
        arrId: a.id || undefined,
        artistId: a.artistId || undefined,
        artist: a.artist?.artistName,
        foreignId: a.foreignAlbumId,
        externalId: hashId(a.foreignAlbumId),
        title: a.title,
        year: m.year ?? 0,
        overview: a.overview ?? '',
        poster: m.cover,
        inLibrary: Boolean(a.id),
      };
    });
  }

  async releases(albumId: number): Promise<Release[]> {
    const list = await this.http.get<LRelease[]>('/release', { albumId }, 180_000);
    return list.map(mapLidarrRelease);
  }

  grab(guid: string, indexerId: number) {
    return this.http.post('/release', { guid, indexerId });
  }

  queue() {
    return this.http.get<{ records: (ArrQueueRecord & { artistId?: number; albumId?: number })[] }>('/queue', { includeArtist: false, includeAlbum: false, pageSize: 500 });
  }

  removeFromQueue(id: number) {
    return this.http.delete<void>(`/queue/${id}`, { removeFromClient: false, blocklist: false });
  }

  qualityProfiles() {
    return this.http.get<{ id: number; name: string }[]>('/qualityprofile');
  }
  metadataProfiles() {
    return this.http.get<{ id: number; name: string }[]>('/metadataprofile');
  }
  rootFolders() {
    return this.http.get<{ id: number; path: string; defaultQualityProfileId?: number; defaultMetadataProfileId?: number }[]>('/rootfolder');
  }

  /** Add an album (and its artist when missing), monitored, without Lidarr searching on its own. */
  async addAlbum(foreignAlbumId: string): Promise<Album> {
    const [lookup] = await this.http.get<(LAlbum & { artist: Record<string, unknown> & { foreignArtistId: string } })[]>('/album/lookup', { term: `lidarr:${foreignAlbumId}` });
    if (!lookup) throw new Error(`MusicBrainz album ${foreignAlbumId} not found`);
    const [roots, profiles, metadata] = await Promise.all([this.rootFolders(), this.qualityProfiles(), this.metadataProfiles()]);
    if (!roots.length) throw new Error('Lidarr has no root folder');
    const root = roots[0];
    const existing = (await this.http.get<LArtist[]>('/artist')).find((a) => a.foreignArtistId === lookup.artist.foreignArtistId);
    const body = {
      ...lookup,
      monitored: true,
      artist: {
        ...lookup.artist,
        ...(existing ? { id: existing.id } : {}),
        qualityProfileId: root.defaultQualityProfileId ?? profiles[0]?.id,
        metadataProfileId: root.defaultMetadataProfileId ?? metadata[0]?.id,
        rootFolderPath: root.path,
        monitored: true,
        monitorNewItems: 'none',
        addOptions: { monitor: 'none', searchForMissingAlbums: false },
      },
      addOptions: { searchForNewAlbum: false },
    };
    return mapAlbum(await this.http.post<LAlbum>('/album', body));
  }

  refreshArtist(artistId: number) {
    return this.http.post('/command', { name: 'RefreshArtist', artistId });
  }
  rescanFolders() {
    return this.http.post('/command', { name: 'RescanFolders' });
  }
  /** Import a finished download / rip folder. */
  importFolder(path: string, downloadClientId?: string) {
    // with the download id Lidarr imports for that tracked download (its album match, and the queue item completes)
    return this.http.post('/command', { name: 'DownloadedAlbumsScan', path, importMode: 'Move', ...(downloadClientId ? { downloadClientId } : {}) });
  }
}

/** Stable numeric id for MusicBrainz UUIDs (LookupResult.externalId is a number). */
export function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
