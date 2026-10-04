/**
 * System → Updates: the releases published on GitHub, newest first, with their notes.
 *
 * Rexarr does not update itself – the page shows what changed and how to install a release the
 * way this instance was installed (package, Docker, source). The list is cached for six hours and
 * refreshed by the "Check for updates" task; GitHub's API allows 60 unauthenticated calls an hour
 * per address, so a rate-limited answer is kept as an error instead of being retried in a loop.
 */
import type { ReleaseInfo, UpdateStatus } from '../../shared/types.js';
import { APP_VERSION, PACKAGE_INFO, REPO_URL } from './config.js';
import { IN_DOCKER } from './general.js';
import { appEvents } from './system.js';
import { httpFetch } from './net.js';
import { store } from './store.js';

const API = REPO_URL.replace('https://github.com/', 'https://api.github.com/repos/');
const TTL_MS = 6 * 3600_000;

/** "0.1.6.0" → [0, 1, 6, 0]; a missing part is 0, anything else is ignored. */
export function parseVersion(v: string): number[] {
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [];
  return [m[1], m[2], m[3], m[4]].map((p) => Number(p ?? 0));
}

/** -1, 0 or 1, comparing major.backend.feature.minor. Unparseable versions sort last. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x.length || !y.length) return x.length === y.length ? 0 : x.length ? 1 : -1;
  for (let i = 0; i < 4; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

interface GithubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  created_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** GitHub's releases, as the UI wants them: newest first, drafts dropped, marked against this build. */
export function toReleases(raw: GithubRelease[], current = APP_VERSION): ReleaseInfo[] {
  return raw
    .filter((r) => !r.draft && (r.tag_name || r.name))
    .map((r) => {
      const version = (r.tag_name || r.name || '').trim().replace(/^v/i, '');
      return {
        version,
        name: (r.name || version).trim(),
        notes: (r.body || '').trim(),
        url: r.html_url || `${REPO_URL}/releases`,
        publishedAt: r.published_at || r.created_at || '',
        prerelease: r.prerelease === true,
        installed: compareVersions(version, current) === 0,
        newer: compareVersions(version, current) > 0,
      };
    })
    .sort((a, b) => compareVersions(b.version, a.version) || (b.publishedAt > a.publishedAt ? 1 : -1));
}

/**
 * How this instance would install a release. The setting is honoured, except that "Docker" outside a
 * container would tell the user to pull an image that is not what is running here.
 */
export function mechanism(setting: UpdateStatus['mechanism'] | undefined, inDocker: boolean, packaged: boolean): UpdateStatus['mechanism'] {
  if (setting === 'docker' && !inDocker) return packaged ? 'external' : 'builtIn';
  if (setting) return setting;
  return inDocker ? 'docker' : packaged ? 'external' : 'builtIn';
}

let cache: { at: number; releases: ReleaseInfo[] } | null = null;
let lastError: string | undefined;
let announced = '';

export async function checkUpdates(force = false): Promise<UpdateStatus> {
  if (force || !cache || Date.now() - cache.at > TTL_MS) {
    try {
      const res = await httpFetch(`${API}/releases?per_page=30`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `Rexarr/${APP_VERSION}` },
      });
      if (!res.ok) throw new Error(res.status === 403 ? 'GitHub rate limit reached – try again later' : `GitHub answered ${res.status}`);
      cache = { at: Date.now(), releases: toReleases((await res.json()) as GithubRelease[]) };
      lastError = undefined;
    } catch (err) {
      lastError = (err as Error).message;
      if (!cache) return status([], lastError);
    }
  }
  const releases = cache?.releases ?? [];
  const newest = releases.find((r) => r.newer);
  if (newest && announced !== newest.version) {
    announced = newest.version;
    appEvents.add('info', 'Updates', `Rexarr ${newest.version} is available (this is ${APP_VERSION})`);
  }
  return status(releases, lastError);
}

function status(releases: ReleaseInfo[], error?: string): UpdateStatus {
  return {
    current: APP_VERSION,
    branch: store.settings.general.updates.branch || 'main',
    mechanism: mechanism(store.settings.general.updates.mechanism, IN_DOCKER, !!PACKAGE_INFO),
    inDocker: IN_DOCKER,
    checkedAt: cache ? new Date(cache.at).toISOString() : undefined,
    available: releases.find((r) => r.newer)?.version,
    releases,
    error,
  };
}
