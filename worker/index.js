/**
 * RexDB's submission service.
 *
 * Rexarr posts a disc here; this checks it and opens a pull request against the RexDB branch. The point of it
 * existing at all is that a contributor needs no GitHub account and Rexarr needs to hold no token: this has one,
 * and it is the only thing that does.
 *
 * It decides nothing about what is true. Every submission becomes a pull request for a person to look at, and
 * CI runs the same validator on it that a hand-written entry gets. A service that wrote straight to the branch
 * would be a service that could be made to write anything.
 *
 *   wrangler secret put GITHUB_TOKEN     a fine-grained token, contents:write on this repo and nothing else
 *   wrangler deploy
 */
const REPO = 'MoonlightLaboratory/rexarr';
const BRANCH = 'RexDB';
const UA = 'rexdb-submit';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });

/** The same rules the validator enforces, applied before anything is written. */
function problems(entry) {
  const out = [];
  const is = (v, t) => typeof v === t;
  if (entry?.schema !== 1) out.push('schema must be 1');
  if (!is(entry?.fingerprint, 'string') || !/^[0-9a-f]{16}$/.test(entry.fingerprint)) out.push('fingerprint must be 16 hex characters');
  if (!is(entry?.disc_name, 'string') || !entry.disc_name.trim()) out.push('disc_name is required');
  const ids = ['tvdb', 'tmdb', 'anidb', 'imdb'].some((k) => entry?.series?.[k]);
  if (!ids) out.push('series needs at least one id');
  const titles = entry?.structure?.titles;
  if (!Array.isArray(titles) || !titles.length) out.push('structure.titles is required');
  else if (titles.length !== entry.structure.titleCount) out.push('structure.titleCount does not match');
  if (!entry?.titles || !Object.keys(entry.titles).length) out.push('titles is required');
  for (const v of Object.values(entry?.titles ?? {})) {
    if (!/^(S\d{1,3}E\d{1,4}(-E\d{1,4})?|extra(:(op|ed|trailer|interview|featurette|other))?|playall|skip)$/.test(String(v))) out.push(`"${v}" is not a title value`);
  }
  if (JSON.stringify(entry ?? {}).length > 20000) out.push('entry is implausibly large');
  return out;
}

/** The fingerprint recomputed here, so a submission cannot claim to be a disc it is not. */
async function fingerprintOf(entry) {
  const label = String(entry.disc_name).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const lines = entry.structure.titles.map((t) => `${String(t.key).toLowerCase()}=${Math.trunc(t.seconds)}`);
  const payload = ['rexdb1', label, ...lines].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const gh = (token, path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': UA, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' } });
    }
    if (request.method !== 'POST') return json(405, { error: 'POST an entry' });
    if (!env.GITHUB_TOKEN) return json(503, { error: 'this service has no token configured' });

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: 'not JSON' });
    }
    const entry = body?.entry;
    const bad = problems(entry);
    if (bad.length) return json(400, { error: bad.join('; ') });

    const computed = await fingerprintOf(entry);
    if (computed !== entry.fingerprint) return json(400, { error: `fingerprint is ${entry.fingerprint} but this disc hashes to ${computed}` });

    const path = `discs/${computed.slice(0, 2)}/${computed}.json`;
    const token = env.GITHUB_TOKEN;

    // already there and saying the same thing: nothing to open a pull request about
    const existing = await gh(token, `/repos/${REPO}/contents/${path}?ref=${BRANCH}`);
    if (existing.ok) {
      const file = await existing.json();
      const current = JSON.parse(atob(file.content.replace(/\n/g, '')));
      if (JSON.stringify(current.titles) === JSON.stringify(entry.titles)) {
        return json(200, { ok: true, status: 'already known', url: file.html_url });
      }
    }

    // a branch of its own, so nothing lands without review
    const head = await gh(token, `/repos/${REPO}/git/ref/heads/${BRANCH}`).then((r) => r.json());
    const branch = `rexdb/${computed}-${Date.now().toString(36)}`;
    const made = await gh(token, `/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }) });
    if (!made.ok) return json(502, { error: `could not branch: ${await made.text()}` });

    const content = btoa(`${JSON.stringify(entry, null, 2)}\n`);
    const put = await gh(token, `/repos/${REPO}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({ message: `RexDB: ${entry.disc_name}`, content, branch, ...(existing.ok ? { sha: (await existing.clone().json()).sha } : {}) }),
    });
    if (!put.ok) return json(502, { error: `could not write: ${await put.text()}` });

    const pr = await gh(token, `/repos/${REPO}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: `RexDB: ${entry.disc_name}`,
        head: branch,
        base: BRANCH,
        body: [
          `Submitted by \`${String(body.client ?? 'unknown').slice(0, 40)}\`, read off the disc in a drive.`,
          '',
          `Fingerprint \`${computed}\` · ${Object.keys(entry.titles).length} titles · ${entry.series?.title ?? '?'}${entry.disc ? `, disc ${entry.disc}` : ''}`,
          '',
          'The checker runs on this like any other change. Someone still has to agree the episodes are right.',
        ].join('\n'),
      }),
    });
    if (!pr.ok) return json(502, { error: `could not open a pull request: ${await pr.text()}` });
    const opened = await pr.json();
    return json(200, { ok: true, status: 'opened', url: opened.html_url });
  },
};
