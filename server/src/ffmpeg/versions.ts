/**
 * Naming two encodes of one film so Plex and Jellyfin show them as versions of a single item rather than as two
 * films that happen to share a name.
 *
 * Both want the same shape: a folder named after the title, and inside it one file per version, each named after
 * the title with the version after a dash.
 *
 *   Blade Runner 2049 (2017)/
 *     Blade Runner 2049 (2017) - 2160p HEVC.mkv
 *     Blade Runner 2049 (2017) - 1080p HEVC.mkv
 *
 * The work is getting the title back out of a file name that has an encode described all over it. Nothing is
 * invented: only tokens that are recognised are removed, and a name that is nothing but tokens is left alone,
 * because a wrong title here puts the file under a heading of its own - the opposite of what this is for.
 */
import type { EncodeDescription } from './naming.js';

/** Release tokens that describe the encode rather than the film. */
const TOKENS = [
  /\b(2160p|1080p|720p|576p|480p|4k|uhd)\b/gi,
  /\b(bluray|blu-ray|bdrip|brrip|dvdrip|dvd|webrip|web-dl|webdl|hdtv|remux)\b/gi,
  /\b(x264|x265|h\.?264|h\.?265|hevc|avc|av1|xvid|divx)\b/gi,
  /\b(hdr10\+?|hdr|dolby\s?vision|dv|sdr|10bit|8bit)\b/gi,
  /\b(truehd|dts-hd|dts|ddp?5\.1|ddp|ac3|eac3|aac|flac|opus|atmos|7\.1|5\.1|2\.0)\b/gi,
  /\b(proper|repack|extended|remastered|imax|uncut|directors?\.?cut)\b/gi,
];

/**
 * The title, as far as it can be told from the file name.
 *
 * A year in brackets is where a title reliably ends, so anything after it goes. Without one, recognised tokens
 * are removed and whatever is left is the title - unless that is nothing, in which case the name stands.
 */
export function titleFromName(base: string): string {
  const dotted = !/\s/.test(base) && (base.match(/\./g)?.length ?? 0) >= 2;
  let s = base;
  // greedy on purpose: "Blade Runner 2049 (2017)" has two year-shaped numbers and the later one is the year
  const year = /^(.*[([]?(?:19|20)\d{2}[)\]]?)(?=[\s._-]|$)/.exec(s);
  if (year?.[1]) s = year[1];
  else {
    for (const t of TOKENS) s = s.replace(t, ' ');
    // a release group trailing after a dash, and anything in brackets that is now empty
    s = s.replace(/[-–]\s*[A-Za-z0-9]+\s*$/, ' ').replace(/[([{]\s*[)\]}]/g, ' ');
  }
  if (dotted) s = s.replace(/\./g, ' ');
  const cleaned = s
    .replace(/[\s._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-–\s]+$/, '');
  return cleaned || base;
}

/** What this particular encode is, as a person would label the version: "2160p HEVC", "1080p AV1". */
export function versionLabel(d: EncodeDescription): string {
  const codec = (d.videoCodec ?? '').toUpperCase().replace(/^LIB/, '');
  const pretty = codec.includes('265') || codec.includes('HEVC') ? 'HEVC' : codec.includes('264') ? 'H.264' : codec.includes('AV1') ? 'AV1' : codec;
  return [d.resolution, pretty].filter(Boolean).join(' ').trim() || 'encode';
}

/**
 * Where a version of this encode belongs: the folder it shares with its other versions, and the name that tells
 * them apart. `undefined` when there is nothing sensible to say, so the caller keeps its ordinary naming.
 */
export function versionPath(base: string, d: EncodeDescription): { folder: string; name: string } | undefined {
  const title = titleFromName(base);
  const label = versionLabel(d);
  if (!title || !label) return undefined;
  return { folder: title, name: `${title} - ${label}` };
}
