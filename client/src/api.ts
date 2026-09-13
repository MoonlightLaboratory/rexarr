import type { DiscDrive, DiscRip, Episode, FfmpegCapabilities, HealthCheck, Job, LookupResult, MakemkvInfo, Movie, Profile, Release, RipMedia, RipOptions, Series, Settings, SystemInfo } from '@shared/types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
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
  profileId?: string;
  options?: Partial<RipOptions>;
}

export interface ReleaseSearch {
  total: number;
  remux: number;
  releases: Release[];
}

export const api = {
  settings: () => req<Settings>('GET', '/api/settings'),
  saveSettings: (s: Settings) => req<Settings>('PUT', '/api/settings', s),
  testConnection: (app: 'radarr' | 'sonarr' | 'prowlarr', conn: { url: string; apiKey: string }) => req<{ ok: boolean; version?: string; appName?: string; error?: string }>('POST', `/api/settings/test/${app}`, conn),
  arrOptions: () => req<Record<string, { qualityProfiles: { id: number; name: string }[]; rootFolders: { id: number; path: string }[] }>>('GET', '/api/settings/arr-options'),

  profiles: () => req<Profile[]>('GET', '/api/profiles'),
  createProfile: (p: Partial<Profile>) => req<Profile>('POST', '/api/profiles', p),
  updateProfile: (id: string, p: Partial<Profile>) => req<Profile>('PUT', `/api/profiles/${id}`, p),
  cloneProfile: (id: string) => req<Profile>('POST', `/api/profiles/${id}/clone`),
  deleteProfile: (id: string) => req<{ ok: true }>('DELETE', `/api/profiles/${id}`),
  preview: (body: { profile?: Partial<Profile>; profileId?: string; path?: string }) => req<PreviewResult>('POST', '/api/profiles/preview', body),

  movies: () => req<Movie[]>('GET', '/api/library/movies'),
  movie: (id: number) => req<Movie>('GET', `/api/library/movies/${id}`),
  series: () => req<Series[]>('GET', '/api/library/series'),
  seriesById: (id: number) => req<Series>('GET', `/api/library/series/${id}`),
  episodes: (id: number, season?: number) => req<Episode[]>('GET', `/api/library/series/${id}/episodes${season !== undefined ? `?season=${season}` : ''}`),

  lookup: (q: string, kind: 'movie' | 'series') => req<LookupResult[]>('GET', `/api/search/lookup?kind=${kind}&q=${encodeURIComponent(q)}`),
  addToArr: (body: { kind: 'movie' | 'series'; externalId: number; seriesType?: string; qualityProfileId?: number; rootFolderPath?: string }) => req<Movie | Series>('POST', '/api/search/add', body),
  releases: (params: Record<string, string | number | undefined>) => {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return req<ReleaseSearch>('GET', `/api/search/releases?${qs}`);
  },
  grab: (body: { release: Release; profileId: string; title: string; poster?: string; arrId?: number; seasonNumber?: number; episodeIds?: number[]; createJob?: boolean }) =>
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
  detectDiscs: () => req<{ created: DiscRip[] }>('POST', '/api/disc/detect'),
  scanRip: (id: string) => req<DiscRip>('POST', `/api/disc/rips/${id}/scan`),
  updateRip: (id: string, patch: RipPatch) => req<DiscRip>('PATCH', `/api/disc/rips/${id}`, patch),
  startRip: (id: string, patch: RipPatch) => req<DiscRip>('POST', `/api/disc/rips/${id}/start`, patch),
  cancelRip: (id: string) => req<{ ok: true }>('POST', `/api/disc/rips/${id}/cancel`),
  removeRip: (id: string) => req<{ ok: true }>('DELETE', `/api/disc/rips/${id}`),
  ejectDrive: (index: number) => req<{ ok: true }>('POST', `/api/disc/drives/${index}/eject`),

  health: () => req<HealthCheck[]>('GET', '/api/system/health'),
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

export function fmtDuration(s?: number | null) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
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
