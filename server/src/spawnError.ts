/** Plain-English reasons an external tool (ffmpeg, freaccmd, makemkvcon) could not be started. */
import path from 'node:path';

export function toolError(err: unknown, toolPath: string): string {
  const e = err as NodeJS.ErrnoException & { message?: string };
  const name = path.basename(toolPath);
  const code = e?.code ?? '';
  const errno = e?.errno;
  const message = e?.message ?? String(err);
  // EBADARCH: an Intel binary on Apple silicon without a working Rosetta (macOS 26+ may no longer provide it)
  if (errno === -86 || code === 'EBADARCH' || /Unknown system error -86|Bad CPU type/i.test(message)) {
    return `${toolPath} was built for a different processor and cannot run on this Mac (Intel binary on Apple silicon). Install the native build – Homebrew on Apple silicon lives in /opt/homebrew – and set the path here.`;
  }
  if (code === 'ENOENT') return `${name} was not found at "${toolPath}"`;
  if (code === 'EACCES') return `${toolPath} is not executable (chmod +x, or macOS blocked it: right-click → Open once)`;
  if (code === 'ETIMEDOUT' || /timed out/i.test(message)) return `${name} did not answer in time (${toolPath})`;
  return message;
}
