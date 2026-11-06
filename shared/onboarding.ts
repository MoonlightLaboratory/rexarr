/**
 * The first-run window: which step comes next, and what finishing it is allowed to write.
 *
 * The writing is the part worth keeping out of the component. The window edits a copy of the whole settings
 * object and PUTs it back, so a careless patch there would quietly save every other setting as whatever the
 * window happened to be holding. `applyDraft` is the one place that decides what a trip through the window may
 * change - three fields - and a test diffs the whole object to prove nothing else moved.
 */
import type { Settings } from './types.js';

export type OnboardingStep = 'tools' | 'apps' | 'folders';

export const ONBOARDING_STEPS: OnboardingStep[] = ['tools', 'apps', 'folders'];

export const STEP_LABEL: Record<OnboardingStep, string> = { tools: 'Tools', apps: 'Apps', folders: 'Folders' };

/** What the window is holding: the apps it asks about, and where rips land. */
export interface OnboardingDraft {
  sonarr: { url: string; apiKey: string };
  radarr: { url: string; apiKey: string };
  ripDirectory: string;
}

export function stepAfter(s: OnboardingStep): OnboardingStep | null {
  return ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(s) + 1] ?? null;
}

export function stepBefore(s: OnboardingStep): OnboardingStep | null {
  const i = ONBOARDING_STEPS.indexOf(s);
  return i > 0 ? ONBOARDING_STEPS[i - 1] : null;
}

/**
 * Whether to open it over whatever page you landed on. Only once per install: `dismissed` is set by finishing
 * or skipping. Until the tools check answers we know nothing, and opening on a guess flashes a modal over the
 * app and closes it again, so nothing is the right answer.
 */
export function shouldOpenOnboarding(setup: { dismissed: boolean } | null | undefined): boolean {
  return setup ? !setup.dismissed : false;
}

export function draftFrom(s: Settings): OnboardingDraft {
  return {
    sonarr: { url: s.sonarr.url, apiKey: s.sonarr.apiKey },
    radarr: { url: s.radarr.url, apiKey: s.radarr.apiKey },
    ripDirectory: s.disc.ripDirectory,
  };
}

/** An app counts as set up when both halves are there; a URL with no key is not a connection. */
const connected = (c: { url: string; apiKey: string }) => Boolean(c.url.trim() && c.apiKey.trim());

/**
 * The settings to save, with only what the window asked about changed. An app left blank is left exactly as it
 * was rather than switched on empty - skipping a step must not turn a connection on with nothing in it.
 */
export function applyDraft(s: Settings, draft: OnboardingDraft): Settings {
  const app = (was: Settings['sonarr'], now: { url: string; apiKey: string }) =>
    connected(now) ? { ...was, enabled: true, url: now.url.trim(), apiKey: now.apiKey.trim() } : was;
  return {
    ...s,
    sonarr: app(s.sonarr, draft.sonarr),
    radarr: app(s.radarr, draft.radarr),
    disc: { ...s.disc, ripDirectory: draft.ripDirectory },
  };
}
