import { hostRuntime } from './runtime.js';
import { freacInfo } from './music/freac.js';
import { IN_DOCKER } from './general.js';
import fs from 'node:fs';
import path from 'node:path';
import type { HealthCheck } from '../../shared/types.js';
import { store } from './store.js';
import { ffmpegCapabilities } from './ffmpeg/capabilities.js';
import { testConnection } from './routes/settings.js';
import { arr } from './arr/index.js';
import { makemkvInfo } from './disc/makemkv.js';
import { PATHS } from './config.js';
import { queue } from './jobs/queue.js';
import { anidb } from './anidb.js';
import { spawn } from 'node:child_process';
import { localItems, scanRoots } from './library/local.js';

function fmtBytes(n: number) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}

/** Free space of the filesystem containing `p` (0 when unknown). */
function freeSpace(p: string): number {
  try {
    let dir = p;
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return 0;
  }
}

/**
 * Network shares that list folders but hang on reads (a stalled SMB / NFS mount) make encodes and probes wait
 * forever. For every scan root / path mapping, list the folder and read 256 KB from a media file in a separate
 * process with a deadline, so a stuck mount cannot block rexarr itself. Cached for a few minutes.
 */
let shareCache: { at: number; checks: HealthCheck[] } | null = null;
let shareRunning: Promise<HealthCheck[]> | null = null;

function timedRun(cmd: string, args: string[], ms: number): Promise<'ok' | 'timeout' | 'error'> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timeout');
    }, ms);
    child.on('error', () => {
      clearTimeout(timer);
      resolve('error');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'ok' : 'error');
    });
  });
}

async function shareChecks(): Promise<HealthCheck[]> {
  if (process.platform === 'win32') return [];
  if (shareCache && Date.now() - shareCache.at < 5 * 60_000) return shareCache.checks;
  if (shareRunning) return shareCache ? shareCache.checks : shareRunning;
  shareRunning = (async () => {
    const out: HealthCheck[] = [];
    const roots = scanRoots().filter((r) => r.exists);
    const items = localItems();
    await Promise.all(
      roots.map(async (r) => {
        const started = Date.now();
        const list = await timedRun('ls', [r.path], 8000);
        if (list === 'timeout') {
          out.push({ type: 'error', source: 'Storage', message: `${r.path} is not responding (listing the folder took over 8 s). Encodes and scans from it will hang – reconnect the share.`, link: '/settings' });
          return;
        }
        const candidates = items.filter((i) => i.root === r.path).flatMap((i) => i.files.filter((f) => f.size > 64 * 1024 * 1024));
        const file = candidates[Math.floor(Math.random() * candidates.length)];
        if (!file) return;
        // a random spot deep in the file: the start is often in the page cache from an earlier probe
        const skip = Math.floor((file.size * (0.2 + Math.random() * 0.6)) / 65536);
        const read = await timedRun('dd', [`if=${file.path}`, 'of=/dev/null', 'bs=65536', 'count=4', `skip=${skip}`], 15000);
        const secs = (Date.now() - started) / 1000;
        if (read === 'timeout') out.push({ type: 'error', source: 'Storage', message: `${r.path} lists folders but reading files hangs (256 KB did not arrive in 15 s). The network share has stalled – encodes from it will stop making progress. Reconnect it (Finder → eject and connect again, or remount).`, link: '/settings' });
        else if (read === 'ok' && secs > 6) out.push({ type: 'warning', source: 'Storage', message: `${r.path} is very slow (${secs.toFixed(0)} s to read 256 KB).` });
      }),
    );
    shareCache = { at: Date.now(), checks: out };
    return out;
  })().finally(() => {
    shareRunning = null;
  });
  // the first run waits (bounded by the timeouts); later calls answer from the cache while a refresh runs
  return shareCache ? shareCache.checks : shareRunning;
}

/** *arr style health checks. Cheap enough to run on demand; the client polls every few minutes. */
export async function runHealthChecks(): Promise<HealthCheck[]> {
  const s = store.settings;
  const out: HealthCheck[] = [];

  // Settings → General
  const g = s.general;
  if (g.security.authentication === 'none' && !['localhost', '127.0.0.1', '::1'].includes(g.host.bindAddress)) {
    out.push({ type: 'warning', source: 'Security', message: 'Authentication is disabled: anyone who can reach rexarr can change settings, grab releases and delete files. Enable it in Settings → General → Security.', link: '/settings/general' });
  } else if (g.security.authentication !== 'none' && (!g.security.username || !g.security.passwordHash)) {
    out.push({ type: 'error', source: 'Security', message: 'Authentication is selected but no username / password is set, so it is not enforced.', link: '/settings/general' });
  }
  for (const d of s.disc.physicalDrives ?? []) {
    if (process.platform !== 'win32' && !fs.existsSync(d.path)) {
      out.push({ type: 'warning', source: 'Disc', message: `Drive ${d.label ? `"${d.label}" ` : ''}${d.path} was not found.${IN_DOCKER ? ` Pass it to the container (devices: - ${d.path}:${d.path}, plus its /dev/sgN node for Blu-ray).` : ' Check that it is connected.'}`, link: '/discs' });
    }
  }
  const rt = hostRuntime();
  if (rt.restartRequired) out.push({ type: 'warning', source: 'Host', message: 'Host settings changed (bind address, port, URL base or SSL). Restart rexarr to apply them.', link: '/settings/general' });
  if (g.host.enableSsl && !rt.sslPort) out.push({ type: 'error', source: 'Host', message: `HTTPS is enabled but not running on port ${g.host.sslPort} – check the certificate paths (System → Events).`, link: '/settings/general' });
  if (g.proxy.enabled && !g.proxy.hostname) out.push({ type: 'warning', source: 'Proxy', message: 'The proxy is enabled without a hostname.', link: '/settings/general' });

  const ff = await ffmpegCapabilities(s.ffmpegPath);
  if (!ff.available) out.push({ type: 'error', source: 'FFmpeg', message: `ffmpeg was not found at "${s.ffmpegPath}". Encoding cannot run.`, link: '/settings' });
  else {
    const missing = store.profiles.filter((p) => p.video.encoder !== 'copy' && !ff.videoEncoders.includes(p.video.encoder) && !p.builtin);
    if (missing.length) out.push({ type: 'warning', source: 'FFmpeg', message: `Profile${missing.length > 1 ? 's' : ''} ${missing.map((p) => `"${p.name}"`).join(', ')} use${missing.length > 1 ? '' : 's'} an encoder this ffmpeg build does not have.`, link: '/profiles' });
    const defaults = Object.entries(s.defaultProfiles)
      .map(([k, id]) => [k, store.getProfile(id)] as const)
      .filter(([, p]) => p && p.video.encoder !== 'copy' && !ff.videoEncoders.includes(p.video.encoder));
    if (defaults.length) out.push({ type: 'warning', source: 'FFmpeg', message: `Default ${defaults.map(([k]) => k).join(' / ')} profile needs an encoder (${defaults.map(([, p]) => p!.video.encoder).join(', ')}) that is not available in this ffmpeg.`, link: '/settings' });
  }

  const t = s.transcoding;
  if (t.hardwareAcceleration !== 'none' && ff.available) {
    const { HW_ACCEL_INFO } = await import('../../shared/presets.js');
    const info = HW_ACCEL_INFO[t.hardwareAcceleration];
    const have = Object.values(info.encoders).filter((e) => ff.videoEncoders.includes(e as never));
    if (!have.length) out.push({ type: 'error', source: 'Transcoding', message: `${info.label} is selected but this ffmpeg build has none of its encoders (${Object.values(info.encoders).join(', ')}). Encodes will run on the CPU.`, link: '/settings' });
    if ((t.hardwareAcceleration === 'vaapi' || t.hardwareAcceleration === 'qsv') && process.platform === 'linux') {
      const node = t.device || '/dev/dri/renderD128';
      if (!fs.existsSync(node)) out.push({ type: 'error', source: 'Transcoding', message: `Render node ${node} does not exist. In Docker pass the device with --device /dev/dri.`, link: '/settings' });
    }
  }

  const apps = [
    ['radarr', 'Radarr'],
    ['sonarr', 'Sonarr'],
    ['prowlarr', 'Prowlarr'],
    ['lidarr', 'Lidarr'],
    ['slskd', 'Soulseek (slskd)'],
  ] as const;
  const anyArr = apps.some(([k]) => s[k].enabled);
  if (!anyArr) out.push({ type: 'warning', source: 'Connections', message: 'No Radarr or Sonarr connection is configured, so there is no library to search or transcode.', link: '/settings' });
  for (const [key, label] of apps) {
    if (!s[key].enabled) continue;
    const r = await testConnection(key, s[key]);
    if (!r.ok) out.push({ type: 'error', source: label, message: `${label} is unreachable: ${r.error ?? 'unknown error'}`, link: '/settings' });
  }

  // Music: fre:ac encodes music profiles and rips CDs
  const musicInUse = s.lidarr.enabled || s.slskd.enabled || store.profiles.some((p) => p.mediaType === 'music' && !p.builtin);
  if (musicInUse) {
    const fa = await freacInfo(s.freacPath);
    if (!fa.available) out.push({ type: 'warning', source: 'fre:ac', message: `fre:ac (freaccmd) was not found${fa.error ? ` (${fa.error})` : ''}. Music profiles and CD ripping need it: install fre:ac from freac.org and set its path in Settings.`, link: '/settings' });
  }
  if (s.slskd.enabled && !s.lidarr.enabled) out.push({ type: 'warning', source: 'Soulseek', message: 'Soulseek downloads are imported through Lidarr, but Lidarr is not connected.', link: '/settings' });

  // Path mappings: check that a file the *arr app knows about actually exists here.
  try {
    const { radarr, sonarr } = arr();
    if (radarr.configured) {
      const m = (await radarr.movies()).find((x) => x.file);
      if (m?.file && !fs.existsSync(m.file.localPath)) out.push({ type: 'error', source: 'Path mappings', message: `Radarr reports "${m.file.path}" but rexarr cannot see it${m.file.localPath !== m.file.path ? ` (mapped to "${m.file.localPath}")` : ''}. Add or fix a path mapping so encodes can find the files.`, link: '/settings' });
    }
    if (sonarr.configured) {
      const sr = (await sonarr.series()).find((x) => x.statistics.episodeFileCount > 0);
      if (sr) {
        const f = (await sonarr.episodeFiles(sr.id))[0];
        if (f && !fs.existsSync(f.localPath)) out.push({ type: 'error', source: 'Path mappings', message: `Sonarr reports "${f.path}" but rexarr cannot see it${f.localPath !== f.path ? ` (mapped to "${f.localPath}")` : ''}. Add or fix a path mapping.`, link: '/settings' });
      }
    }
  } catch {
    /* connection errors are reported above */
  }

  if (s.disc.enabled) {
    const mk = await makemkvInfo(s.disc.makemkvPath);
    if (!mk.available) out.push({ type: 'error', source: 'Disc ripping', message: `makemkvcon was not found at "${mk.path}". Disc ripping is enabled but cannot run.`, link: '/settings' });
    const ripDir = s.disc.ripDirectory?.trim() || PATHS.rips;
    const free = freeSpace(ripDir);
    if (free && free < 60 * 1024 ** 3) out.push({ type: 'warning', source: 'Disc ripping', message: `Only ${fmtBytes(free)} free for rips in "${ripDir}". A UHD Blu-ray can need up to 100 GB.`, link: '/settings' });
  }

  if (s.anidb.enabled) {
    const st = anidb.status();
    if (!st.loaded && !st.loading) out.push({ type: 'warning', source: 'AniDB', message: `AniDB data could not be loaded${st.error ? `: ${st.error}` : ''}. Anime detection and romaji titles are unavailable.`, link: '/settings' });
  }

  const failed = queue.list().filter((j) => j.status === 'failed').length;
  if (failed) out.push({ type: 'warning', source: 'Activity', message: `${failed} encode${failed > 1 ? 's' : ''} failed. Check the log and retry or remove ${failed > 1 ? 'them' : 'it'}.`, link: '/activity' });

  if (s.transcodeTemp === 'transcodes') {
    const tFree = freeSpace(PATHS.transcodes);
    if (tFree && tFree < 50 * 1024 ** 3) out.push({ type: 'warning', source: 'Storage', message: `Only ${fmtBytes(tFree)} free in the transcode folder (${PATHS.transcodes}). An encode needs room for the whole output file there before it is moved into place – free space, mount a bigger volume, or write encodes next to the output instead.`, link: '/settings' });
  }
  for (const [label, dir] of [['Program Data', PATHS.programData], ['Cache', PATHS.cache], ['Logs', PATHS.logs]] as const) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      out.push({ type: 'error', source: 'Storage', message: `${label} folder ${dir} is not writable by rexarr.` });
    }
  }
  const dataFree = freeSpace(PATHS.programData);
  out.push(...(await shareChecks()));
  if (dataFree && dataFree < 1024 ** 3) out.push({ type: 'warning', source: 'Storage', message: `Less than 1 GB free on the data directory volume (${fmtBytes(dataFree)}).` });

  return out;
}
