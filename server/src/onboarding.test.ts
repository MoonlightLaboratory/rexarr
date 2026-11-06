import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDraft, draftFrom, shouldOpenOnboarding, stepAfter, stepBefore, ONBOARDING_STEPS } from '../../shared/onboarding.js';
import { DEFAULT_SETTINGS } from '../../shared/presets.js';
import type { Settings } from '../../shared/types.js';

const settings = () => structuredClone(DEFAULT_SETTINGS) as unknown as Settings;

/** Every path where two settings objects differ, as "a.b.c: old -> new". */
const changes = (a: unknown, b: unknown, p = ''): string[] => {
  if (a === b) return [];
  const obj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!obj(a) || !obj(b)) return [`${p}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
    out.push(...changes((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], p ? `${p}.${k}` : k));
  }
  return out;
};

test('the steps go forwards and backwards and then stop', () => {
  assert.deepEqual(ONBOARDING_STEPS, ['tools', 'apps', 'folders']);
  assert.equal(stepAfter('tools'), 'apps');
  assert.equal(stepAfter('apps'), 'folders');
  assert.equal(stepAfter('folders'), null, 'the last step has no next - that is what makes the button say Finish');
  assert.equal(stepBefore('tools'), null);
  assert.equal(stepBefore('folders'), 'apps');
});

test('the window opens once, on an install that has not seen it', () => {
  assert.equal(shouldOpenOnboarding({ dismissed: false }), true);
  assert.equal(shouldOpenOnboarding({ dismissed: true }), false);
  // the tools check may not have answered yet, and a wrong guess here flashes a modal over the app
  assert.equal(shouldOpenOnboarding(null), false);
});

test('finishing writes the three things it asked about and nothing else', () => {
  const before = settings();
  const draft = { ...draftFrom(before), sonarr: { url: 'http://nas:8989', apiKey: 'k1' }, radarr: { url: 'http://nas:7878', apiKey: 'k2' }, ripDirectory: '/mnt/rips' };
  assert.deepEqual(changes(before, applyDraft(before, draft)).sort(), [
    'disc.ripDirectory: "" -> "/mnt/rips"',
    'radarr.apiKey: "" -> "k2"',
    'radarr.enabled: false -> true',
    'radarr.url: "http://localhost:7878" -> "http://nas:7878"',
    'sonarr.apiKey: "" -> "k1"',
    'sonarr.enabled: false -> true',
    'sonarr.url: "http://localhost:8989" -> "http://nas:8989"',
  ]);
});

test('an app left blank is left alone rather than switched on empty', () => {
  const before = settings();
  const draft = { ...draftFrom(before), sonarr: { url: 'http://nas:8989', apiKey: 'k1' } };
  const after = applyDraft(before, draft);
  assert.equal(after.radarr.enabled, false, 'skipping Radarr must not enable a connection with no URL');
  assert.deepEqual(after.radarr, before.radarr);
  // a URL with no key is not a connection either
  const half = applyDraft(before, { ...draftFrom(before), radarr: { url: 'http://nas:7878', apiKey: '' } });
  assert.equal(half.radarr.enabled, false);
});

test('an app already set up is not disturbed by a trip through the window', () => {
  const before = settings();
  before.sonarr = { enabled: true, url: 'http://nas:8989', apiKey: 'already' };
  before.disc.ripDirectory = '/mnt/rips';
  assert.deepEqual(changes(before, applyDraft(before, draftFrom(before))), [], 'opening and finishing without typing changes nothing');
});

test('the rip folder can be emptied back to the default', () => {
  const before = settings();
  before.disc.ripDirectory = '/mnt/rips';
  assert.equal(applyDraft(before, { ...draftFrom(before), ripDirectory: '' }).disc.ripDirectory, '');
});
