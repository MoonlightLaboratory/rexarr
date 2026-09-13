import fs from 'node:fs';
import path from 'node:path';
import type { HealthCheck } from '../../shared/types.js';
import { store } from './store.js';
import { ffmpegCapabilities } from './ffmpeg/capabilities.js';
import { testConnection } from './routes/settings.js';
import { arr } from './arr/index.js';
import { makemkvInfo } from './disc/makemkv.js';
import { DATA_DIR } from './config.js';
import { queue } from './jobs/queue.js';

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

/** *arr style health checks. Cheap enough to run on demand; the client polls every few minutes. */
export async function runHealthChecks(): Promise<HealthCheck[]> {
  const s = store.settings;
  const out: HealthCheck[] = [];

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

  const apps = [
    ['radarr', 'Radarr'],
    ['sonarr', 'Sonarr'],
    ['prowlarr', 'Prowlarr'],
  ] as const;
  const anyArr = apps.some(([k]) => s[k].enabled);
  if (!anyArr) out.push({ type: 'warning', source: 'Connections', message: 'No Radarr or Sonarr connection is configured, so there is no library to search or transcode.', link: '/settings' });
  for (const [key, label] of apps) {
    if (!s[key].enabled) continue;
    const r = await testConnection(key, s[key]);
    if (!r.ok) out.push({ type: 'error', source: label, message: `${label} is unreachable: ${r.error ?? 'unknown error'}`, link: '/settings' });
  }

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
    const ripDir = s.disc.ripDirectory?.trim() || path.join(DATA_DIR, 'rips');
    const free = freeSpace(ripDir);
    if (free && free < 60 * 1024 ** 3) out.push({ type: 'warning', source: 'Disc ripping', message: `Only ${fmtBytes(free)} free for rips in "${ripDir}". A UHD Blu-ray can need up to 100 GB.`, link: '/settings' });
  }

  const failed = queue.list().filter((j) => j.status === 'failed').length;
  if (failed) out.push({ type: 'warning', source: 'Activity', message: `${failed} encode${failed > 1 ? 's' : ''} failed. Check the log and retry or remove ${failed > 1 ? 'them' : 'it'}.`, link: '/activity' });

  const dataFree = freeSpace(DATA_DIR);
  if (dataFree && dataFree < 1024 ** 3) out.push({ type: 'warning', source: 'Storage', message: `Less than 1 GB free on the data directory volume (${fmtBytes(dataFree)}).` });

  return out;
}
