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

/** Pull a resolution (height) out of a quality name like "Remux-2160p". */
export function resolutionFromQuality(qualityName: string | undefined | null, fallback = 0): number {
  const m = qualityName?.match(/(\d{3,4})p/);
  return m ? Number(m[1]) : fallback;
}
