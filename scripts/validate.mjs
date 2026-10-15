/**
 * Check every disc entry, and build index.json from them.
 *
 *   node scripts/validate.mjs          check, and rewrite index.json
 *   node scripts/validate.mjs --check  check only, and fail if index.json is out of date (what CI runs)
 *
 * No dependencies on purpose: a database anyone can contribute to should not need an npm install to be checked,
 * and CI that installs nothing cannot be surprised by what it installed. The schema is the documentation; this
 * enforces it, plus the handful of rules a JSON Schema cannot express.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const problems = [];
const fail = (file, message) => problems.push(`${path.relative(ROOT, file)}: ${message}`);

/** Every .json under discs/, in a stable order so the index does not churn. */
function entryFiles(dir = path.join(ROOT, 'discs')) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? entryFiles(path.join(dir, e.name)) : e.name.endsWith('.json') ? [path.join(dir, e.name)] : []));
}

const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema/disc.schema.json'), 'utf8'));

/** Enough of JSON Schema for this one schema: types, enums, required, ranges, patterns and no stray keys. */
function check(value, schema, file, at = '') {
  const where = at || '(root)';
  if (schema.const !== undefined && value !== schema.const) return fail(file, `${where} must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) return fail(file, `${where} must be one of ${schema.enum.join(', ')}`);
  const type = schema.type;
  if (type === 'object' || (!type && schema.properties)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(file, `${where} must be an object`);
    for (const r of schema.required ?? []) if (!(r in value)) fail(file, `${where} is missing "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (!sub) {
        if (schema.additionalProperties === false) fail(file, `${where} has an unknown key "${k}"`);
        continue;
      }
      check(v, sub, file, at ? `${at}.${k}` : k);
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return fail(file, `${where} must be an array`);
    if (schema.minItems && value.length < schema.minItems) fail(file, `${where} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems && value.length > schema.maxItems) fail(file, `${where} allows at most ${schema.maxItems} item(s)`);
    value.forEach((v, i) => schema.items && check(v, schema.items, file, `${where}[${i}]`));
    return;
  }
  if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || (type === 'integer' && !Number.isInteger(value))) return fail(file, `${where} must be ${type === 'integer' ? 'a whole number' : 'a number'}`);
    if (schema.minimum !== undefined && value < schema.minimum) fail(file, `${where} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(file, `${where} must be at most ${schema.maximum}`);
    return;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return fail(file, `${where} must be text`);
    if (schema.minLength && value.length < schema.minLength) fail(file, `${where} is too short`);
    if (schema.maxLength && value.length > schema.maxLength) fail(file, `${where} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(file, `${where} does not look right (${schema.pattern})`);
  }
}

/** The rules a schema cannot state: what makes an entry findable, and self-consistent. */
function sanity(entry, file) {
  const findable = (entry.barcodes?.length ?? 0) + (entry.labels?.length ?? 0) + (entry.fingerprint ? 1 : 0);
  if (!findable) fail(file, 'nothing to recognise the disc by - give it a barcode, a label or a fingerprint');

  if (entry.kind === 'series' && !entry.series?.tvdbId && !entry.series?.tmdbId && !entry.series?.imdbId && !entry.series?.anidbId) {
    fail(file, 'series needs at least one id (tvdbId, tmdbId, imdbId or anidbId) - titles get renamed, ids do not');
  }

  const seen = new Set();
  for (const t of entry.titles ?? []) {
    if (seen.has(t.index)) fail(file, `title ${t.index} is listed twice`);
    seen.add(t.index);
    const says = ['episode', 'episodes', 'special', 'extra', 'playAll'].filter((k) => t[k] !== undefined);
    if (says.length === 0) fail(file, `title ${t.index} says nothing about what it is`);
    if (says.length > 1) fail(file, `title ${t.index} is ${says.join(' and ')} at once; it can only be one`);
  }

  const fp = entry.fingerprint;
  if (fp && fp.durationsSeconds.length !== fp.titleCount) {
    fail(file, `fingerprint says ${fp.titleCount} titles but lists ${fp.durationsSeconds.length} durations`);
  }
  if (fp) {
    const highest = Math.max(-1, ...(entry.titles ?? []).map((t) => t.index));
    if (highest >= fp.titleCount) fail(file, `title ${highest} is listed, but the fingerprint only has ${fp.titleCount} titles`);
  }

  // an episode on two titles of the same disc is nearly always a mistake, and a play-all title mislabelled
  const episodes = (entry.titles ?? []).flatMap((t) => (t.episode !== undefined ? [t.episode] : (t.episodes ?? [])));
  const twice = episodes.filter((e, i) => episodes.indexOf(e) !== i);
  if (twice.length) fail(file, `episode ${[...new Set(twice)].join(', ')} is on two titles - is one of them a play-all?`);
}

const files = entryFiles();
const index = [];
for (const file of files) {
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(file, `not valid JSON - ${err.message}`);
    continue;
  }
  const before = problems.length;
  check(entry, SCHEMA, file);
  sanity(entry, file);
  if (problems.length !== before) continue;
  index.push({
    path: path.relative(ROOT, file),
    kind: entry.kind,
    title: entry.kind === 'series' ? entry.series.title : entry.movie.title,
    year: (entry.kind === 'series' ? entry.series.year : entry.movie.year) ?? undefined,
    ids: entry.kind === 'series' ? entry.series : entry.movie,
    season: entry.season,
    disc: entry.disc,
    barcodes: entry.barcodes ?? [],
    labels: entry.labels ?? [],
    fingerprint: entry.fingerprint,
  });
}

const generated = `${JSON.stringify({ schema: 1, entries: index.length, discs: index }, null, 2)}\n`;
const indexPath = path.join(ROOT, 'index.json');
const current = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
if (checkOnly) {
  if (current !== generated) problems.push('index.json is out of date - run `node scripts/validate.mjs` and commit the result');
} else if (current !== generated) {
  fs.writeFileSync(indexPath, generated);
  console.log(`index.json rewritten (${index.length} disc${index.length === 1 ? '' : 's'})`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`${files.length} disc${files.length === 1 ? '' : 's'}, all good.`);
