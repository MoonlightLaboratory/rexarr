/**
 * The RexDB site: index.json, grouped and searchable. One fetch, no framework, no build - the database is plain
 * files and the page over it should be too, so it keeps working whatever happens to the tooling around it.
 */
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ID_KEYS = ['tvdb', 'tmdb', 'anidb', 'imdb'];

/** Everything somebody might type into the box, ids included - a TVDB number is a search. */
function haystack(d) {
  const ids = Object.entries(d.series ?? {}).flatMap(([k, v]) => (ID_KEYS.includes(k) ? [v, `${k} ${v}`] : []));
  return [d.disc_name, ...(d.also_known_as ?? []), ...(d.barcodes ?? []), d.fingerprint, d.series?.title, d.series?.year, ...ids, d.release?.name, d.release?.publisher, d.release?.format, d.status, d.disc && `disc ${d.disc}`, ...Object.values(d.titles ?? {})]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** "S02E20" -> { season: 2, episode: 20 }; anything else is not an episode. */
function parseEpisode(v) {
  const m = /^S(\d{1,3})E(\d{1,4})(?:-E(\d{1,4}))?$/.exec(v ?? '');
  return m ? { season: +m[1], from: +m[2], to: m[3] ? +m[3] : +m[2] } : null;
}

/**
 * What a disc holds, in one line: "S02E01–E07", plus what else is on it. This is the thing somebody came to
 * read, so it goes in the header rather than behind a table of title keys.
 */
function summarise(titles = {}) {
  const eps = Object.values(titles).map(parseEpisode).filter(Boolean);
  const main = eps.filter((e) => e.season > 0);
  const specials = eps.filter((e) => e.season === 0).length;
  const extras = Object.values(titles).filter((v) => String(v).startsWith('extra')).length;
  const other = Object.values(titles).filter((v) => v === 'playall' || v === 'skip').length;

  let range = 'nothing listed';
  if (main.length) {
    const season = main[0].season;
    const lo = Math.min(...main.map((e) => e.from));
    const hi = Math.max(...main.map((e) => e.to));
    const s = `S${String(season).padStart(2, '0')}`;
    const mixed = main.some((e) => e.season !== season);
    range = mixed ? `${main.length} episodes` : lo === hi ? `${s}E${String(lo).padStart(2, '0')}` : `${s}E${String(lo).padStart(2, '0')}–E${String(hi).padStart(2, '0')}`;
  }
  const also = [
    specials && `${specials} special${specials > 1 ? 's' : ''}`,
    extras && `${extras} extra${extras > 1 ? 's' : ''}`,
    other && `${other} skipped`,
  ].filter(Boolean);
  return { range, also, episodeCount: main.length };
}

const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>';

function discCard(d) {
  const { range, also } = summarise(d.titles);
  const ids = Object.entries(d.series ?? {}).filter(([k]) => ID_KEYS.includes(k)).map(([k, v]) => `${k} ${esc(v)}`);
  const facts = [
    d.release?.name && `<span><b>${esc(d.release.name)}</b></span>`,
    d.release?.publisher && `<span>${esc(d.release.publisher)}</span>`,
    d.release?.region && `<span>region ${esc(d.release.region)}</span>`,
    d.release?.format && `<span>${esc(d.release.format)}</span>`,
    d.structure && `<span>${d.structure.titleCount} titles</span>`,
    d.confirmations && `<span><b>${d.confirmations}</b> confirmation${d.confirmations === 1 ? '' : 's'}</span>`,
    d.barcodes?.length && `<span class="mono">${d.barcodes.map(esc).join(', ')}</span>`,
    ids.length && `<span>${ids.join(' · ')}</span>`,
  ].filter(Boolean);

  const map = Object.entries(d.titles ?? {})
    .map(([k, v]) => {
      const ep = parseEpisode(v);
      const cls = ep ? (ep.season === 0 ? 'special' : '') : 'other';
      return `<div><span class="k">${esc(k)}</span><span class="v ${cls}">${esc(v)}</span></div>`;
    })
    .join('');

  return `
  <details class="disc"${d.fingerprint ? ` id="fp-${esc(d.fingerprint)}"` : ''}>
    <summary class="discHead">
      <span class="discNo"><b>${d.disc ?? '—'}</b><small>disc</small></span>
      <span class="discMain">
        <span class="discRange">${esc(range)}${also.length ? ` <span class="extra">+ ${also.join(', ')}</span>` : ''}</span>
        <span class="discLabel mono">${esc(d.disc_name)}</span>
      </span>
      <span class="badge ${esc(d.status)}">${esc(d.status)}</span>
      ${CHEV}
    </summary>
    <div class="discBody">
      ${facts.length ? `<p class="facts">${facts.join('')}</p>` : ''}
      ${
        d.fingerprint
          ? `<p class="facts"><span>fingerprint</span><span class="mono"><b>${esc(d.fingerprint)}</b></span></p>`
          : '<p class="warnNote">No fingerprint yet, so nothing can match this disc automatically. The mapping is known — it needs somebody with the disc to read it and finish the entry.</p>'
      }
      <div class="map">${map}</div>
    </div>
  </details>`;
}

/** A set with discs 1, 2 and 4 is missing disc 3, and that is the most useful thing the page can say. */
function gaps(discs) {
  const have = new Set(discs.map((d) => d.disc).filter(Boolean));
  if (have.size < 2) return [];
  const missing = [];
  for (let n = 1; n < Math.max(...have); n++) if (!have.has(n)) missing.push(n);
  return missing;
}

function seriesBlock(key, discs) {
  const first = discs[0];
  const ids = Object.entries(first.series ?? {}).filter(([k]) => ID_KEYS.includes(k)).map(([k, v]) => `${k} ${esc(v)}`).join(' · ');
  const sorted = [...discs].sort((a, b) => (a.disc ?? 99) - (b.disc ?? 99));
  const missing = gaps(sorted)
    .map(
      (n) => `<div class="gap"><span class="discNo"><b>${n}</b><small>disc</small></span>
        <span>Nobody has read disc ${n} of this set yet. <a href="https://github.com/MoonlightLaboratory/rexarr/blob/RexDB/CONTRIBUTING.md">Add it</a> if you own it.</span></div>`,
    )
    .join('');
  return `
  <section class="series">
    <div class="seriesHead">
      <h2>${esc(first.series?.title ?? 'Unknown')}${first.series?.year ? ` <span class="ids">(${first.series.year})</span>` : ''}</h2>
      <span class="ids">${ids}</span>
    </div>
    <div class="discs">${sorted.map(discCard).join('')}${missing}</div>
  </section>`;
}

// ---- state ----
let discs = [];
let filter = 'all';
const FILTERS = [
  ['all', 'Everything'],
  ['verified', 'Verified'],
  ['unverified', 'Unverified'],
  ['pending', 'Waiting to be read'],
];

function render() {
  const q = el('q').value.trim().toLowerCase();
  const shown = discs.filter((d) => (filter === 'all' || d.status === filter) && (!q || d.haystack.includes(q)));

  const bySeries = new Map();
  for (const d of shown) {
    const key = ID_KEYS.map((k) => d.series?.[k]).find(Boolean) ?? d.series?.title ?? d.disc_name;
    if (!bySeries.has(key)) bySeries.set(key, []);
    bySeries.get(key).push(d);
  }
  const blocks = [...bySeries.entries()].sort((a, b) => String(a[1][0].series?.title).localeCompare(String(b[1][0].series?.title)));

  el('results').innerHTML = blocks.length
    ? blocks.map(([k, v]) => seriesBlock(k, v)).join('')
    : `<div class="empty"><strong>Nothing here matches that.</strong>
         ${q ? `No disc answers to “${esc(el('q').value)}”.` : 'No disc has that status yet.'}
         If you own it, <a href="https://github.com/MoonlightLaboratory/rexarr/blob/RexDB/CONTRIBUTING.md">add it</a> — it takes a few minutes.</div>`;

  const url = new URL(location.href);
  q ? url.searchParams.set('q', el('q').value) : url.searchParams.delete('q');
  filter !== 'all' ? url.searchParams.set('status', filter) : url.searchParams.delete('status');
  history.replaceState(null, '', url);
}

function renderStats() {
  const count = (s) => discs.filter((d) => d.status === s).length;
  const series = new Set(discs.map((d) => ID_KEYS.map((k) => d.series?.[k]).find(Boolean) ?? d.series?.title)).size;
  const stats = [
    ['Discs', discs.length, ''],
    ['Series', series, ''],
    ['Verified', count('verified'), 'good'],
    ['Waiting to be read', count('pending'), 'waiting'],
  ];
  el('stats').innerHTML = stats.map(([k, v, cls]) => `<div><dt>${k}</dt><dd class="${cls}">${v}</dd></div>`).join('');
  el('filters').innerHTML = FILTERS.map(
    ([v, label]) => `<button type="button" data-filter="${v}" aria-pressed="${filter === v}">${label}</button>`,
  ).join('');
}

el('q').addEventListener('input', render);
el('filters').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-filter]');
  if (!button) return;
  filter = button.dataset.filter;
  renderStats();
  render();
});
// "/" to search, the way every list of things worth searching behaves
addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== el('q')) {
    e.preventDefault();
    el('q').focus();
  }
  if (e.key === 'Escape' && document.activeElement === el('q')) {
    el('q').value = '';
    render();
  }
});

/**
 * Where the database is read from.
 *
 * The published page lives under the documentation site, which is built from another branch, so a copy of
 * index.json next to it would be a snapshot that goes stale the moment somebody contributes. It reads the
 * branch itself instead - raw.githubusercontent serves it with CORS open - and is therefore always current
 * without anything having to rebuild. Served locally, it reads the file next to it, so the branch can be
 * opened with any static server and checked as it stands.
 */
const LOCAL = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const INDEX_URL = LOCAL ? './index.json' : 'https://raw.githubusercontent.com/MoonlightLaboratory/rexarr/RexDB/index.json';

try {
  const index = await fetch(INDEX_URL, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  });
  discs = index.discs.map((d) => ({ ...d, haystack: haystack(d) }));

  const params = new URLSearchParams(location.search);
  el('q').value = params.get('q') ?? '';
  if (FILTERS.some(([v]) => v === params.get('status'))) filter = params.get('status');

  renderStats();
  render();
  // a link straight to one disc, which is what anyone pasting a fingerprint wants
  if (location.hash.startsWith('#fp-')) {
    const target = document.getElementById(location.hash.slice(1));
    if (target) {
      target.open = true;
      target.scrollIntoView({ block: 'center' });
    }
  }
} catch (err) {
  el('results').innerHTML = `<div class="empty"><strong>Could not read the database.</strong>${esc(err.message)}</div>`;
}
