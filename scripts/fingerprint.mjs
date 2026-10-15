/**
 * The RexDB fingerprint, exactly as FINGERPRINT.md defines it. One implementation, used by the checker and by
 * anything else that needs it, so there is nowhere for two versions of the rule to drift apart.
 *
 *   node scripts/fingerprint.mjs "SERIES_VOL_2" 00001.mpls=1416 00002.mpls=1418
 */
import crypto from 'node:crypto';

/** The volume label as it goes into the hash: letters and digits, uppercase, nothing else. */
export function normaliseLabel(label) {
  return String(label ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * @param {string} label the volume label as the drive reported it
 * @param {{ key: string, seconds: number }[]} titles in the order the disc lists them
 */
export function fingerprint(label, titles) {
  const lines = titles.map((t) => `${String(t.key).toLowerCase()}=${Math.trunc(t.seconds)}`);
  const payload = ['rexdb1', normaliseLabel(label), ...lines].join('\n');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [label, ...pairs] = process.argv.slice(2);
  if (!label || !pairs.length) {
    console.error('usage: node scripts/fingerprint.mjs "<volume label>" <key>=<seconds> [<key>=<seconds> ...]');
    process.exit(2);
  }
  const titles = pairs.map((p) => {
    const [key, seconds] = p.split('=');
    return { key, seconds: Number(seconds) };
  });
  console.log(fingerprint(label, titles));
}
