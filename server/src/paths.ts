import path from 'node:path';
import type { PathMapping } from '../../shared/types.js';
import { store } from './store.js';

type App = 'radarr' | 'sonarr' | 'lidarr' | 'slskd' | undefined;

function normalise(p: string) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Mappings that apply to an app: app-specific ones first, then the ones for all apps. */
function forApp(mappings: PathMapping[], app: App) {
  return mappings.filter((m) => m.remote && m.local && (!m.app || m.app === 'all' || !app || m.app === app));
}

/** Translate a path reported by an *arr app into one Rexarr can open. Longest remote prefix wins. */
export function toLocalPath(arrPath: string, app?: App, mappings: PathMapping[] = store.settings.pathMappings): string {
  const p = arrPath.replace(/\\/g, '/');
  const sorted = forApp(mappings, app).sort((a, b) => normalise(b.remote).length - normalise(a.remote).length || Number(Boolean(b.app && b.app !== 'all')) - Number(Boolean(a.app && a.app !== 'all')));
  for (const m of sorted) {
    const remote = normalise(m.remote);
    if (p === remote || p.startsWith(remote + '/')) return path.normalize(normalise(m.local) + p.slice(remote.length));
  }
  return arrPath;
}

/** Translate a local path back into an *arr app's view (imports / rescans). Longest local prefix wins; app-specific mappings win ties. */
export function toArrPath(localPath: string, app?: App, mappings: PathMapping[] = store.settings.pathMappings): string {
  const p = localPath.replace(/\\/g, '/');
  const sorted = forApp(mappings, app).sort((a, b) => normalise(b.local).length - normalise(a.local).length || Number(Boolean(b.app && b.app !== 'all')) - Number(Boolean(a.app && a.app !== 'all')));
  for (const m of sorted) {
    const local = normalise(m.local);
    if (p === local || p.startsWith(local + '/')) return normalise(m.remote) + p.slice(local.length);
  }
  return localPath;
}
