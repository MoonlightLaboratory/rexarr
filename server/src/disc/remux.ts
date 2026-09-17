/** Stream-copy remux of a ripped title, keeping only the chosen audio tracks (no re-encode). */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function keepAudioTracks(ffmpeg: string, file: string, keep: number[]): Promise<void> {
  if (!keep.length) return;
  const tmp = path.join(path.dirname(file), `.${path.basename(file, '.mkv')}.audio.mkv`);
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', file, '-map', '0:v', ...keep.flatMap((i) => ['-map', `0:a:${i}`]), '-map', '0:s?', '-map', '0:t?', '-c', 'copy', '-map_chapters', '0', tmp];
  try {
    await run(ffmpeg, args, { timeout: 60 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    if (!fs.existsSync(tmp) || !fs.statSync(tmp).size) throw new Error('remux produced no output');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
