/**
 * Blu-ray remux detection. Radarr names qualities "Remux-1080p"/"Remux-2160p";
 * Sonarr names them "Bluray-1080p Remux"/"Bluray-2160p Remux". Release titles
 * from indexers use REMUX, Remux, BDRemux, BD-Remux, etc.
 */
const TITLE_RE = /\b(bd[\s._-]?remux|remux)\b/i;

export function isRemuxQuality(qualityName: string | undefined | null): boolean {
  return Boolean(qualityName && /remux/i.test(qualityName));
}

export function isRemuxTitle(title: string | undefined | null): boolean {
  return Boolean(title && TITLE_RE.test(title));
}

export function isRemux(title?: string | null, qualityName?: string | null): boolean {
  return isRemuxQuality(qualityName) || isRemuxTitle(title);
}

/**
 * Full-disc releases: Blu-ray / UHD ISOs and BDMV folders ("COMPLETE.BLURAY", BD25 / BD50 / BD66 / BD100, BR-DISK)
 * and DVD images (DVD5 / DVD9 / DVDR / VIDEO_TS / "DVD ISO"). A remux of a disc is not a disc.
 */
const BLURAY_DISC_RE = /\b(complete[\s._-]*(uhd[\s._-]*)?blu-?ray|bd[\s._-]?(25|50|66|100)|bd[\s._-]?iso|blu-?ray[\s._-]?iso|bdmv|br-?disk|uhd[\s._-]?bd(?!rip)|m2ts[\s._-]?disc)\b/i;
const DVD_DISC_RE = /\b(dvd[\s._-]?(5|9)|dvd-?r|full[\s._-]?dvd|video_ts|dvd[\s._-]?iso|pal[\s._-]?dvd|ntsc[\s._-]?dvd)\b/i;
const ISO_RE = /\b(iso|img)\b/i;

export type DiscFormat = 'uhd' | 'bluray' | 'dvd';

export function detectDisc(title?: string | null, qualityName?: string | null, resolution = 0): { isDisc: boolean; format?: DiscFormat } {
  const t = title ?? '';
  if (isRemux(t, qualityName)) return { isDisc: false };
  if (/rip\b|web-?dl|webrip|hdtv/i.test(t) && !/br-?disk/i.test(qualityName ?? '')) return { isDisc: false };
  const uhd = resolution >= 2000 || /\b(2160p|uhd|4k)\b/i.test(t);
  if (/br-?disk/i.test(qualityName ?? '') || BLURAY_DISC_RE.test(t) || (ISO_RE.test(t) && /blu-?ray|\bbd\b|uhd/i.test(t))) return { isDisc: true, format: uhd ? 'uhd' : 'bluray' };
  if (DVD_DISC_RE.test(t) || (ISO_RE.test(t) && /\bdvd\b/i.test(t))) return { isDisc: true, format: 'dvd' };
  return { isDisc: false };
}

/** Pull a resolution (height) out of a quality name like "Remux-2160p". */
export function resolutionFromQuality(qualityName: string | undefined | null, fallback = 0): number {
  const m = qualityName?.match(/(\d{3,4})p/);
  return m ? Number(m[1]) : fallback;
}
