/**
 * The Rexarr command line: everything the Discs page does, from a script.
 *
 *   rexarr-cli rip --drive 1 --profile anime --wait
 *
 * It is a client and nothing more. It holds no state, reads no configuration and talks to a running Rexarr over
 * the same HTTP API the web UI uses, so anything it can do you can also watch happen in a browser - and a box
 * with no screen needs nothing else installed.
 *
 * What it prints is meant to be read by a person; --json is meant to be read by a program. Exit codes: 0 when
 * the thing asked for happened, 1 when it did not, which is what a shell script will branch on.
 */
import { APP_VERSION } from '../../../shared/version.js';
import type { DiscDrive, DiscRip, MakemkvInfo, Profile, SmartProfile } from '../../../shared/types.js';
import { isFinished, parseArgs, pickDrive, pickProfile, ripInDrive, USAGE, type Parsed } from './args.js';

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);
/** Every refusal is prefixed and exits 1, so a script sees the same shape whatever went wrong. */
const fail = (s: string): number => (err(`rexarr-cli: ${s}`), 1);

async function api<T>(o: Parsed, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${o.server}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(o.key ? { 'x-api-key': o.key } : {}), ...(init?.headers as Record<string, string>) },
  }).catch((e: Error) => {
    throw new Error(`cannot reach Rexarr at ${o.server} (${e.message})`);
  });
  if (res.status === 401 || res.status === 403) throw new Error(o.key ? 'the API key was refused' : 'Rexarr wants an API key – pass --key or set REXARR_API_KEY');
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    const said = body.startsWith('{') ? ((JSON.parse(body) as { error?: string }).error ?? body) : body;
    throw new Error(`${path}: ${res.status} ${said || res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const pct = (r: DiscRip) => {
  const p = r.progress;
  if (!p?.titleCount || p.titleCount <= 1 || p.titleIndex < 1) return Math.round(p?.percent ?? 0);
  return Math.round(((p.titleIndex - 1 + (p.percent ?? 0) / 100) / p.titleCount) * 100);
};

function printDrives(drives: DiscDrive[]) {
  if (!drives.length) return out('No drives.');
  for (const d of drives) {
    const disc = d.discLabel ? ` · ${d.discLabel}` : '';
    const waiting = d.awaiting ? ` · waiting for disc ${d.awaiting.discNumber} of ${d.awaiting.batchName}` : '';
    out(`${String(d.index).padStart(4)}  ${d.state.padEnd(8)} ${d.name || d.path || 'Drive'}${disc}${waiting}`);
  }
}

function printRips(rips: DiscRip[]) {
  if (!rips.length) return out('No discs in the queue.');
  for (const r of rips) {
    const title = r.media?.title || r.label || 'Disc';
    const where = r.media?.discNumber ? ` (disc ${r.media.discNumber})` : '';
    const prog = ['ripping', 'transcoding'].includes(r.status) ? ` ${pct(r)}%` : '';
    out(`${r.id.slice(0, 8)}  ${r.status.padEnd(12)}${prog.padEnd(6)} ${title}${where}`);
  }
}

/** Stay until the rip stops moving, saying what it is doing as it goes. */
async function waitFor(o: Parsed, id: string): Promise<DiscRip> {
  let last = '';
  for (;;) {
    const rips = await api<DiscRip[]>(o, '/api/disc/rips');
    const rip = rips.find((r) => r.id === id);
    if (!rip) throw new Error('the disc was removed from the queue');
    if (isFinished(rip.status)) return rip;
    const line = `${rip.status}${['ripping', 'transcoding'].includes(rip.status) ? ` ${pct(rip)}%` : ''}${rip.progress?.step ? ` · ${rip.progress.step}` : ''}`;
    if (line !== last && !o.json) out(line);
    last = line;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function run(o: Parsed): Promise<number> {
  if (o.command === 'help') return (out(USAGE), 0);
  if (o.command === 'version') return (out(APP_VERSION), 0);

  if (o.command === 'detect') {
    const r = await api<{ created: DiscRip[] }>(o, '/api/disc/detect', { method: 'POST' });
    if (o.json) return (out(JSON.stringify(r.created, null, 2)), 0);
    out(r.created.length ? `Found ${r.created.length} disc(s).` : 'No new disc in any drive.');
    return 0;
  }

  if (o.command === 'drives' || o.command === 'status') {
    const s = await api<{ drives: DiscDrive[]; makemkv?: MakemkvInfo }>(o, '/api/disc/status');
    if (o.command === 'drives') {
      if (o.json) return (out(JSON.stringify(s.drives, null, 2)), 0);
      printDrives(s.drives);
      return 0;
    }
    const rips = await api<DiscRip[]>(o, '/api/disc/rips');
    const busy = rips.filter((r) => !isFinished(r.status));
    if (o.json) return (out(JSON.stringify({ version: APP_VERSION, server: o.server, makemkv: s.makemkv, drives: s.drives, active: busy }, null, 2)), 0);
    out(`Rexarr at ${o.server}`);
    out(`MakeMKV ${s.makemkv?.available ? (s.makemkv.version ?? 'available') : 'not found'}`);
    printDrives(s.drives);
    out(busy.length ? `\n${busy.length} disc(s) in progress:` : '\nNothing in progress.');
    if (busy.length) printRips(busy);
    return 0;
  }

  if (o.command === 'discs') {
    const rips = await api<DiscRip[]>(o, '/api/disc/rips');
    const list = o.all ? rips : rips.filter((r) => !isFinished(r.status));
    if (o.json) return (out(JSON.stringify(list, null, 2)), 0);
    printRips(list);
    if (!o.all && rips.length !== list.length) out(`\n${rips.length - list.length} finished – "discs --all" shows them.`);
    return 0;
  }

  if (o.command === 'swap') {
    if (o.all) {
      const r = await api<{ swapped: { drive: number; waitingFor?: number; batch?: string }[] }>(o, '/api/disc/drives/swap-all', { method: 'POST' });
      if (o.json) return (out(JSON.stringify(r.swapped, null, 2)), 0);
      if (!r.swapped.length) return (out('No drive has finished copying its disc.'), 0);
      for (const s of r.swapped) out(s.waitingFor !== undefined ? `Drive ${s.drive}: put in disc ${s.waitingFor} of ${s.batch}` : `Drive ${s.drive}: ejected`);
      return 0;
    }
    const { drives } = await api<{ drives: DiscDrive[] }>(o, '/api/disc/status');
    const picked = pickDrive(drives, o.drive!);
    if (!picked.drive) return fail(picked.error!);
    const r = await api<{ drive: number; waitingFor?: number; batch?: string }>(o, `/api/disc/drives/${picked.drive.index}/swap`, { method: 'POST' });
    if (o.json) return (out(JSON.stringify(r, null, 2)), 0);
    out(r.waitingFor !== undefined ? `Ejected – put in disc ${r.waitingFor} of ${r.batch}` : 'Ejected.');
    return 0;
  }

  // rip
  const { drives } = await api<{ drives: DiscDrive[] }>(o, '/api/disc/status');
  const picked = pickDrive(drives, o.drive!);
  if (!picked.drive) return fail(picked.error!);
  const drive = picked.drive;
  if (drive.state !== 'loaded') return fail(`${drive.name || `drive ${drive.index}`} has no disc in it`);

  let rip = ripInDrive(await api<DiscRip[]>(o, '/api/disc/rips'), drive);
  if (!rip || isFinished(rip.status)) {
    // nothing read this disc yet, or what did is finished with: read it now rather than waiting for the poll
    const found = await api<{ created: DiscRip[] }>(o, '/api/disc/detect', { method: 'POST' });
    rip = found.created.find((r) => r.driveIndex === drive.index) ?? ripInDrive(await api<DiscRip[]>(o, '/api/disc/rips'), drive);
    if (!rip) return fail('that disc could not be read');
    if (!o.json) out(`Reading ${rip.label || 'the disc'}…`);
    while (['inserted', 'scanning'].includes(rip.status)) {
      await new Promise((r) => setTimeout(r, 2000));
      rip = (await api<DiscRip[]>(o, '/api/disc/rips')).find((r) => r.id === rip!.id);
      if (!rip) return fail('that disc left the queue while it was being read');
    }
  }
  if (rip.status !== 'ready') return fail(`${rip.label || 'that disc'} is ${rip.status}, not waiting to be ripped`);

  const patch: Record<string, unknown> = {};
  if (o.profile) {
    const [profiles, smart] = await Promise.all([api<Profile[]>(o, '/api/profiles'), api<SmartProfile[]>(o, '/api/smart-profiles')]);
    const hit = pickProfile(profiles, smart, o.profile);
    if (!hit.id) return fail(hit.error!);
    patch.profileId = hit.id;
    if (!o.json) out(`Profile: ${hit.name}`);
  }
  if (o.transcode === false || o.deliver === false) {
    patch.options = { ...rip.options, ...(o.transcode === false ? { transcode: false } : {}), ...(o.deliver === false ? { deliver: false } : {}) };
  }

  const started = await api<DiscRip>(o, `/api/disc/rips/${rip.id}/start`, { method: 'POST', body: JSON.stringify(patch) });
  if (!o.wait) {
    if (o.json) return (out(JSON.stringify(started, null, 2)), 0);
    out(`Ripping ${started.media?.title || started.label || 'the disc'} (${started.id.slice(0, 8)}).`);
    return 0;
  }
  const done = await waitFor(o, started.id);
  if (o.json) out(JSON.stringify(done, null, 2));
  else out(done.status === 'done' ? `Finished: ${done.files?.length ?? 0} file(s).` : `${done.status}: ${done.error ?? 'no reason given'}`);
  return done.status === 'done' ? 0 : 1;
}

const parsed = parseArgs(process.argv.slice(2), process.env);
if (parsed.error) {
  err(`rexarr-cli: ${parsed.error}\n`);
  err(USAGE);
  process.exit(1);
}
run(parsed).then(
  (code) => process.exit(code),
  (e: Error) => {
    err(`rexarr-cli: ${e.message}`);
    process.exit(1);
  },
);
