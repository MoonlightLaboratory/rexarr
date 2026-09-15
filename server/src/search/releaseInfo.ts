/**
 * Release classification and smart ranking.
 *
 * Every release gets a category (remux › full disc › Blu-ray encode › WEB › HDTV › DVD), tags parsed from the title
 * (HDR10, DV, Atmos, TrueHD, HEVC, 10-bit, Dual audio…) and a score. The score prefers the best source for
 * re-encoding, then whatever the search asked for ("2160p", "dv", "remux"), then availability.
 */
import type { Release, ReleaseCategory, SearchQuery } from '../../../shared/types.js';
import { musicCategory, musicFormatFromText } from '../music/format.js';

const CATEGORY_BASE: Record<ReleaseCategory, number> = { remux: 100, disc: 90, bluray: 55, web: 45, hdtv: 20, dvd: 15, other: 0, hires: 100, cd: 90, mqa: 85, lossy: 40 };
export const CATEGORY_LABEL: Record<ReleaseCategory, string> = { remux: 'Remux', disc: 'Full disc', bluray: 'Blu-ray encode', web: 'WEB', hdtv: 'HDTV', dvd: 'DVD', other: 'Other', hires: 'Hi-res lossless', cd: 'CD-quality lossless', mqa: 'MQA', lossy: 'Lossy' };

const TAGS: [string, RegExp][] = [
  ['DV', /\b(dv|dovi|dolby[\s.-]?vision)\b/i],
  ['HDR10+', /\bhdr10(\+|plus)/i],
  ['HDR', /\bhdr(10)?\b(?!\+)/i],
  ['Atmos', /\batmos\b/i],
  ['TrueHD', /\btrue-?hd\b/i],
  ['DTS:X', /\bdts[\s.-]?x\b/i],
  ['DTS-HD MA', /\bdts[\s.-]?hd([\s.-]?ma)?\b/i],
  ['FLAC', /\bflac\b/i],
  ['LPCM', /\b(l?pcm)\b/i],
  ['DD+', /\b(ddp|dd\+|e-?ac-?3)/i],
  ['AV1', /\bav1\b/i],
  ['HEVC', /\b(hevc|x265|h\.?265)\b/i],
  ['AVC', /\b(avc|x264|h\.?264)\b/i],
  ['VC-1', /\bvc-?1\b/i],
  ['10-bit', /\b10[\s.-]?bit\b/i],
  ['Dual audio', /\b(dual[\s.-]?audio|multi[\s.-]?audio|dual)\b/i],
  ['Multi', /\bmulti\b(?![\s.-]?audio)/i],
  ['Subbed', /\b(multi[\s.-]?subs?|subbed|eng[\s.-]?subs?)\b/i],
  ['Hybrid', /\bhybrid\b/i],
  ['Proper', /\b(proper|repack)\b/i],
];

const LOSSLESS_AUDIO = new Set(['TrueHD', 'DTS:X', 'DTS-HD MA', 'FLAC', 'LPCM']);

export function releaseCategory(r: Pick<Release, 'title' | 'quality' | 'isRemux' | 'isDisc'>): ReleaseCategory {
  const t = r.title ?? '';
  const q = r.quality ?? '';
  if (r.isRemux) return 'remux';
  if (r.isDisc) return 'disc';
  if (/\bweb[\s.-]?(dl|rip)?\b|\b(amzn|nf|dsnp|hmax|atvp|cr|hulu|hidive|adn|b-?global)\b[\s.-]?(web)?/i.test(`${q} ${t}`) && !/blu-?ray|bdrip|brrip/i.test(q)) return 'web';
  if (/blu-?ray|bdrip|brrip|\bbd\b/i.test(`${q} ${t}`)) return 'bluray';
  // Sonarr files unknown-source anime releases under HDTV / SDTV; simulcast groups are really WEB rips.
  if (/\b(hdtv|pdtv|sdtv)\b/i.test(t)) return 'hdtv';
  if (/^\[(subsplease|erai-raws|horriblesubs|subsplus|ember|asw|judas|dkb|toonshub|varyg|tsundere-raws)[^\]]*\]/i.test(t) || /hdtv|sdtv/i.test(q)) return /^\[[^\]]+\]/.test(t) ? 'web' : 'hdtv';
  if (/dvd/i.test(`${q} ${t}`)) return 'dvd';
  return 'other';
}

export function releaseTags(title: string): string[] {
  const tags = TAGS.filter(([, re]) => re.test(title)).map(([name]) => name);
  // "HDR10+" already implies HDR; DTS:X is also DTS-HD MA
  return tags.filter((t) => !(t === 'HDR' && tags.includes('HDR10+')) && !(t === 'DTS-HD MA' && tags.includes('DTS:X')) && !(t === 'Multi' && tags.includes('Dual audio')));
}

export interface ScoreContext {
  query?: SearchQuery;
  /** Music: tracks on the album, to prefer complete folders / releases. */
  expectedTracks?: number;
  /** Episode / season searches: releases that name a different season are pushed down. */
  season?: number;
  /** Anime prefers Japanese audio / dual audio. */
  anime?: boolean;
}

export function scoreRelease(r: Release, ctx: ScoreContext = {}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const add = (n: number, why: string) => {
    if (!n) return;
    score += n;
    reasons.push(`${n > 0 ? '+' : ''}${Math.round(n)} ${why}`);
  };
  let score = 0;
  const cat = r.category ?? releaseCategory(r);
  const tags = r.tags ?? releaseTags(r.title);
  add(CATEGORY_BASE[cat], CATEGORY_LABEL[cat]);

  const res = r.resolution || 0;
  add(res >= 2000 ? 20 : res >= 1000 ? 12 : res >= 700 ? 4 : res ? -10 : 0, res ? `${res}p` : '');
  if (tags.includes('DV')) add(4, 'Dolby Vision');
  if (tags.includes('HDR10+')) add(4, 'HDR10+');
  else if (tags.includes('HDR')) add(3, 'HDR');
  if (tags.some((t) => LOSSLESS_AUDIO.has(t))) add(6, 'lossless audio');
  if (tags.includes('Atmos')) add(2, 'Atmos');
  if (tags.includes('Proper')) add(2, 'proper / repack');

  const w = ctx.query?.wants ?? {};
  if (w.category) add(w.category === cat ? 40 : -25, w.category === cat ? `matches "${CATEGORY_LABEL[w.category]}"` : `not ${CATEGORY_LABEL[w.category]}`);
  if (w.resolution) add(res === w.resolution ? 30 : Math.abs(res - w.resolution) < 200 ? 0 : -20, res === w.resolution ? `matches ${w.resolution}p` : `not ${w.resolution}p`);
  if (w.dolbyVision) add(tags.includes('DV') ? 15 : -10, tags.includes('DV') ? 'has Dolby Vision' : 'no Dolby Vision');
  if (w.hdr) add(tags.some((t) => t.startsWith('HDR') || t === 'DV') ? 12 : -10, 'HDR wanted');
  if (w.atmos) add(tags.includes('Atmos') ? 10 : -5, 'Atmos wanted');
  if (w.codec) add(tags.includes(w.codec === 'hevc' ? 'HEVC' : 'AVC') ? 8 : -4, `${w.codec.toUpperCase()} wanted`);
  if (w.dualAudio) add(tags.includes('Dual audio') || tags.includes('Multi') ? 10 : -5, 'dual audio wanted');

  if (ctx.anime) {
    const jpn = r.languages.some((l) => /japanese/i.test(l)) || /\b(jpn|jap|japanese)\b/i.test(r.title);
    if (tags.includes('Dual audio') || jpn) add(8, 'Japanese / dual audio');
  }

  if (ctx.season !== undefined) {
    const other = releaseSeason(r.title);
    if (other !== undefined && other !== ctx.season) add(-40, `looks like season ${other}`);
  }

  if (r.protocol === 'torrent') {
    const s = r.seeders ?? 0;
    add(s === 0 ? -30 : Math.min(12, Math.log2(s + 1) * 3), s === 0 ? 'no seeders' : `${s} seeders`);
  } else if (r.protocol === 'usenet') add(8, 'usenet');
  if (!r.approved && r.rejections.length) add(-15, `rejected by *arr (${r.rejections[0]})`);
  return { score: Math.round(score), reasons };
}

/** Season named in a release title ("S02E05", "S2 - 05", "2nd Season", "Season 2"), if any. */
export function releaseSeason(title: string): number | undefined {
  const m = title.match(/\bS(\d{1,2})(?:E\d+|\b)|\bseason[\s.]?(\d{1,2})\b|\b(\d)(?:st|nd|rd|th)[\s.]season\b/i);
  if (!m) return undefined;
  return Number(m[1] ?? m[2] ?? m[3]);
}

const isMusic = (r: Release) => r.source === 'lidarr' || r.source === 'soulseek';

/** Music: category, tags and score from the format (title for indexers, file details for Soulseek). */
export function scoreMusicRelease(r: Release, ctx: ScoreContext = {}): { category: ReleaseCategory; tags: string[]; score: number; reasons: string[] } {
  const fromText = musicFormatFromText(`${r.quality} ${r.title}`);
  const f = { ...fromText, format: r.music?.format ?? fromText.format, bitDepth: r.music?.bitDepth ?? fromText.bitDepth, sampleRate: r.music?.sampleRate ?? fromText.sampleRate, bitrate: r.music?.bitrate ?? fromText.bitrate };
  if (r.source === 'soulseek') f.lossless = /^(FLAC|ALAC|WAV|AIFF|APE|WV|DSF|DFF)$/.test(f.format ?? '');
  const category = musicCategory(f);
  const tags = [f.source, f.mqa ? 'MQA' : '', /\blog\b/i.test(r.title) ? 'Log' : '', r.music?.cue || /\bcue\b/i.test(r.title) ? 'Cue' : '', /\b(deluxe|expanded)\b/i.test(r.title) ? 'Deluxe' : '', /\bremaster(ed)?\b/i.test(r.title) ? 'Remaster' : ''].filter(Boolean) as string[];
  const reasons: string[] = [];
  let score = 0;
  const add = (n: number, why: string) => {
    if (!n) return;
    score += n;
    reasons.push(`${n > 0 ? '+' : ''}${Math.round(n)} ${why}`);
  };
  add(CATEGORY_BASE[category], CATEGORY_LABEL[category]);
  if (category === 'hires') add(Math.min(10, ((f.bitDepth ?? 24) > 16 ? 5 : 0) + ((f.sampleRate ?? 48000) > 48000 ? 5 : 0)), `${f.bitDepth ?? '?'} bit / ${(f.sampleRate ?? 0) / 1000 || '?'} kHz`);
  if (category === 'lossy') add(f.bitrate && f.bitrate >= 320 ? 15 : f.bitrate && f.bitrate >= 240 ? 12 : f.bitrate && f.bitrate < 192 ? -15 : 0, f.bitrate ? `${f.bitrate} kbps` : '');
  if (f.source === 'CD' || tags.includes('Log')) add(3, 'CD rip / log');
  const w = ctx.query?.wants ?? {};
  if (w.category) add(w.category === category || (w.category === 'cd' && category === 'hires') ? 40 : -25, w.category === category ? `matches "${CATEGORY_LABEL[w.category]}"` : `not ${CATEGORY_LABEL[w.category]}`);
  const tracks = r.music?.trackCount;
  if (r.music?.cue) add(2, 'image + cue (split for Lidarr)');
  if (ctx.expectedTracks && tracks) add(tracks === ctx.expectedTracks ? 15 : tracks < ctx.expectedTracks ? -25 : 0, tracks === ctx.expectedTracks ? 'complete album' : tracks < ctx.expectedTracks ? `${tracks}/${ctx.expectedTracks} tracks` : '');
  if (r.source === 'soulseek') {
    add(r.music?.freeSlot ? 15 : -5, r.music?.freeSlot ? 'free upload slot' : 'no free slot');
    if (r.music?.queueLength) add(-Math.min(25, r.music.queueLength / 2), `${r.music.queueLength} queued`);
    if (r.music?.uploadSpeed) add(Math.min(10, Math.log2(r.music.uploadSpeed / 50_000 + 1) * 3), `${Math.round(r.music.uploadSpeed / 1024)} KB/s`);
  } else if (r.protocol === 'torrent') {
    const s = r.seeders ?? 0;
    add(s === 0 ? -30 : Math.min(12, Math.log2(s + 1) * 3), s === 0 ? 'no seeders' : `${s} seeders`);
  } else if (r.protocol === 'usenet') add(8, 'usenet');
  if (!r.approved && r.rejections.length) add(-15, `rejected by *arr (${r.rejections[0]})`);
  return { category, tags, score: Math.round(score), reasons };
}

/** Classify, tag and score a list, best first. */
export function rankReleases(list: Release[], ctx: ScoreContext = {}): Release[] {
  for (const r of list) {
    if (isMusic(r)) {
      const m = scoreMusicRelease(r, ctx);
      r.category = m.category;
      r.tags = m.tags;
      r.score = m.score;
      r.scoreReasons = m.reasons;
      continue;
    }
    r.category = releaseCategory(r);
    r.tags = releaseTags(r.title);
    const s = scoreRelease(r, ctx);
    r.score = s.score;
    r.scoreReasons = s.reasons;
  }
  return list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.size - a.size);
}
