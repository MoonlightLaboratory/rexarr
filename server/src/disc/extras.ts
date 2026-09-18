/** Specials and extras on a disc: guessing what short titles are, and naming them. */
import type { DiscTitle, ExtraType, TitleRole } from '../../../shared/types.js';

const LABEL: Record<Exclude<ExtraType, 'custom' | 'none'>, string> = { op: 'OP', ed: 'ED', extra: 'Extra', ova: 'OVA', special: 'Special' };

/** Creditless openings and endings run about 1:30; anything else short is a generic extra. */
export function guessExtraRoles(titles: DiscTitle[]): Record<string, TitleRole> {
  const out: Record<string, TitleRole> = {};
  let songs = 0;
  for (const t of titles) {
    if (!t.short) continue;
    if (t.durationSeconds >= 60 && t.durationSeconds <= 150) {
      // discs list the creditless OP before the ED
      out[String(t.id)] = { kind: 'extra', type: songs % 2 === 0 ? 'op' : 'ed' };
      songs++;
    } else out[String(t.id)] = { kind: 'extra', type: 'extra' };
  }
  return out;
}

export function extraLabel(role: Extract<TitleRole, { kind: 'extra' }>, title: Pick<DiscTitle, 'name'>): string {
  if (role.type === 'custom') return role.name?.trim() || 'Extra';
  if (role.type === 'none') return title.name;
  return LABEL[role.type];
}

/**
 * File name for an extra, e.g. "My Teen Romantic Comedy SNAFU - S02 - OP 1.mkv". Numbered when a label is used more
 * than once on the disc.
 */
export function extraFileName(show: string, seasonNumber: number | undefined, label: string, index: number, total: number): string {
  const season = seasonNumber !== undefined ? ` - S${String(seasonNumber).padStart(2, '0')}` : '';
  const clean = label.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Extra';
  return `${show}${season} - ${clean}${total > 1 ? ` ${index}` : ''}.mkv`;
}
