import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDefaults } from './settingsDefaults.js';
import { DEFAULT_SETTINGS } from '../../shared/presets.js';

const plainObject = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every key of `expected`, by path, that `got` has not got. */
const missing = (expected: unknown, got: unknown, path = ''): string[] => {
  if (!plainObject(expected)) return [];
  if (!plainObject(got)) return [path];
  const out: string[] = [];
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    if (v === undefined) continue;
    const here = path ? `${path}.${k}` : k;
    if (!(k in (got as Record<string, unknown>))) out.push(here);
    else out.push(...missing(v, (got as Record<string, unknown>)[k], here));
  }
  return out;
};

/**
 * The class of bug this exists for: a settings group gets a new field, the group is not on the merge list, and
 * an install that upgraded carries the old shape until something happens to save it. Nothing complains - the
 * field is just quietly undefined, and reads as off.
 */
test('every nested setting survives an upgrade from a file that has never heard of it', () => {
  // The real shape of the bug: the group is present on disk from an older version, just short a field. A
  // top-level spread then takes the old group whole and the new field never appears. Passing {} for each
  // group in turn is the strongest form of that - if the group is on the merge list its defaults come back,
  // and if it is not, the group arrives empty and every one of its fields is reported here.
  const groups = Object.entries(DEFAULT_SETTINGS).filter(([, v]) => plainObject(v));
  const gaps: string[] = [];
  for (const [key] of groups) {
    gaps.push(...missing((DEFAULT_SETTINGS as Record<string, unknown>)[key], (withDefaults({ [key]: {} } as never) as Record<string, unknown>)[key], key));
  }
  assert.deepEqual(gaps, [], 'these groups are not on the merge list in settingsDefaults.ts, so upgrading loses their new fields');
});

test('a half-filled group keeps what was saved and gains what is new', () => {
  const merged = withDefaults({ fileMetadata: { title: 'none' } as never });
  assert.equal(merged.fileMetadata.title, 'none', 'what the user chose wins');
  assert.equal(merged.fileMetadata.comment, DEFAULT_SETTINGS.fileMetadata.comment, 'and the rest comes from the defaults');
  assert.equal(merged.fileMetadata.cover, false);
});

test('what is on disk is never thrown away', () => {
  const merged = withDefaults({ sonarr: { enabled: true, url: 'http://nas:8989', apiKey: 'k' } });
  assert.deepEqual(merged.sonarr, { enabled: true, url: 'http://nas:8989', apiKey: 'k' });
});
