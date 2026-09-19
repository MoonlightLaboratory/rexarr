/**
 * Keep the computer awake while Rexarr is working. Many people run Rexarr on a laptop or desktop that goes to sleep
 * after a few idle minutes, which freezes a rip or an encode halfway. While a disc is being scanned or ripped, or a
 * file encoded, Rexarr holds the system's own "stay awake" request and lets go as soon as nothing is running:
 *
 *   macOS    caffeinate -i -s -m, tied to Rexarr's process so it can never outlive it
 *   Windows  SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) from a hidden PowerShell
 *   Linux    systemd-inhibit --what=idle:sleep (desktops and laptops with systemd)
 *
 * Only idle sleep is prevented: closing a laptop lid or choosing Sleep still sleeps the computer, and the display
 * may still turn off. Docker containers are left alone – the host decides.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { IN_DOCKER } from './general.js';

export interface PowerStatus {
  supported: boolean;
  /** How sleep is prevented on this system. */
  method?: string;
  /** Sleep is being prevented right now. */
  active: boolean;
  /** What is keeping it awake, e.g. "encoding 1 file". */
  reason?: string;
  error?: string;
}

let child: ChildProcess | null = null;
let reason = '';
let lastError = '';
let linuxInhibit: boolean | null = null;

function inhibitor(why: string): { cmd: string; args: string[]; method: string } | null {
  if (IN_DOCKER) return null;
  const pid = process.pid;
  if (process.platform === 'darwin') {
    // -i idle sleep, -s system sleep on AC power, -m disk sleep; -w: exit together with Rexarr
    return { cmd: '/usr/bin/caffeinate', args: ['-i', '-s', '-m', '-w', String(pid)], method: 'caffeinate' };
  }
  if (process.platform === 'win32') {
    // the request lasts as long as this PowerShell runs, and it stops by itself when Rexarr is gone
    const script = [
      "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
      '$k = Add-Type -MemberDefinition $sig -Name RexarrAwake -Namespace Win32 -PassThru',
      '[void]$k::SetThreadExecutionState([uint32]"0x80000001")',
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 15 }`,
    ].join('; ');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], method: 'Windows power request' };
  }
  if (process.platform === 'linux') {
    if (linuxInhibit === null) linuxInhibit = spawnSync('systemd-inhibit', ['--version'], { stdio: 'ignore' }).status === 0;
    if (!linuxInhibit) return null;
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=idle:sleep', '--who=Rexarr', `--why=${why}`, '--mode=block', 'sh', '-c', `while kill -0 ${pid} 2>/dev/null; do sleep 15; done`],
      method: 'systemd-inhibit',
    };
  }
  return null;
}

/** Hold or release the stay-awake request. Cheap to call repeatedly with the same state. */
export function keepAwake(on: boolean, why = 'ripping or encoding'): void {
  if (!on) {
    reason = '';
    if (child) {
      child.kill();
      child = null;
    }
    return;
  }
  reason = why;
  if (child) return;
  const inh = inhibitor(`Rexarr is ${why}`);
  if (!inh) return;
  try {
    const c = spawn(inh.cmd, inh.args, { stdio: 'ignore', windowsHide: true });
    c.on('error', (err) => {
      lastError = `${inh.method}: ${err.message}`;
      if (child === c) child = null;
    });
    c.on('exit', () => {
      if (child === c) child = null;
    });
    child = c;
    lastError = '';
  } catch (err) {
    lastError = `${inh.method}: ${(err as Error).message}`;
  }
}

export function powerStatus(): PowerStatus {
  const inh = inhibitor('status');
  return { supported: Boolean(inh), method: inh?.method, active: Boolean(child), reason: child ? reason : undefined, error: lastError || undefined };
}
