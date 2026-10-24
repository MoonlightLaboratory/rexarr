/**
 * What a drive can read, and what that means for a disc that will not play ball.
 *
 * MakeMKV names a drive after the best format it writes - "DVD+R-DL TSSTcorp DVD+-RW TS-L633J", "BD-RE HL-DT-ST
 * WH16NS40" - which tells us one thing for certain and one thing not at all:
 *
 * - **Certain**: a drive with no Blu-ray in its name cannot read a Blu-ray, never mind a UHD one. That is worth
 *   saying outright, because "no titles found" sends people looking for a MakeMKV key when the drive was never
 *   going to read the disc.
 * - **Not at all**: whether a Blu-ray drive can read *UHD*. That depends on its firmware, and a drive that can
 *   is usually one that has been deliberately kept on an older version. Nothing in the name says so, so Rexarr
 *   does not pretend to know - it says what the requirement is and points at the list MakeMKV's forum keeps.
 *
 * Guessing the second one from a model list was the alternative, and a wrong "your drive cannot do this" is
 * worse than no answer: it stops someone trying the thing that would have worked.
 */
import type { DiscDrive } from '../../../shared/types.js';

export type DriveReads = 'bluray' | 'dvd' | 'cd' | 'unknown';

/** Where the UHD drive list lives. Not linked deeper than the forum, because thread ids move. */
export const MAKEMKV_FORUM = 'https://forum.makemkv.com/';

/**
 * The best format this drive reads, from the name MakeMKV gives it.
 *
 * A Blu-ray drive reads DVDs too, so this is the ceiling rather than a list.
 */
export function driveReads(name: string): DriveReads {
  const n = (name ?? '').toLowerCase();
  if (!n.trim()) return 'unknown';
  if (/\b(bd|blu-?ray)\b|bd-?r|bd-?re|bd-?rom|uhd/.test(n)) return 'bluray';
  if (/\bdvd/.test(n)) return 'dvd';
  if (/\bcd\b|cd-?r|cd-?rw/.test(n)) return 'cd';
  return 'unknown';
}

/** "Blu-ray", "DVD", for saying out loud. */
export function readsLabel(reads: DriveReads): string {
  return reads === 'bluray' ? 'Blu-ray' : reads === 'dvd' ? 'DVD' : reads === 'cd' ? 'CD' : '';
}

/**
 * What to say about a disc that would not read in this drive, when the drive itself is the likely reason.
 *
 * Returns nothing when the drive is not the obvious culprit, so this only ever adds to an explanation rather
 * than replacing one that is already better.
 */
export function driveNote(
  drive: Pick<DiscDrive, 'name'> | undefined,
  discType: 'bluray' | 'dvd' | 'cd' | 'unknown',
): { text: string; decisive: boolean } | undefined {
  const reads = driveReads(drive?.name ?? '');
  const model = (drive?.name ?? '').trim();
  if (reads === 'dvd' && discType === 'bluray') {
    // Decisive: there is nothing else to try, so the usual list of other causes would only mislead.
    return {
      text: `${model || 'That drive'} reads DVDs only – it cannot read a Blu-ray at all, so no key or firmware will help. Use a Blu-ray drive.`,
      decisive: true,
    };
  }
  if (reads === 'bluray' && discType === 'bluray') {
    // The disc read as Blu-ray and still gave nothing. UHD is the usual reason, and it is a firmware matter -
    // but only a possibility, so the other causes are still worth listing after it.
    return {
      text: `If this is a 4K UHD disc, the drive needs firmware that can read it – most cannot, and the ones that can are usually on a deliberately older version. MakeMKV's forum keeps the list of which drives work: ${MAKEMKV_FORUM}`,
      decisive: false,
    };
  }
  return undefined;
}
