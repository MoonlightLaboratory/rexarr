/**
 * The RexDB site: index.json, searchable. No build, no framework, no dependency - the database is plain files
 * and the page that reads them should be too, so it keeps working whatever happens to the tooling around it.
 */
const listEl = document.getElementById('list');
const countsEl = document.getElementById('counts');
const queryEl = document.getElementById('q');

const text = (s) => String(s ?? '');
const escape = (s) => text(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Everything about a disc that somebody might type into the box, ids included - a TVDB number is a search. */
function haystack(d) {
  const ids = Object.entries(d.series ?? {}).flatMap(([k, v]) => (['tvdb', 'tmdb', 'anidb', 'imdb'].includes(k) ? [v, `${k} ${v}`] : []));
  return [d.disc_name, ...(d.also_known_as ?? []), ...(d.barcodes ?? []), d.fingerprint, d.series?.title, d.series?.year, ...ids, d.release?.name, d.release?.publisher, d.release?.format, d.status, d.disc && `disc ${d.disc}`]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function card(d) {
  const series = [escape(d.series?.title ?? 'Unknown'), d.series?.year ? `(${d.series.year})` : ''].filter(Boolean).join(' ');
  const ids = Object.entries(d.series ?? {})
    .filter(([k]) => ['tvdb', 'tmdb', 'anidb', 'imdb'].includes(k))
    .map(([k, v]) => `${k} ${escape(v)}`)
    .join(' · ');
  const mapping = Object.entries(d.titles ?? {});
  const where = d.release ? [d.release.name, d.release.publisher, d.release.region && `region ${d.release.region}`, d.release.format].filter(Boolean).join(' · ') : '';
  return `
    <article class="disc">
      <h2>${series} ${d.disc ? `— disc ${d.disc}` : ''} <span class="badge ${escape(d.status)}">${escape(d.status)}</span></h2>
      <div class="meta mono">${escape(d.disc_name)}</div>
      ${where ? `<div class="meta">${escape(where)}</div>` : ''}
      <div class="meta">${ids}${d.confirmations ? ` · ${d.confirmations} confirmation${d.confirmations === 1 ? '' : 's'}` : ''}</div>
      ${d.fingerprint ? `<div class="meta mono">${escape(d.fingerprint)}</div>` : '<div class="meta">no fingerprint yet — nothing can match this disc until somebody reads it</div>'}
      ${mapping.length ? `<table>${mapping.map(([k, v]) => `<tr><td>${escape(k)}</td><td>${escape(v)}</td></tr>`).join('')}</table>` : ''}
    </article>`;
}

let discs = [];

function render() {
  const q = queryEl.value.trim().toLowerCase();
  const shown = q ? discs.filter((d) => d.haystack.includes(q)) : discs;
  const verified = discs.filter((d) => d.status === 'verified').length;
  const pending = discs.filter((d) => d.status === 'pending').length;
  countsEl.textContent = `${discs.length} disc${discs.length === 1 ? '' : 's'} · ${verified} verified · ${pending} waiting to be read${q ? ` · ${shown.length} matching` : ''}`;
  listEl.innerHTML = shown.length
    ? shown.map(card).join('')
    : `<p class="empty">Nothing matches “${escape(queryEl.value)}”. If you own that disc, <a href="https://github.com/MoonlightLaboratory/rexarr/blob/RexDB/CONTRIBUTING.md">add it</a>.</p>`;
}

queryEl.addEventListener('input', render);

try {
  const index = await fetch('./index.json', { cache: 'no-cache' }).then((r) => r.json());
  // the index does not carry the mapping itself, so each entry is read for it - fine for a database this size,
  // and the moment it is not, the index gains a `titles` field and this loop goes away
  discs = await Promise.all(
    index.discs.map(async (d) => {
      const full = await fetch(`./${d.path}`, { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({}));
      return { ...d, titles: full.titles, haystack: haystack(d) };
    }),
  );
  discs.sort((a, b) => text(a.series?.title).localeCompare(text(b.series?.title)) || (a.disc ?? 0) - (b.disc ?? 0));
  render();
} catch (err) {
  countsEl.textContent = `Could not read the database: ${err.message}`;
}
