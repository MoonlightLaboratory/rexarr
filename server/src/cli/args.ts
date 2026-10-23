/**
 * What the command line says, worked out without touching the network.
 *
 * Everything here is a pure function so the awkward parts - which drive did they mean, which profile, what does
 * an ambiguous name do - are decided in tests rather than against a running server with a disc in it.
 */
import type { DiscDrive, DiscRip, Profile, SmartProfile } from '../../../shared/types.js';

export type Command = 'status' | 'drives' | 'discs' | 'rip' | 'swap' | 'detect' | 'help' | 'version';

export interface Parsed {
  command: Command;
  /** --server, or REXARR_URL, or the usual place. */
  server: string;
  /** --key, or REXARR_API_KEY. Empty when the server has no key set. */
  key: string;
  json: boolean;
  drive?: string;
  profile?: string;
  all: boolean;
  wait: boolean;
  transcode?: boolean;
  deliver?: boolean;
  /** What is wrong with what they typed, if anything. */
  error?: string;
}

const COMMANDS: Command[] = ['status', 'drives', 'discs', 'rip', 'swap', 'detect', 'help', 'version'];

/** Trailing slashes and a missing scheme are the two things people type. */
export function normaliseServer(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : `http://${u}`;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Parsed {
  const out: Parsed = {
    command: 'help',
    server: normaliseServer(env.REXARR_URL || 'http://localhost:3939'),
    key: (env.REXARR_API_KEY || '').trim(),
    json: false,
    all: false,
    wait: false,
  };
  let command: Command | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i] ?? '';
    if (a === '--help' || a === '-h') return { ...out, command: 'help' };
    if (a === '--version' || a === '-V') return { ...out, command: 'version' };
    if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--wait') out.wait = true;
    else if (a === '--no-transcode') out.transcode = false;
    else if (a === '--no-deliver') out.deliver = false;
    else if (a === '--server') out.server = normaliseServer(value());
    else if (a === '--key') out.key = value().trim();
    else if (a === '--drive') out.drive = value().trim();
    else if (a === '--profile') out.profile = value().trim();
    else if (a.startsWith('--')) return { ...out, error: `unknown option ${a}` };
    else if (!command && COMMANDS.includes(a as Command)) command = a as Command;
    else if (!command) return { ...out, error: `unknown command "${a}"` };
    else return { ...out, command, error: `unexpected argument "${a}"` };
  }
  out.command = command ?? 'help';
  if (!out.server) return { ...out, error: 'no server address' };
  if (out.command === 'rip' && !out.drive) return { ...out, error: 'rip needs --drive' };
  if (out.command === 'swap' && !out.drive && !out.all) return { ...out, error: 'swap needs --drive or --all' };
  return out;
}

/**
 * Which drive they meant.
 *
 * The number Rexarr shows is the drive's index, which is what a script will have read out of `drives`, but a
 * device path or the label of the disc in it are both easier to type and unambiguous when they match.
 */
export function pickDrive(drives: DiscDrive[], spec: string): { drive?: DiscDrive; error?: string } {
  const want = spec.trim();
  if (!want) return { error: 'no drive given' };
  const byIndex = /^\d+$/.test(want) ? drives.filter((d) => d.index === Number(want)) : [];
  if (byIndex.length === 1) return { drive: byIndex[0] };
  const lower = want.toLowerCase();
  const hits = drives.filter(
    (d) => (d.path ?? '').toLowerCase() === lower || (d.discLabel ?? '').toLowerCase() === lower || (d.name ?? '').toLowerCase().includes(lower),
  );
  if (hits.length === 1) return { drive: hits[0] };
  if (hits.length > 1) return { error: `"${want}" matches ${hits.length} drives – use the number from "rexarr-cli drives"` };
  return { error: `no drive "${want}"` };
}

/**
 * Which profile they meant.
 *
 * Exactly by name first, then as part of a name, so "anime" finds "Anime · 1080p x265" without "x265" finding
 * four of them. Smart profiles count: to a rip they are the same choice.
 */
export function pickProfile(profiles: Profile[], smart: SmartProfile[], spec: string): { id?: string; name?: string; error?: string } {
  const want = spec.trim().toLowerCase();
  if (!want) return { error: 'no profile given' };
  const all = [...profiles.map((p) => ({ id: p.id, name: p.name })), ...smart.map((p) => ({ id: p.id, name: p.name }))];
  const exact = all.filter((p) => p.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  const partial = all.filter((p) => p.name.toLowerCase().includes(want));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return { error: `"${spec}" matches ${partial.length} profiles: ${partial.map((p) => p.name).join(', ')}` };
  return { error: `no profile matching "${spec}"` };
}

/** The disc in this drive that is waiting to be ripped, if there is one. */
export function ripInDrive(rips: DiscRip[], drive: DiscDrive): DiscRip | undefined {
  const canon = (p: string) => p.replace(/^\/dev\/rdisk/, '/dev/disk');
  return rips.find(
    (r) => r.driveIndex === drive.index || (Boolean(r.drivePath) && Boolean(drive.path) && canon(r.drivePath) === canon(drive.path)),
  );
}

/** A rip is finished with when it stops moving on its own. */
export function isFinished(status: DiscRip['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

export const USAGE = `rexarr-cli – drive Rexarr from a script

  rexarr-cli [options] <command>

Commands
  status                 the server, its drives, and anything running
  drives                 the drives and what is in them
  discs                  the discs in the queue
  detect                 look for discs now, without waiting for the next poll
  rip --drive N          rip the disc in a drive, with what has already been chosen for it
  swap --drive N|--all   eject a drive whose disc has been copied and wait for the next of its set

Options
  --server URL           where Rexarr is (default http://localhost:3939, or REXARR_URL)
  --key KEY              API key, when one is set (or REXARR_API_KEY)
  --profile NAME         encode with this profile instead of the disc's own choice
  --no-transcode         rip only; do not encode
  --no-deliver           do not hand the files to Radarr or Sonarr
  --wait                 stay until the rip is finished, printing progress
  --json                 machine-readable output
  --help, --version

A drive is the number "drives" prints, or its device path, or the label of the disc in it.`;
