/**
 * Real optical drives added by device path (Discs → Add drive), for drives MakeMKV does not list on its own:
 * USB drives, drives passed into Docker with --device, or a specific /dev/sr1 among several.
 *
 *   Linux   /dev/sr0 (or /dev/cdrom, /dev/disk/by-id/…); state from /sys/block/srN/size, label from blkid
 *   macOS   /dev/disk4; state and label from drutil / diskutil
 *   MakeMKV reads them through its dev:<path> source.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DiscDrive, DriveCandidate, PhysicalDrive } from '../../../shared/types.js';

const run = promisify(execFile);

/** Resolve symlinks (/dev/cdrom → /dev/sr0) and macOS raw disks (/dev/rdisk4 → /dev/disk4) so paths compare equal. */
export function canonicalDevice(p: string): string {
  let out = p.trim();
  try {
    out = fs.realpathSync(out);
  } catch {
    /* keep as typed */
  }
  return out.replace(/^\/dev\/rdisk/, '/dev/disk');
}

async function linuxState(dev: string): Promise<Pick<DiscDrive, 'state' | 'discLabel' | 'name'>> {
  const name = path.basename(dev);
  const sys = `/sys/block/${name}`;
  let state: DiscDrive['state'] = 'unknown';
  let model = '';
  try {
    const size = Number(fs.readFileSync(`${sys}/size`, 'utf8').trim());
    state = size > 0 ? 'loaded' : 'empty';
    const vendor = fs.existsSync(`${sys}/device/vendor`) ? fs.readFileSync(`${sys}/device/vendor`, 'utf8').trim() : '';
    model = [vendor, fs.existsSync(`${sys}/device/model`) ? fs.readFileSync(`${sys}/device/model`, 'utf8').trim() : ''].filter(Boolean).join(' ');
  } catch {
    /* no sysfs (e.g. /dev/sgN) – unknown */
  }
  let discLabel: string | undefined;
  if (state === 'loaded') {
    discLabel = await run('blkid', ['-o', 'value', '-s', 'LABEL', dev], { timeout: 5000 })
      .then((r) => r.stdout.trim() || undefined)
      .catch(() => undefined);
  }
  return { state, discLabel, name: model };
}

async function macState(dev: string): Promise<Pick<DiscDrive, 'state' | 'discLabel' | 'name'>> {
  const status = await run('drutil', ['status'], { timeout: 10_000 }).then((r) => r.stdout).catch(() => '');
  if (!status.includes(dev)) return { state: /No Media Inserted/i.test(status) ? 'empty' : 'unknown', name: '' };
  const info = await run('diskutil', ['info', dev], { timeout: 10_000 }).then((r) => r.stdout).catch(() => '');
  const label = info.match(/Volume Name:\s*(.+)/)?.[1]?.trim();
  const model = info.match(/Device \/ Media Name:\s*(.+)/)?.[1]?.trim() ?? '';
  return { state: 'loaded', discLabel: label && !/not applicable/i.test(label) ? label : undefined, name: model };
}

/** A configured drive that MakeMKV did not list: probe it ourselves. */
export async function probePhysicalDrive(d: PhysicalDrive, index: number): Promise<DiscDrive> {
  const dev = d.path.trim();
  const exists = process.platform === 'win32' ? true : fs.existsSync(dev);
  const base: DiscDrive = { index, name: d.label || path.basename(dev), path: dev, state: 'unknown', source: `dev:${dev}`, manualId: d.id, detected: false, available: exists };
  if (!exists) return base;
  try {
    const s = process.platform === 'linux' ? await linuxState(canonicalDevice(dev)) : process.platform === 'darwin' ? await macState(canonicalDevice(dev)) : { state: 'unknown' as const, name: '' };
    return { ...base, state: s.state, discLabel: s.discLabel, name: d.label || s.name || base.name };
  } catch {
    return base;
  }
}

/**
 * Drives the machine has that nothing else has accounted for.
 *
 * MakeMKV is the usual source of the drive list, but it does not always see one - a USB drive it calls
 * "Unsupported", a drive passed into Docker without its /dev/sg node, or simply MakeMKV not being installed yet.
 * The machine still has the drive, and saying "no optical drive" when there is one in it is the wrong answer, so
 * the ones Rexarr can see for itself are added to the list, marked as found rather than listed.
 *
 * `taken` is the device paths already covered by a MakeMKV drive or one added by hand, which must not appear twice.
 */
export function newDrives(candidates: DriveCandidate[], taken: string[]): { candidate: DriveCandidate; device: string }[] {
  const seen = new Set(taken.map((p) => (p ? canonicalDevice(p) : '')).filter(Boolean));
  const out: { candidate: DriveCandidate; device: string }[] = [];
  for (const c of candidates) {
    // a /dev/sgN node is how MakeMKV reaches a Blu-ray drive, not a drive of its own
    if (/\/dev\/sg\d+$/.test(c.path)) continue;
    const device = c.path ? canonicalDevice(c.path) : '';
    // the same drive under two names (/dev/cdrom and /dev/sr0) is one drive
    if (device && seen.has(device)) continue;
    if (device) seen.add(device);
    out.push({ candidate: c, device });
  }
  return out;
}

export async function autoDetectedDrives(taken: string[], startIndex = 2000): Promise<DiscDrive[]> {
  const out: DiscDrive[] = [];
  for (const { candidate: c, device: dev } of newDrives(await listDriveCandidates().catch(() => []), taken)) {
    const index = startIndex + out.length;
    if (!dev) {
      // macOS names the device only once a disc is in, and drutil has already said whether one is
      out.push({ index, name: c.name, path: '', state: c.state ?? 'unknown', source: '', detected: false, auto: true, available: false });
      continue;
    }
    const probed = await probePhysicalDrive({ id: `auto:${dev}`, path: dev, label: c.name, addedAt: '' }, index);
    out.push({ ...probed, manualId: undefined, auto: true, name: c.name || probed.name });
  }
  return out;
}

/** Optical devices this machine has, to pick from in the Add drive dialog. */
export async function listDriveCandidates(): Promise<DriveCandidate[]> {
  const out: DriveCandidate[] = [];
  if (process.platform === 'linux') {
    const seen = new Set<string>();
    const add = (p: string, note?: string) => {
      if (!fs.existsSync(p)) return;
      const real = canonicalDevice(p);
      if (seen.has(real)) return; // /dev/cdrom → /dev/sr0 already listed
      seen.add(real);
      const name = path.basename(real);
      let model = '';
      try {
        model = ['vendor', 'model'].map((f) => (fs.existsSync(`/sys/block/${name}/device/${f}`) ? fs.readFileSync(`/sys/block/${name}/device/${f}`, 'utf8').trim() : '')).filter(Boolean).join(' ');
      } catch {
        /* ignore */
      }
      out.push({ path: p, name: model || name, note: note ?? (real !== p ? `→ ${real}` : undefined) });
    };
    for (const f of fs.existsSync('/dev') ? fs.readdirSync('/dev').sort() : []) if (/^sr\d+$/.test(f)) add(`/dev/${f}`);
    for (const link of ['/dev/cdrom', '/dev/dvd', '/dev/bluray', '/dev/cdrw', '/dev/dvdrw']) add(link);
    // SCSI generic nodes MakeMKV talks to for Blu-ray (needed in Docker next to /dev/srN)
    for (const f of fs.existsSync('/dev') ? fs.readdirSync('/dev').sort() : []) {
      if (!/^sg\d+$/.test(f)) continue;
      try {
        const type = fs.readFileSync(`/sys/class/scsi_generic/${f}/device/type`, 'utf8').trim();
        if (type === '5') add(`/dev/${f}`, 'SCSI generic node of an optical drive – pass it to Docker too; add the /dev/srN path as the drive');
      } catch {
        /* not an optical sg node */
      }
    }
  } else if (process.platform === 'darwin') {
    const list = await run('drutil', ['list'], { timeout: 10_000 }).then((r) => r.stdout).catch(() => '');
    const status = await run('drutil', ['status'], { timeout: 10_000 }).then((r) => r.stdout).catch(() => '');
    const blocks = statusDrives(status);
    const drives = list.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => /^\s*\d+\s/.test(l));
    // drutil only names the device once a disc is in; with none it says so, which is a state rather than a gap
    const empty = /No Media Inserted/i.test(status);
    drives.forEach((line, i) => {
      const id = driveId(line);
      // this drive's own block, not the i-th device node in the output: see statusDrives
      const device = blocks.find((b) => b.id && b.id === id)?.device ?? (blocks.length === drives.length ? blocks[i]?.device ?? '' : '');
      out.push({
        path: device,
        name: id || `Drive ${i + 1}`,
        state: device ? 'loaded' : empty ? 'empty' : 'unknown',
        note: device ? undefined : 'Insert a disc to see its /dev/diskN path',
      });
    });
  }
  return out;
}

/**
 * The ways MakeMKV can be told to open one drive, best first.
 *
 * Neither handle is reliable on its own. `disc:N` is the drive's slot in whichever listing produced it, so a drive
 * MakeMKV fails to enumerate shifts every slot after it and the number opens a different, often empty, drive.
 * `dev:<node>` does not move, but MakeMKV answers "Unknown device" for a drive it did not manage to enumerate in
 * that run - which happens to a second drive more than a first. So a scan is given both and tries the next when the
 * disc will not open.
 *
 * `stored` (what the rip was created with) leads when it still addresses this same drive, because a handle already
 * known to work beats a fresh guess; when the drive has been renumbered since, it is dropped to last.
 */
export function driveSources(stored: string, live: DiscDrive | undefined): string[] {
  const candidates: string[] = [];
  if (live?.source) candidates.push(live.source);
  // only a drive MakeMKV listed has one of its numbers; Rexarr's own bands (virtual, found, added by hand) do not
  if (live && !live.auto && !live.virtual && live.index < 1000) candidates.push(`disc:${live.index}`);
  const ordered = candidates.includes(stored) ? [stored, ...candidates.filter((c) => c !== stored)] : [...candidates, stored];
  return [...new Set(ordered)].filter(Boolean);
}

/**
 * The drives `drutil status` describes, in order, each with the device node of the disc in it ('' when empty).
 *
 * This used to be read positionally - every "Name: /dev/diskN" in the output, zipped against the rows of
 * `drutil list`. With one drive that works. With two it does not: a drive holding no disc prints no Name line, so
 * the nodes shift up and a disc in the second drive is attributed to the first, leaving the drive the disc is
 * actually in with no device at all. Each Name belongs to the drive whose block it appears in, so that is how it
 * is read - which also does not care how many blocks there are or whether drutil repeats its header.
 */
export function statusDrives(status: string): { id: string; device: string }[] {
  const out: { id: string; device: string }[] = [];
  const lines = status.split('\n');
  for (const [i, line] of lines.entries()) {
    if (/^\s*Vendor\s+Product/i.test(line)) {
      // the row under the header names the drive this block is about
      const id = driveId(lines[i + 1] ?? '');
      if (id) out.push({ id, device: '' });
      continue;
    }
    const name = line.match(/Name:\s*(\/dev\/r?disk\d+)/);
    if (name && out.length) out[out.length - 1].device = name[1];
  }
  return out;
}

/** "HL-DT-ST DVDRAM GT50N" from a drutil row, which `list` and `status` write with different columns after it. */
export function driveId(row: string): string {
  const m = row.match(/^\s*(?:\d+\s+)?(\S+)\s+(.+?)\s{2,}/);
  return m ? `${m[1]} ${m[2].trim()}` : '';
}
