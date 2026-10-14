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
    const devices = [...status.matchAll(/Name:\s*(\/dev\/disk\d+)/g)].map((m) => m[1]);
    const drives = list.split('\n').slice(1).map((l) => l.trim()).filter((l) => /^\d+\s/.test(l));
    // drutil only names the device once a disc is in; with none it says so, which is a state rather than a gap
    const empty = /No Media Inserted/i.test(status);
    drives.forEach((line, i) => {
      const [, vendor, product] = line.match(/^\d+\s+(\S+)\s+(.+?)\s{2,}/) ?? [];
      out.push({
        path: devices[i] ?? '',
        name: [vendor, product].filter(Boolean).join(' ') || `Drive ${i + 1}`,
        state: devices[i] ? 'loaded' : empty ? 'empty' : 'unknown',
        note: devices[i] ? undefined : 'Insert a disc to see its /dev/diskN path',
      });
    });
  }
  return out;
}
