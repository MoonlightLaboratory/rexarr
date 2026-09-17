import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { SetupPlatform, SetupTool, SetupTools } from '@shared/types';
import { api } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton } from '../components/Layout';
import { Icon } from '../components/Icons';

const PLATFORM_LABEL: Record<SetupPlatform, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux', freebsd: 'FreeBSD', docker: 'Docker' };

const ICONS: Record<SetupTool['id'], ReactNode> = { ffmpeg: <Icon.Film />, freac: <Icon.Music />, makemkv: <Icon.Disc />, slskd: <Icon.Search /> };

/** System → Tools; opened automatically on first launch (?welcome=1) until closed. */
export function ToolsPage() {
  const { toast } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const welcome = params.get('welcome') === '1';
  const [data, setData] = useState<SetupTools | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (refresh = false) => {
    setBusy(true);
    api
      .setupTools(refresh)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(), []);

  const setDismissed = async (dismissed: boolean) => {
    try {
      await api.setupDismiss(dismissed);
      setData((d) => (d ? { ...d, dismissed } : d));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const finish = async () => {
    await setDismissed(true);
    navigate('/movies');
  };

  const missing = data?.tools.filter((t) => !t.available) ?? [];
  return (
    <Page
      title="Recommended tools"
      toolbarLeft={<ToolbarButton icon={<Icon.Refresh />} label="Check again" onClick={() => load(true)} busy={busy} />}
      narrow
    >
      {error && <div className="error">{error}</div>}
      <div className="card mb">
        <div className="card-b">
          {welcome && <h2 className="toolsWelcome">Welcome to Rexarr</h2>}
          <p className="toolsIntro">
            Rexarr works with a few free programs that are installed separately. <strong>FFmpeg</strong> is needed for transcoding; the others add
            music, disc ripping and Soulseek. {data && <>Instructions are for <strong>{PLATFORM_LABEL[data.platform]}</strong>.</>}
          </p>
          {data && (
            <div className="inline small">
              {missing.length === 0 ? (
                <span className="badge green">Everything is installed</span>
              ) : (
                <span className="dim">
                  {data.tools.length - missing.length} of {data.tools.length} found. Already installed somewhere else? Set its path under <Link to="/settings">Settings → Connections</Link>, then <em>Check again</em>.
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {!data && !error && (
        <div className="card mb">
          <div className="card-b dim">
            <span className="spinner" /> Looking for FFmpeg, fre:ac, MakeMKV and slskd…
          </div>
        </div>
      )}

      {data?.tools.map((t) => <ToolCard key={t.id} tool={t} />)}

      {data && (
        <div className="toolsFooter">
          <label className="check small">
            <input type="checkbox" checked={!data.dismissed} onChange={(e) => setDismissed(!e.target.checked)} /> Show this page when Rexarr starts
          </label>
          <span className="spacer" />
          {welcome && (
            <button className="btn primary" onClick={finish}>
              {missing.some((t) => t.required) ? 'Skip for now' : 'Continue to Rexarr'}
            </button>
          )}
        </div>
      )}
    </Page>
  );
}

function ToolCard({ tool }: { tool: SetupTool }) {
  const { toast } = useApp();
  const [open, setOpen] = useState(!tool.available);
  useEffect(() => setOpen(!tool.available), [tool.available]);
  const copy = (command: string) =>
    navigator.clipboard.writeText(command).then(
      () => toast('info', 'Command copied'),
      () => toast('warn', 'Copy failed: select the command and copy it by hand'),
    );
  return (
    <div className={`card mb toolCard${tool.available ? ' found' : ''}`}>
      <div className="card-h toolHead" onClick={() => setOpen(!open)} role="button" aria-expanded={open}>
        <span className="toolIcon">{ICONS[tool.id]}</span>
        <span className="toolName">{tool.name}</span>
        <span className={`badge sm ${tool.required ? 'warning' : 'outline blue'}`}>{tool.required ? 'Required' : 'Optional'}</span>
        <span className="spacer" />
        {tool.available ? (
          <span className="badge green" title={tool.detail}>
            <Icon.Check /> {tool.id === 'slskd' ? 'Connected' : 'Found'}
            {tool.detail && tool.id !== 'slskd' ? ` · ${tool.detail}` : ''}
          </span>
        ) : (
          <span className={`badge ${tool.required ? 'red' : 'muted'}`} title={tool.detail}>
            {tool.id === 'slskd' ? 'Not connected' : 'Not found'}
          </span>
        )}
        <span className={`toolChevron${open ? ' open' : ''}`}>
          <Icon.ChevronDown />
        </span>
      </div>
      <div className="card-b">
        <p className="toolPurpose">{tool.purpose}</p>
        {open && (
          <>
            {tool.steps.length > 0 && (
              <ol className="toolSteps">
                {tool.steps.map((s, i) => (
                  <li key={i}>
                    <div className="toolStepLabel">{s.label}</div>
                    {s.command && (
                      <div className="toolCommand">
                        <code>{s.command}</code>
                        <button className="btn sm" title="Copy command" onClick={() => copy(s.command!)}>
                          <Icon.Copy /> Copy
                        </button>
                      </div>
                    )}
                    {s.url && (
                      <a className="btn sm toolLink" href={s.url} target="_blank" rel="noreferrer">
                        <Icon.ExternalLink /> {new URL(s.url).hostname.replace(/^www\./, '')}
                      </a>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {tool.note && <div className="help">{tool.note}</div>}
            {!tool.available && tool.detail && tool.detail !== 'not connected' && <div className="help toolError">Last check: {tool.detail}</div>}
          </>
        )}
      </div>
    </div>
  );
}
