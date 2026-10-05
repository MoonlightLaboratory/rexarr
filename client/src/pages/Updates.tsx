import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { ReleaseInfo, UpdateStatus } from '@shared/types';
import { api, fmtAge } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton } from '../components/Layout';
import { Icon } from '../components/Icons';
import { LoadingIndicator } from '../components/Labels';

const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');

// ---- the small part of Markdown the release notes use -----------------------------------------

/** `**bold**`, `*italic*`, `` `code` ``, `[text](url)` and bare links – everything else stays text. */
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={`${key}-${m.index}`}>{m[1]}</strong>);
    else if (m[2]) out.push(<em key={`${key}-${m.index}`}>{m[2]}</em>);
    else if (m[3]) out.push(<code key={`${key}-${m.index}`}>{m[3]}</code>);
    else if (m[4]) out.push(
      <a key={`${key}-${m.index}`} href={m[5]} target="_blank" rel="noreferrer">
        {m[4]}
      </a>,
    );
    else if (m[6]) out.push(
      <a key={`${key}-${m.index}`} href={m[6]} target="_blank" rel="noreferrer">
        {m[6].replace(/^https:\/\/github\.com\//, '')}
      </a>,
    );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Headings, bullet lists, tables, quotes (including GitHub's `> [!NOTE]`) and paragraphs. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  const key = () => `b${blocks.length}`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++; // the closing fence
      blocks.push(
        <pre key={key()}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(
        <div key={key()} className={heading[1].length <= 2 ? 'legend' : 'mdHead'}>
          {inline(heading[2])}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || (items.length && /^\s{2,}\S/.test(lines[i])))) {
        if (/^\s*[-*]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      blocks.push(
        <ul key={key()} className="mdList">
          {items.map((it, n) => (
            <li key={n}>{inline(it, n)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key()} className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>{head.map((h, n) => <th key={n}>{inline(h, n)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>{r.map((c, m) => <td key={m}>{inline(c, m)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      let kind = '';
      while (i < lines.length && lines[i].startsWith('>')) {
        const body = lines[i].replace(/^>\s?/, '');
        const alert = body.match(/^\[!(\w+)\]$/);
        if (alert) kind = alert[1].toLowerCase();
        else quote.push(body);
        i++;
      }
      blocks.push(
        <div key={key()} className={`mdQuote${kind ? ` ${kind}` : ''}`}>
          {quote.map((q, n) => (
            <p key={n}>{inline(q, n)}</p>
          ))}
        </div>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*[-*]\s+|^#{1,6}\s|^>/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key()}>{inline(para.join(' '))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

// ---- the page ---------------------------------------------------------------------------------

const installKind = (s: UpdateStatus) =>
  s.mechanism === 'docker' ? 'running in Docker' : s.mechanism === 'script' ? 'update script' : s.mechanism === 'builtIn' ? 'running from source' : 'installed package';

/** What to do with a release, for the way this instance was installed. */
function howToInstall(status: UpdateStatus, version: string): ReactNode {
  if (status.mechanism === 'docker' || status.inDocker)
    return (
      <>
        Pull the new image and recreate the container: <code>docker pull ghcr.io/moonlightlaboratory/rexarr:{version}</code>
      </>
    );
  if (status.mechanism === 'script') return <>Your update script installs it; Rexarr does not update itself.</>;
  if (status.mechanism === 'builtIn') return <>You are running from source: <code>git pull && npm install && npm run build</code>, then restart Rexarr.</>;
  return <>Download the package for your platform from the release and install it over this one. Your settings and data stay where they are.</>;
}

function Release({ release, status, expand }: { release: ReleaseInfo; status: UpdateStatus; expand?: boolean }) {
  const [open, setOpen] = useState(release.installed || release.newer || expand === true);
  return (
    <div className="card release">
      <div className="releaseHead" onClick={() => setOpen(!open)}>
        <span className={`releaseToggle${open ? ' open' : ''}`}>
          <Icon.ChevronRight />
        </span>
        <span className="releaseVersion">{release.version}</span>
        {release.installed && <span className="badge green">Installed</span>}
        {release.newer && <span className="badge remux">Available</span>}
        {release.prerelease && <span className="badge sm">pre-release</span>}
        <span className="dim small" title={fmtTime(release.publishedAt)}>
          {release.publishedAt ? fmtAge(release.publishedAt) : ''}
        </span>
        <span className="grow" />
        <a className="small" href={release.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          Release page
        </a>
      </div>
      {open && (
        <div className="releaseBody">
          {release.newer && <div className="mdQuote tip">{howToInstall(status, release.version)}</div>}
          {release.notes ? <Markdown text={release.notes} /> : <p className="dim">No notes for this release.</p>}
        </div>
      )}
    </div>
  );
}

export function UpdatesPage() {
  const { toast } = useApp();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh?: boolean) => {
    setBusy(true);
    api
      .updates(refresh)
      .then(setStatus)
      .catch((e) => toast('error', (e as Error).message))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Page
      title="Updates"
      toolbarLeft={<ToolbarButton icon={busy ? <span className="spinner" /> : <Icon.Refresh />} label="Check" title="Check for updates" onClick={() => load(true)} />}
      narrow
    >
      {!status ? (
        <LoadingIndicator />
      ) : (
        <>
          <div className="card updateSummary">
            <div>
              {status.available ? (
                <>
                  <strong>Rexarr {status.available} is available.</strong> You are running {status.current}.
                </>
              ) : status.releases.some((r) => r.installed) || !status.releases.length ? (
                <>
                  <strong>Rexarr {status.current} is the newest release.</strong>
                </>
              ) : (
                <>
                  <strong>You are running {status.current}</strong>, which is ahead of the newest release ({status.releases[0].version}).
                </>
              )}
              <div className="dim small">
                {status.checkedAt ? `Checked ${fmtAge(status.checkedAt)}` : 'Not checked yet'} · branch {status.branch} · {installKind(status)} · Rexarr
                does not update itself
              </div>
            </div>
          </div>
          {status.error && (
            <div className="card updateError">
              Could not reach GitHub: {status.error}
              {status.releases.length > 0 && ' – showing the last list that was read.'}
            </div>
          )}
          {status.releases.length === 0 && !status.error && <div className="card dim">No releases found.</div>}
          {status.releases.map((r, i) => (
            <Fragment key={r.version}>
              <Release release={r} status={status} expand={i === 0 && !status.releases.some((x) => x.installed || x.newer)} />
            </Fragment>
          ))}
        </>
      )}
    </Page>
  );
}
