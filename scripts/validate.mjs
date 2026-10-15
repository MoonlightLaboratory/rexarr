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
import { fingerprint } from './fingerprint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const problems = [];
const fail = (file, message) => problems.push(`${path.relative(ROOT, file)}: ${message}`);

/** Every .json under discs/ and pending/, in a stable order so the index does not churn. */
function entryFiles(dir) {
  if (dir === undefined) return [...entryFiles(path.join(ROOT, 'discs')), ...entryFiles(path.join(ROOT, 'pending'))];
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

/** The rules a schema cannot state: that the key is really the key, and the mapping is self-consistent. */
function sanity(entry, file) {
  const pending = entry.status === 'pending';

  if (!entry.series?.tvdb && !entry.series?.tmdb && !entry.series?.anidb && !entry.series?.imdb) {
    fail(file, 'series needs at least one id (tvdb, tmdb, anidb or imdb) - titles get renamed, ids do not');
  }

  if (!pending) {
    // The fingerprint is the key, so it is recomputed rather than believed. A typo here is a disc that is never
    // found, or worse, one that is found and is not the disc you have.
    const computed = fingerprint(entry.disc_name, entry.structure.titles);
    if (computed !== entry.fingerprint) fail(file, `fingerprint is ${entry.fingerprint} but this disc_name and structure hash to ${computed}`);

    if (entry.structure.titles.length !== entry.structure.titleCount) {
      fail(file, `structure says ${entry.structure.titleCount} titles but lists ${entry.structure.titles.length}`);
    }
    const keys = entry.structure.titles.map((t) => t.key);
    if (new Set(keys).size !== keys.length) fail(file, 'two titles in structure share a key');
    for (const key of Object.keys(entry.titles)) {
      if (!keys.includes(key)) fail(file, `titles has "${key}", which is not a title in structure`);
    }
    const base = path.basename(file, '.json');
    if (base !== entry.fingerprint) fail(file, `file should be named ${entry.fingerprint}.json, after the fingerprint it is keyed by`);
  } else {
    if (entry.fingerprint || entry.structure) fail(file, 'a pending entry has no fingerprint yet - that is what makes it pending');
    if (path.basename(path.dirname(file)) !== 'pending') fail(file, 'pending entries live in pending/');
  }

  if (!pending && path.basename(path.dirname(file)) !== entry.fingerprint.slice(0, 2)) {
    fail(file, `should be in discs/${entry.fingerprint.slice(0, 2)}/, the first two characters of its fingerprint`);
  }

  // an episode on two titles of one disc is nearly always a play-all that was not marked as one
  const seen = new Map();
  for (const [key, what] of Object.entries(entry.titles)) {
    if (!/^S\d{1,3}E/.test(what)) continue;
    if (seen.has(what)) fail(file, `${what} is on both "${seen.get(what)}" and "${key}" - is one of them a play-all?`);
    seen.set(what, key);
  }

  if (entry.status === 'verified' && (entry.confirmations ?? 1) < 2) {
    fail(file, 'verified needs at least two submissions that agree; one is unverified');
  }
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
    status: entry.status,
    fingerprint: entry.fingerprint,
    disc_name: entry.disc_name,
    also_known_as: entry.also_known_as ?? [],
    barcodes: entry.barcodes ?? [],
    series: entry.series,
    disc: entry.disc,
    release: entry.release,
    structure: entry.structure,
    confirmations: entry.confirmations,
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
