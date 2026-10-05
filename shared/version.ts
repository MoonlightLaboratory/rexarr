/**
 * Rexarr version shown in the UI, logs, System → Status and the MusicBrainz user agent.
 * major.backend.feature.minor – bump it with `node scripts/bump-version.mjs <level>`
 * (package.json keeps the first three parts: npm versions have three).
 */
export const APP_VERSION = '0.1.7.1';

/** Source, releases and issues. */
export const REPO_URL = 'https://github.com/MoonlightLaboratory/rexarr';

/** The documentation site, built from docs/ (the Help button in the header). */
export const DOCS_URL = 'https://moonlightlaboratory.github.io/rexarr';
