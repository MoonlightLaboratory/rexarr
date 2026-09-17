#!/usr/bin/env node
/**
 * Bump the Rexarr version. The version has four parts: major.backend.feature.minor
 *
 *   node scripts/bump-version.mjs backend   0.1.5.0 → 0.2.0.0   server / storage / API changes, upgrades that need care
 *   node scripts/bump-version.mjs feature   0.1.5.0 → 0.1.6.0   new features or pages
 *   node scripts/bump-version.mjs minor     0.1.5.0 → 0.1.5.1   fixes, texts, small changes
 *   node scripts/bump-version.mjs major     0.1.5.0 → 1.0.0.0
 *   node scripts/bump-version.mjs 0.2.0.0                       set it explicitly
 *
 * Updates shared/version.ts (the source of truth), the three package.json files (npm keeps the first three
 * parts), the Dockerfile label and the documentation examples, and starts docs/release-notes/<version>.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = ['major', 'backend', 'feature', 'minor'];
const arg = process.argv[2];
if (!arg || arg === '--help') {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
  process.exit(arg ? 0 : 1);
}

const versionFile = path.join(ROOT, 'shared/version.ts');
const current = fs.readFileSync(versionFile, 'utf8').match(/APP_VERSION = '([^']+)'/)[1];
const parts = current.split('.').map(Number);
if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`${current} is not a major.backend.feature.minor version`);

let next;
if (LEVELS.includes(arg)) {
  const i = LEVELS.indexOf(arg);
  next = parts.map((n, j) => (j < i ? n : j === i ? n + 1 : 0)).join('.');
} else if (/^\d+\.\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else {
  throw new Error(`expected one of ${LEVELS.join(', ')} or a version like 0.2.0.0, got "${arg}"`);
}
const npmVersion = next.split('.').slice(0, 3).join('.');

const edits = [
  [versionFile, new RegExp(`APP_VERSION = '${current}'`), `APP_VERSION = '${next}'`],
  [path.join(ROOT, 'Dockerfile'), /ARG REXARR_VERSION=[\d.]+/, `ARG REXARR_VERSION=${next}`],
  [path.join(ROOT, 'distribution/windows/rexarr.iss'), /\/DAppVersion=[\d.]+/, `/DAppVersion=${next}`],
  [path.join(ROOT, '.github/ISSUE_TEMPLATE/bug_report.yml'), /\(e\.g\. [\d.]+\)/, `(e.g. ${next})`],
  ...['package.json', 'server/package.json', 'client/package.json'].map((f) => [path.join(ROOT, f), /"version": "[\d.]+"/, `"version": "${npmVersion}"`]),
];
for (const [file, find, replace] of edits) {
  const text = fs.readFileSync(file, 'utf8');
  if (!find.test(text)) throw new Error(`${path.relative(ROOT, file)}: nothing matched ${find}`);
  fs.writeFileSync(file, text.replace(find, replace));
  console.log(`  ${path.relative(ROOT, file)}`);
}

const notes = path.join(ROOT, 'docs/release-notes', `${next}.md`);
if (!fs.existsSync(notes)) {
  const previous = path.join(ROOT, 'docs/release-notes', `${current}.md`);
  const downloads = fs.existsSync(previous) ? fs.readFileSync(previous, 'utf8').split('## ')[1] : '';
  fs.writeFileSync(
    notes,
    `> [!WARNING]\n> **Rexarr is in beta.** Settings, file layout and the API can still change between releases. Keep backups\n> (System → Backup) and [report what breaks](https://github.com/MoonlightLaboratory/rexarr/issues).\n\n` +
      (downloads ? `## ${downloads.replace(new RegExp(current.replace(/\./g, '\\.'), 'g'), next)}` : '') +
      `## New\n\n- \n\n## Fixes\n\n- \n\n**Full changelog**: [v${current}...v${next}](https://github.com/MoonlightLaboratory/rexarr/compare/v${current}...v${next})\n`,
  );
  console.log(`  ${path.relative(ROOT, notes)} (fill this in)`);
}
console.log(`\nRexarr ${current} → ${next}. Build, commit, push, then run Actions → Release.`);
