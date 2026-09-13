import path from 'node:path';
import type { PathMapping } from '../../shared/types.js';
import { store } from './store.js';

function normalise(p: string) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Translate a path reported by an *arr app into one rexarr can open. */
export function toLocalPath(arrPath: string, mappings: PathMapping[] = store.settings.pathMappings): string {
  const p = arrPath.replace(/\\/g, '/');
  // Longest remote prefix wins.
  const sorted = [...mappings].filter((m) => m.remote && m.local).sort((a, b) => normalise(b.remote).length - normalise(a.remote).length);
  for (const m of sorted) {
    const remote = normalise(m.remote);
    if (p === remote || p.startsWith(remote + '/')) {
      const rest = p.slice(remote.length);
      return path.normalize(normalise(m.local) + rest);
    }
  }
  return arrPath;
}

/** Translate a local path back into the *arr app's view (for rescans / logging). */
export function toArrPath(localPath: string, mappings: PathMapping[] = store.settings.pathMappings): string {
  const p = localPath.replace(/\\/g, '/');
  const sorted = [...mappings].filter((m) => m.remote && m.local).sort((a, b) => normalise(b.local).length - normalise(a.local).length);
  for (const m of sorted) {
    const local = normalise(m.local);
    if (p === local || p.startsWith(local + '/')) {
      return normalise(m.remote) + p.slice(local.length);
    }
  }
  return localPath;
}
