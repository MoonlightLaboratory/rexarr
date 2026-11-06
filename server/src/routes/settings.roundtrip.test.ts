import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema } from './settings.js';
import { DEFAULT_SETTINGS } from '../../../shared/presets.js';

/**
 * The settings schema is a second description of the same shape as the Settings type, and three features have now
 * shipped with a field the UI sent and this schema quietly dropped - a saved setting that came back off, with no
 * error anywhere to say why. Saving the defaults has to give the defaults back.
 */
// the defaults carry no API key; one is generated on first run, and the schema rightly insists on a real one
const SAVED = { ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, security: { ...DEFAULT_SETTINGS.general.security, apiKey: 'a'.repeat(32) } } };

const missing = (expected: unknown, actual: unknown, path = ''): string[] => {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) return [];
  if (actual === null || typeof actual !== 'object') return [path || '(root)'];
  const out: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    if (v === undefined) continue;
    const here = path ? `${path}.${k}` : k;
    if (!(k in (actual as Record<string, unknown>))) out.push(here);
    else out.push(...missing(v, (actual as Record<string, unknown>)[k], here));
  }
  return out;
};

test('saving the default settings keeps every one of them', () => {
  const parsed = settingsSchema.safeParse(SAVED);
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
  assert.deepEqual(missing(SAVED, parsed.data), [], 'these settings were dropped on save');
});

test('TheDiscDb episode mapping survives a save', () => {
  const sent = { ...SAVED, thediscdb: { enabled: true, episodeMapping: false, offerToContribute: false } };
  const got = settingsSchema.parse(sent).thediscdb;
  assert.deepEqual(got, { enabled: true, episodeMapping: false, offerToContribute: false });
});
