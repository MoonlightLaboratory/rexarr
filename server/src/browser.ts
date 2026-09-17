/** Open a URL in the desktop's default browser (release packages launched with --browser). */
import { spawn } from 'node:child_process';

export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => console.log(`[Rexarr] open ${url} in your browser`));
    child.unref();
  } catch {
    console.log(`[Rexarr] open ${url} in your browser`);
  }
}
