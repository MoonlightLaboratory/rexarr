/**
 * Making the folder a rip is written to, and saying something useful when that fails. "EACCES: permission
 * denied, mkdir '/Volumes/Media/Rips/…'" is true and no help at all: the folder that could not be made is
 * usually not the one in the message, and the reason is usually a share that is not mounted.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface FolderProbe {
  /** The deepest part of the path that does exist, which may be as far up as "/". */
  deepestExisting: string;
  /** Can the process write into that one? */
  writable: boolean;
}

/** Walk up until something exists, and see whether it can be written to. */
export function probeFolder(dir: string): FolderProbe {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(at)) break;
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  let writable = false;
  try {
    fs.accessSync(at, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  return { deepestExisting: at, writable };
}

/**
 * Why a folder could not be made, in a sentence that says what to do about it. Pure, so the wording can be
 * tested without a filesystem that misbehaves on demand.
 */
export function explainFolderError(dir: string, code: string | undefined, probe: FolderProbe, platform = process.platform): string {
  const target = path.resolve(dir);
  const missing = probe.deepestExisting === target ? '' : target.slice(probe.deepestExisting.length).split(path.sep).filter(Boolean)[0];
  const firstMissing = missing ? path.join(probe.deepestExisting, missing) : '';
  const head = `Cannot create the rip folder "${target}"`;
  // macOS: /Volumes is root's, so a share or disc that is not mounted fails as a permission error one level up
  if (platform === 'darwin' && probe.deepestExisting === '/Volumes' && firstMissing) {
    return `${head}: ${firstMissing} is not mounted. Only root can create folders directly in /Volumes, so this is a drive or network share that is not there – mount it, or point Settings → Disc ripping → Rip folder at a folder that exists.`;
  }
  if (code === 'EROFS') return `${head}: ${probe.deepestExisting} is on a read-only filesystem.`;
  if (code === 'ENOSPC') return `${head}: no space left on ${probe.deepestExisting}.`;
  if (code === 'ENOTDIR') return `${head}: ${probe.deepestExisting} is a file, not a folder.`;
  if (!probe.writable) {
    const who = process.getuid ? ` (uid ${process.getuid()})` : '';
    return `${head}: ${probe.deepestExisting} is not writable by the user Rexarr runs as${who}${firstMissing ? `, so ${firstMissing} could not be made` : ''}. Fix that folder's permissions, or choose another rip folder.`;
  }
  return `${head}: ${code ?? 'unknown error'} at ${probe.deepestExisting}.`;
}

/** Make the folder, or throw an error a person can act on. Also catches a share that mounts read-only. */
export function ensureRipFolder(dir: string): string {
  const target = path.resolve(dir);
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
    return target;
  } catch (err) {
    throw new Error(explainFolderError(target, (err as NodeJS.ErrnoException).code, probeFolder(target)));
  }
}
