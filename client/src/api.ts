import { withBase } from './base';
import type { DiscEstimate, TitleRole, AnidbInfo, AutoScanResult, AutoStatus, AppEvent, StoragePath, HwDevices, HwTestResult, TranscodingSettings, BackupInfo, DiscDrive, DiscRip, LogFileInfo, ScheduledTask, VirtualDrive, Episode, FfmpegCapabilities, HealthCheck, Job, LookupResult, MakemkvInfo, Movie, Profile, Release, RipMedia, RipOptions, Series, Settings, SystemInfo, SmartSearchResult, HostRuntime, DriveCandidate, PhysicalDrive, Artist, Album, Track, MqaInfo, MusicBrainzRelease, LocalItem, LocalFile, LocalScanStatus, LocalMeta, LocalMetaCandidate, SizeEstimateResult, SetupTools } from '@shared/types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(withBase(url), {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (res.status === 401 && (data as { login?: string })?.login) {
    // Forms authentication: the session expired – back to the login page, then here again.
    window.location.href = `${(data as { login: string }).login}?returnUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? (typeof data === 'string' ? data : `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return data as T;
}

export interface PreviewResult {
  command: string;
  args: string[];
  warnings: string[];
  summary: string[];
  output: string;
  sample: boolean;
  streams: { index: number; type: string; codec: string; language?: string; title?: string; channels?: number; width?: number; height?: number }[];
}

export interface RipPatch {
  media?: Partial<RipMedia>;
  selectedTitleIds?: number[];
  episodeMap?: Record<number, number>;
  profileId?: string;
  options?: Partial<RipOptions>;
  audioMode?: 'best' | 'all' | 'custom';
  selectedAudio?: Record<string, number[]>;
  titleRoles?: Record<string, TitleRole>;
}

export interface MediaMetadata {
  path: string;
  format?: { format_name?: string; format_long_name?: string; duration?: string; size?: string; bit_rate?: string; tags?: Record<string, string> };
  streams?: { index: number; codec_type?: string; codec_name?: string; codec_long_name?: string; sample_rate?: string; channels?: number; channel_layout?: string; bits_per_raw_sample?: string; sample_fmt?: string; bit_rate?: string; width?: number; height?: number; tags?: Record<string, string>; disposition?: Record<string, number> }[];
  chapters: number;
  mqa?: MqaInfo;
}

export interface ReleaseSearch {
  errors?: string[];
  total: number;
  remux: number;
  disc?: number;
  releases: Release[];
}

export const api = {
  settings: () => req<Settings>('GET', '/api/settings'),
  saveSettings: (s: Settings) => req<Settings>('PUT', '/api/settings', s),
  hostRuntime: () => req<HostRuntime>('GET', '/api/settings/host'),
  regenerateApiKey: () => req<{ apiKey: string }>('POST', '/api/settings/apikey'),
  shutdown: () => req<{ shuttingDown: boolean }>('POST', '/api/system/shutdown'),
  restart: () => req<{ restarting: boolean; port: number; urlBase: string }>('POST', '/api/system/restart'),
  authStatus: () => req<{ authentication: 'none' | 'basic' | 'forms'; username?: string }>('GET', '/api/auth/status'),
  testConnection: (app: 'radarr' | 'sonarr' | 'prowlarr' | 'lidarr' | 'slskd', conn: { url: string; apiKey: string }) => req<{ ok: boolean; version?: string; appName?: string; error?: string }>('POST', `/api/settings/test/${app}`, conn),
  arrOptions: () => req<Record<string, { qualityProfiles: { id: number; name: string }[]; rootFolders: { id: number; path: string }[] }>>('GET', '/api/settings/arr-options'),

  profiles: () => req<Profile[]>('GET', '/api/profiles'),
  createProfile: (p: Partial<Profile>) => req<Profile>('POST', '/api/profiles', p),
  updateProfile: (id: string, p: Partial<Profile>) => req<Profile>('PUT', `/api/profiles/${id}`, p),
  cloneProfile: (id: string) => req<Profile>('POST', `/api/profiles/${id}/clone`),
  deleteProfile: (id: string) => req<{ ok: true }>('DELETE', `/api/profiles/${id}`),
  preview: (body: { profile?: Partial<Profile>; profileId?: string; path?: string }) => req<PreviewResult>('POST', '/api/profiles/preview', body),

  movies: () => req<Movie[]>('GET', '/api/library/movies'),
  movie: (id: number) => req<Movie>('GET', `/api/library/movies/${id}`),
  // ---- music (Lidarr, fre:ac, MusicBrainz) ----
  artists: () => req<Artist[]>('GET', '/api/music/artists'),
  artist: (id: number) => req<{ artist: Artist; albums: Album[] }>('GET', `/api/music/artists/${id}`),
  album: (id: number) => req<{ album: Album; tracks: Track[] }>('GET', `/api/music/albums/${id}`),
  scanMqa: (body: { albumId?: number; paths?: string[] }) => req<Record<string, MqaInfo | { error: string }>>('POST', '/api/music/mqa', body),
  localStatus: () => req<LocalScanStatus>('GET', '/api/local/status'),
  localScan: () => req<LocalScanStatus>('POST', '/api/local/scan'),
  localCandidates: (id: string, q?: string) => req<LocalMetaCandidate[]>('GET', `/api/local/items/${id}/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  localMatch: (id: string, body: { candidate?: LocalMetaCandidate; clear?: boolean }) => req<LocalMeta | { ok: true }>('POST', `/api/local/items/${id}/match`, body),
  localMetadataRefresh: (force = false) => req<LocalScanStatus>('POST', `/api/local/metadata/refresh${force ? '?force=1' : ''}`),
  localItem: (id: string) => req<Omit<LocalItem, 'files'> & { files: (LocalFile & { exists: boolean })[] }>('GET', `/api/local/items/${id}`),
  importMusicFolder: (path: string) => req<{ images: number; tracks?: number; encodings?: string[]; message: string }>('POST', '/api/music/import-folder', { path }),
  mediaMetadata: (path: string) => req<MediaMetadata>('GET', `/api/media/metadata?path=${encodeURIComponent(path)}`),
  freac: (refresh = false) => req<SystemInfo['freac']>('GET', `/api/music/freac${refresh ? '?refresh=1' : ''}`),
  addAlbum: (foreignAlbumId: string) => req<Album>('POST', '/api/music/add', { foreignAlbumId }),
  musicbrainzSearch: (q: string) => req<MusicBrainzRelease[]>('GET', `/api/musicbrainz/search?q=${encodeURIComponent(q)}`),
  readCd: (driveIndex: number) => req<DiscRip>('POST', `/api/disc/drives/${driveIndex}/cd`),
  setCdRelease: (ripId: string, body: { index?: number; releaseId?: string }) => req<DiscRip>('POST', `/api/disc/rips/${ripId}/musicbrainz`, body),
  series: () => req<Series[]>('GET', '/api/library/series'),
  seriesById: (id: number) => req<Series>('GET', `/api/library/series/${id}`),
  episodes: (id: number, season?: number) => req<Episode[]>('GET', `/api/library/series/${id}/episodes${season !== undefined ? `?season=${season}` : ''}`),

  estimate: (items: { localPath?: string; arrPath?: string; arr?: 'radarr' | 'sonarr' | 'lidarr'; size?: number; anime?: boolean }[], profileIds?: string[]) => req<SizeEstimateResult>('POST', '/api/estimate', { items, profileIds }),
  pauseQueue: (paused: boolean) => req<{ paused: boolean }>('POST', '/api/queue/pause', { paused }),
  retryFailedJobs: () => req<{ retried: number }>('POST', '/api/jobs/retry-failed'),
  localSearch: (q: string) => req<LookupResult[]>('GET', `/api/search/local?q=${encodeURIComponent(q)}`),
  smart: (q: string, scope: 'all' | 'movie' | 'series' | 'music', online: boolean) => req<SmartSearchResult>('GET', `/api/search/smart?scope=${scope}&online=${online ? 1 : 0}&q=${encodeURIComponent(q)}`),
  lookup: (q: string, kind: 'movie' | 'series') => req<LookupResult[]>('GET', `/api/search/lookup?kind=${kind}&q=${encodeURIComponent(q)}`),
  addToArr: (body: { kind: 'movie' | 'series'; externalId: number; seriesType?: string; qualityProfileId?: number; rootFolderPath?: string }) => req<Movie | Series>('POST', '/api/search/add', body),
  releases: (params: Record<string, string | number | undefined>) => {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return req<ReleaseSearch>('GET', `/api/search/releases?${qs}`);
  },
  grab: (body: { release: Release; profileId: string; title: string; poster?: string; arrId?: number; albumId?: number; seasonNumber?: number; episodeIds?: number[]; createJob?: boolean }) =>
    req<{ grabbed: boolean; job: Job | null; note?: string }>('POST', '/api/search/grab', body),

  jobs: () => req<Job[]>('GET', '/api/jobs'),
  createJob: (body: { title: string; subtitle?: string; poster?: string; profileId: string; source: Job['source'] }) => req<Job>('POST', '/api/jobs', body),
  bulkJobs: (body: { profileId: string; items: { title: string; subtitle?: string; poster?: string; source: Job['source'] }[] }) => req<{ created: number; errors: string[] }>('POST', '/api/jobs/bulk', body),
  cancelJob: (id: string) => req<{ ok: true }>('POST', `/api/jobs/${id}/cancel`),
  retryJob: (id: string) => req<{ ok: true }>('POST', `/api/jobs/${id}/retry`),
  reorderJob: (id: string, direction: 'top' | 'bottom') => req<{ ok: true }>('POST', `/api/jobs/${id}/reorder`, { direction }),
  removeJob: (id: string) => req<{ ok: true }>('DELETE', `/api/jobs/${id}`),
  clearJobs: () => req<{ ok: true }>('POST', '/api/jobs/clear'),
  jobLog: (id: string) => req<{ log: string[]; command?: string }>('GET', `/api/jobs/${id}/log`),

  discStatus: (refresh = false) => req<{ makemkv: MakemkvInfo; drives: DiscDrive[]; driveError?: string; enabled: boolean }>('GET', `/api/disc/status${refresh ? '?refresh=1' : ''}`),
  rips: () => req<DiscRip[]>('GET', '/api/disc/rips'),
  reidentifyRip: (id: string) => req<DiscRip>('POST', `/api/disc/rips/${id}/identify`),
  checkRipDirectory: () => req<{ dir: string; localOk: boolean; apps: { app: 'radarr' | 'sonarr'; path: string; visible: boolean | null; error?: string }[] }>('GET', '/api/disc/rip-directory/check'),
  estimateRip: (id: string, body: { selectedTitleIds?: number[]; profileId?: string; options?: Partial<RipOptions>; audioMode?: 'best' | 'all' | 'custom'; selectedAudio?: Record<string, number[]> }) =>
    req<DiscEstimate>('POST', `/api/disc/rips/${id}/estimate`, body),
  detectDiscs: () => req<{ created: DiscRip[] }>('POST', '/api/disc/detect'),
  openImage: (path: string) => req<DiscRip>('POST', '/api/disc/open', { path }),
  virtualDrives: () => req<VirtualDrive[]>('GET', '/api/disc/virtual'),
  driveCandidates: () => req<DriveCandidate[]>('GET', '/api/disc/drives/candidates'),
  addPhysicalDrive: (path: string, label?: string) => req<PhysicalDrive>('POST', '/api/disc/drives', { path, label }),
  removePhysicalDrive: (id: string) => req<{ ok: true }>('DELETE', `/api/disc/drives/${id}`),
  addVirtualDrive: (path: string, label?: string) => req<VirtualDrive>('POST', '/api/disc/virtual', { path, label }),
  removeVirtualDrive: (id: string) => req<{ ok: true }>('DELETE', `/api/disc/virtual/${id}`),
  scanRip: (id: string) => req<DiscRip>('POST', `/api/disc/rips/${id}/scan`),
  updateRip: (id: string, patch: RipPatch) => req<DiscRip>('PATCH', `/api/disc/rips/${id}`, patch),
  startRip: (id: string, patch: RipPatch) => req<DiscRip>('POST', `/api/disc/rips/${id}/start`, patch),
  cancelRip: (id: string) => req<{ ok: true }>('POST', `/api/disc/rips/${id}/cancel`),
  removeRip: (id: string) => req<{ ok: true }>('DELETE', `/api/disc/rips/${id}`),
  ejectDrive: (index: number) => req<{ ok: true }>('POST', `/api/disc/drives/${index}/eject`),

  health: () => req<HealthCheck[]>('GET', '/api/system/health'),
  transcodingDevices: () => req<HwDevices>('GET', '/api/transcoding/devices'),
  transcodingTest: (t: Pick<TranscodingSettings, 'hardwareAcceleration' | 'device' | 'hardwareDecoding'>) => req<HwTestResult>('POST', '/api/transcoding/test', t),
  paths: (refresh = false) => req<StoragePath[]>('GET', `/api/system/paths${refresh ? '?refresh=1' : ''}`),
  autoStatus: () => req<AutoStatus>('GET', '/api/auto/status'),
  autoScan: (dryRun: boolean) => req<AutoScanResult>('POST', `/api/auto/scan${dryRun ? '?dryRun=1' : ''}`),
  autoReset: () => req<AutoStatus>('POST', '/api/auto/reset'),
  events: (level?: string) => req<AppEvent[]>('GET', `/api/system/events${level ? `?level=${level}` : ''}`),
  clearEvents: () => req<{ ok: true }>('DELETE', '/api/system/events'),
  tasks: () => req<ScheduledTask[]>('GET', '/api/system/tasks'),
  runTask: (id: string) => req<ScheduledTask>('POST', `/api/system/tasks/${id}/run`),
  backups: () => req<BackupInfo[]>('GET', '/api/system/backups'),
  createBackup: () => req<BackupInfo>('POST', '/api/system/backups'),
  deleteBackup: (name: string) => req<{ ok: true }>('DELETE', `/api/system/backups/${encodeURIComponent(name)}`),
  restoreBackup: (name: string) => req<{ restored: string[] }>('POST', `/api/system/backups/${encodeURIComponent(name)}/restore`),
  restoreBackupUpload: async (file: File) => {
    const res = await fetch(withBase('/api/system/backups/restore'), { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: await file.arrayBuffer() });
    const j = (await res.json()) as { restored?: string[]; error?: string };
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    return j as { restored: string[] };
  },
  logFiles: () => req<LogFileInfo[]>('GET', '/api/system/logs'),
  logFile: async (name: string) => {
    const res = await fetch(withBase(`/api/system/logs/${encodeURIComponent(name)}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
  clearLogs: () => req<{ ok: true }>('DELETE', '/api/system/logs'),
  anidbStatus: () => req<AnidbInfo>('GET', '/api/anidb/status'),
  anidbRefresh: () => req<AnidbInfo>('POST', '/api/anidb/refresh'),
  anidbSearch: (q: string) => req<{ aid: number; title: string; romaji?: string; kanji?: string; english?: string; score: number; tvdbId?: number; tmdbId?: number; imdbId?: string; isMovie: boolean }[]>('GET', `/api/anidb/search?q=${encodeURIComponent(q)}`),
  setupTools: (refresh = false) => req<SetupTools>('GET', `/api/setup/tools${refresh ? '?refresh=1' : ''}`),
  setupDismiss: (dismissed: boolean) => req<{ dismissed: boolean }>('POST', '/api/setup/dismiss', { dismissed }),
  system: (refresh = false) => req<SystemInfo>('GET', `/api/system${refresh ? '?refresh=1' : ''}`),
  ffmpeg: (refresh = false) => req<FfmpegCapabilities>('GET', `/api/system/ffmpeg${refresh ? '?refresh=1' : ''}`),
  fsList: (path: string) => req<{ path: string; parent: string | null; entries: { name: string; dir: boolean; path: string }[] }>('GET', `/api/fs/list?path=${encodeURIComponent(path)}`),
};

export function fmtBytes(n?: number) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i >= 3 ? 2 : i >= 2 ? 1 : 0)} ${u[i]}`;
}

/** Whole-disc rip progress: MakeMKV reports each title (or CD track) from 0 to 100 in turn. */
export function ripOverallPercent(p: { percent: number; titleIndex: number; titleCount: number }) {
  if (p.titleCount <= 1 || p.titleIndex < 1) return p.percent;
  return Math.min(100, ((p.titleIndex - 1 + p.percent / 100) / p.titleCount) * 100);
}

export function fmtDuration(s?: number | null) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d >= 2) return `${d}d ${h - d * 24}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtAge(iso?: string) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
