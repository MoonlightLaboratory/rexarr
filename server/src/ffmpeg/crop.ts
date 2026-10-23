/**
 * Letterbox detection: measure the black bars, and crop them off during the encode.
 *
 * The measuring is ffmpeg's `cropdetect`, which reports the smallest rectangle holding anything that is not
 * black. The judgement is here, and it is mostly about when *not* to crop:
 *
 * - A film whose aspect ratio changes partway through - an IMAX sequence, an open-matte insert - measures
 *   differently in different places. Cropping to one measurement throws away picture in the others, and it is
 *   the kind of damage nobody notices until the scene arrives. Samples that disagree mean no crop.
 * - A dark scene measures as mostly bar. Sampling across the file rather than the first minute is what stops a
 *   fade-in deciding the whole film.
 * - A few pixels are not letterboxing. Cropping them re-encodes the picture for nothing and can break a player's
 *   idea of the aspect ratio, so anything under a threshold is left alone.
 */

export interface CropBox {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface CropDecision {
  crop?: CropBox;
  /** Why it did or did not crop, for the encode summary and the log. */
  reason: string;
}

/** `crop=1920:800:0:140` as cropdetect prints it. */
export function parseCropLine(line: string): CropBox | null {
  const m = /crop=(\d+):(\d+):(-?\d+):(-?\d+)/.exec(line);
  if (!m) return null;
  const [w, h, x, y] = m.slice(1, 5).map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || x < 0 || y < 0) return null;
  return { width: w, height: h, x, y };
}

/** Every crop cropdetect suggested, in the order it suggested them. */
export function parseCropOutput(stderr: string): CropBox[] {
  const out: CropBox[] = [];
  for (const line of stderr.split('\n')) {
    const box = parseCropLine(line);
    if (box) out.push(box);
  }
  return out;
}

export interface CropOptions {
  /** Below this many pixels removed in total, cropping is not worth doing. */
  minBars?: number;
  /** How far two samples may differ and still count as the same crop. */
  tolerance?: number;
}

/**
 * What to do about the bars, given what the samples saw.
 *
 * The samples are grouped by what they measured; the crop has to be both the most common answer and a large
 * majority, because "most of the film is 2.39:1" is not a reason to crop the part that is not.
 */
export function decideCrop(samples: CropBox[], source: { width: number; height: number }, opts: CropOptions = {}): CropDecision {
  const minBars = opts.minBars ?? 10;
  const tolerance = opts.tolerance ?? 4;
  const usable = samples.filter((s) => s.width > 0 && s.height > 0 && s.width <= source.width && s.height <= source.height);
  if (usable.length < 3) return { reason: 'not enough of the file could be measured' };

  // group samples that agree to within the tolerance; the biggest group is the candidate
  const groups: { box: CropBox; count: number }[] = [];
  for (const s of usable) {
    const hit = groups.find((g) => Math.abs(g.box.width - s.width) <= tolerance && Math.abs(g.box.height - s.height) <= tolerance);
    if (hit) hit.count++;
    else groups.push({ box: s, count: 1 });
  }
  groups.sort((a, b) => b.count - a.count);
  const best = groups[0];
  const agreement = best.count / usable.length;
  if (agreement < 0.8) {
    return { reason: `the picture changes shape during the file (${groups.length} different sizes measured) – cropping would cut into the wider parts` };
  }

  const removed = source.width - best.box.width + (source.height - best.box.height);
  if (removed < minBars) return { reason: 'no letterboxing worth removing' };

  // crop to even numbers: an odd width or offset is invalid for most encoders in 4:2:0
  const box: CropBox = {
    width: best.box.width - (best.box.width % 2),
    height: best.box.height - (best.box.height % 2),
    x: best.box.x - (best.box.x % 2),
    y: best.box.y - (best.box.y % 2),
  };
  const bars: string[] = [];
  if (source.height - box.height >= minBars) bars.push(`${source.height - box.height}px top and bottom`);
  if (source.width - box.width >= minBars) bars.push(`${source.width - box.width}px either side`);
  return { crop: box, reason: `${bars.join(', ') || `${removed}px`} of black removed (${box.width}×${box.height})` };
}

/** The filter cropdetect needs, sampling a frame every few seconds from a given point. */
export function cropdetectArgs(input: string, startSeconds: number, seconds: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-ss', String(Math.max(0, Math.round(startSeconds))),
    '-t', String(seconds),
    '-i', input,
    '-vf', 'fps=1,cropdetect=limit=24:round=2:reset=0',
    '-an', '-sn', '-dn',
    '-f', 'null',
    '-',
  ];
}

/** Where to take samples from, avoiding the credits at either end. */
export function samplePoints(durationSeconds: number, count = 5): number[] {
  const usable = Math.max(0, durationSeconds - 60);
  if (usable < 30) return [0];
  // skip the first 5% and the last 10%: logos at the start and credits at the end are not the picture
  const from = durationSeconds * 0.05;
  const to = durationSeconds * 0.9;
  const step = (to - from) / count;
  return Array.from({ length: count }, (_, i) => Math.round(from + step * i));
}

/** A crop typed in by hand, as `width:height:x:y`. */
export function parseManualCrop(value: string): CropBox | null {
  const m = /^\s*(\d+):(\d+):(\d+):(\d+)\s*$/.exec(value);
  if (!m) return null;
  const [width, height, x, y] = m.slice(1, 5).map(Number);
  return width > 0 && height > 0 ? { width, height, x, y } : null;
}

/** `crop=w:h:x:y`, the filter itself. */
export function cropFilter(box: CropBox): string {
  return `crop=${box.width}:${box.height}:${box.x}:${box.y}`;
}

/**
 * Measure the file and decide. Runs ffmpeg a handful of times over a few seconds each, which costs a second or
 * two rather than a pass over the whole file.
 */
export async function detectCrop(
  ffmpegPath: string,
  input: string,
  source: { width: number; height: number; durationSeconds: number },
  run: (args: string[]) => Promise<string>,
): Promise<CropDecision> {
  const points = samplePoints(source.durationSeconds);
  const boxes: CropBox[] = [];
  for (const at of points) {
    const stderr = await run(cropdetectArgs(input, at, 4)).catch(() => '');
    boxes.push(...parseCropOutput(stderr));
  }
  return decideCrop(boxes, source);
}
