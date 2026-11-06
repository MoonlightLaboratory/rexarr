import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { SetupPlatform, SetupTool, SetupTools } from '@shared/types';
import { ONBOARDING_STEPS, STEP_LABEL, applyDraft, draftFrom, stepAfter, stepBefore, type OnboardingDraft, type OnboardingStep } from '@shared/onboarding';
import { api } from '../api';
import { useApp } from '../App';
import { Modal } from './Modal';
import { Icon } from './Icons';

const PLATFORM_LABEL: Record<SetupPlatform, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux', freebsd: 'FreeBSD', docker: 'Docker' };

const ICONS: Record<SetupTool['id'], ReactNode> = { ffmpeg: <Icon.Film />, freac: <Icon.Music />, makemkv: <Icon.Disc />, slskd: <Icon.Search /> };

/**
 * The first-run window, and the tools check on its own.
 *
 * `setup` walks the three things a new install needs settling - the programs Rexarr calls, the apps it hands
 * files to, and where rips land - and is opened once, over whatever page you arrived at. `tools` is that first
 * step reached later from System, which is the only reason the tools check still needs a way in.
 *
 * Nothing here blocks. A missing FFmpeg is said plainly and Next still works: somebody who cannot install it
 * this minute should not be held in a modal until they can.
 */
export function Onboarding({ mode, onClose }: { mode: 'setup' | 'tools'; onClose: () => void }) {
  const { toast, reloadSettings } = useApp();
  const [step, setStep] = useState<OnboardingStep>('tools');
  const [tools, setTools] = useState<SetupTools | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<OnboardingDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (refresh = false) => {
    setChecking(true);
    api
      .setupTools(refresh)
      .then((d) => {
        setTools(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setChecking(false));
  };
  useEffect(() => {
    load();
    if (mode === 'setup') api.settings().then((s) => setDraft(draftFrom(s))).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Finishing settles the settings and marks the window seen. The two are separate, and either can fail. */
  const finish = async () => {
    setSaving(true);
    try {
      if (draft) {
        // read the settings again rather than saving the copy taken when the window opened, so a change made
        // elsewhere while it sat open is not written back as whatever it was then
        await api.saveSettings(applyDraft(await api.settings(), draft));
        await reloadSettings();
      }
      await api.setupDismiss(true);
      onClose();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** Skipping saves none of it - only that the window has been seen, so it does not come back. */
  const skip = async () => {
    try {
      await api.setupDismiss(true);
    } catch {
      /* not worth a message: the worst of it is being asked once more */
    }
    onClose();
  };

  const setShowAtStart = async (show: boolean) => {
    try {
      await api.setupDismiss(!show);
      setTools((t) => (t ? { ...t, dismissed: !show } : t));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const next = stepAfter(step);
  const back = stepBefore(step);
  const setup = mode === 'setup';

  return (
    <Modal
      title={setup ? 'Setting up Rexarr' : 'Recommended tools'}
      onClose={setup ? skip : onClose}
      wide
      footer={
        setup ? (
          <>
            <button className="btn" onClick={skip} disabled={saving}>
              Skip setup
            </button>
            <span className="spacer" />
            {back && (
              <button className="btn" onClick={() => setStep(back)} disabled={saving}>
                Back
              </button>
            )}
            {next ? (
              <button className="btn primary" onClick={() => setStep(next)}>
                Next
              </button>
            ) : (
              <button className="btn primary" onClick={finish} disabled={saving}>
                {saving && <span className="spinner" />} Finish
              </button>
            )}
          </>
        ) : (
          <>
            <label className="check small">
              <input type="checkbox" checked={tools ? !tools.dismissed : false} disabled={!tools} onChange={(e) => setShowAtStart(e.target.checked)} /> Show this when Rexarr starts
            </label>
            <span className="spacer" />
            <button className="btn" onClick={() => load(true)} disabled={checking}>
              {checking ? <span className="spinner" /> : <Icon.Refresh />} Check again
            </button>
            <button className="btn primary" onClick={onClose}>
              Close
            </button>
          </>
        )
      }
    >
      {setup && (
        <ol className="obSteps">
          {ONBOARDING_STEPS.map((s, i) => (
            <li key={s} className={`obStep${s === step ? ' on' : ''}${ONBOARDING_STEPS.indexOf(step) > i ? ' done' : ''}`}>
              <button type="button" className="obDot" onClick={() => setStep(s)} aria-current={s === step ? 'step' : undefined}>
                {i + 1}
              </button>
              <span className="obStepLabel">{STEP_LABEL[s]}</span>
            </li>
          ))}
        </ol>
      )}

      {error && <div className="error">{error}</div>}

      {step === 'tools' && <ToolsStep tools={tools} checking={checking} onCheck={() => load(true)} showCheck={setup} />}
      {step === 'apps' && <AppsStep draft={draft} onChange={setDraft} />}
      {step === 'folders' && <FoldersStep draft={draft} onChange={setDraft} />}
      {step === 'metadata' && <MetadataStep draft={draft} onChange={setDraft} />}
    </Modal>
  );
}

function Waiting() {
  return (
    <div className="card mb">
      <div className="card-b dim">
        <span className="spinner" /> Reading your settings…
      </div>
    </div>
  );
}

function ToolsStep({ tools, checking, onCheck, showCheck }: { tools: SetupTools | null; checking: boolean; onCheck: () => void; showCheck: boolean }) {
  const missing = tools?.tools.filter((t) => !t.available) ?? [];
  return (
    <>
      <p className="obIntro">
        Rexarr works with a few free programs that are installed separately. <strong>FFmpeg</strong> is needed for transcoding; the others add music,
        disc ripping and Soulseek. {tools && <>Instructions are for <strong>{PLATFORM_LABEL[tools.platform]}</strong>.</>}
      </p>
      {tools && (
        <div className="inline small mb">
          {missing.length === 0 ? (
            <span className="badge green">Everything is installed</span>
          ) : (
            <span className="dim">
              {tools.tools.length - missing.length} of {tools.tools.length} found. Already installed somewhere else? Set its path under{' '}
              <Link to="/settings">Settings → Connections</Link>, then check again.
            </span>
          )}
          {showCheck && (
            <>
              <span className="spacer" />
              <button className="btn sm" onClick={onCheck} disabled={checking}>
                {checking ? <span className="spinner" /> : <Icon.Refresh />} Check again
              </button>
            </>
          )}
        </div>
      )}
      {!tools && (
        <div className="card mb">
          <div className="card-b dim">
            <span className="spinner" /> Looking for FFmpeg, fre:ac, MakeMKV and slskd…
          </div>
        </div>
      )}
      {tools?.tools.map((t) => <ToolCard key={t.id} tool={t} />)}
    </>
  );
}

function AppsStep({ draft, onChange }: { draft: OnboardingDraft | null; onChange: (d: OnboardingDraft) => void }) {
  if (!draft) return <Waiting />;
  return (
    <>
      <p className="obIntro">
        Rexarr hands finished rips and encodes to Sonarr and Radarr, which file them into your library. Fill in whichever you use — either can be left
        until later under <Link to="/settings">Settings → Connections</Link>, along with Prowlarr, Lidarr, Bazarr and slskd.
      </p>
      <AppRow app="sonarr" label="Sonarr" hint="TV and anime" value={draft.sonarr} onChange={(sonarr) => onChange({ ...draft, sonarr })} placeholder="http://localhost:8989" />
      <AppRow app="radarr" label="Radarr" hint="Films" value={draft.radarr} onChange={(radarr) => onChange({ ...draft, radarr })} placeholder="http://localhost:7878" />
    </>
  );
}

function AppRow({
  app,
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  app: 'sonarr' | 'radarr';
  label: string;
  hint: string;
  value: { url: string; apiKey: string };
  onChange: (v: { url: string; apiKey: string }) => void;
  placeholder: string;
}) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = Boolean(value.url.trim() && value.apiKey.trim());
  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.testConnection(app, value);
      setResult({ ok: r.ok, message: r.ok ? `${r.appName ?? label}${r.version ? ` v${r.version}` : ''}` : r.error || 'could not connect' });
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mb">
      <div className="card-h">
        <span className="toolName">{label}</span>
        <span className="small dim">{hint}</span>
        <span className="spacer" />
        {result && (
          <span className={`badge ${result.ok ? 'green' : 'red'}`} title={result.message}>
            {result.ok ? 'Connected' : 'Not reachable'}
          </span>
        )}
      </div>
      <div className="card-b">
        <div className="field stack">
          <label>URL</label>
          <input type="text" className="mono" value={value.url} placeholder={placeholder} onChange={(e) => onChange({ ...value, url: e.target.value })} />
        </div>
        <div className="field stack">
          <label>API key</label>
          <input type="password" className="mono" value={value.apiKey} onChange={(e) => onChange({ ...value, apiKey: e.target.value })} />
          <div className="help">
            In {label}: <strong>Settings → General → Security → API Key</strong>. Leave both boxes empty to skip {label} for now.
          </div>
        </div>
        <div className="inline">
          <button className="btn sm" onClick={test} disabled={!ready || busy}>
            {busy ? <span className="spinner" /> : <Icon.Check />} Test
          </button>
          {result && <span className={`small ${result.ok ? 'dim' : 'danger'}`}>{result.message}</span>}
        </div>
      </div>
    </div>
  );
}

function FoldersStep({ draft, onChange }: { draft: OnboardingDraft | null; onChange: (d: OnboardingDraft) => void }) {
  if (!draft) return <Waiting />;
  return (
    <>
      <p className="obIntro">
        A disc is copied here first, transcoded, then handed over to be imported. It wants room for a whole disc at a time — a Blu-ray is 25–50 GB —
        and Sonarr and Radarr have to be able to read it, which is the part that catches people out when those run in another container.
      </p>
      <div className="card mb">
        <div className="card-h">Rip folder</div>
        <div className="card-b">
          <div className="field stack">
            <label>Path</label>
            <input
              type="text"
              className="mono"
              value={draft.ripDirectory}
              placeholder="Empty = <data dir>/rips"
              onChange={(e) => onChange({ ...draft, ripDirectory: e.target.value })}
            />
            <div className="help">
              Leaving it empty keeps rips beside Rexarr's own data, which is fine to start with. Once it is saved you can confirm the other apps can
              reach it with <strong>Check import access</strong> under <Link to="/settings">Settings → Connections</Link>.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function MetadataStep({ draft, onChange }: { draft: OnboardingDraft | null; onChange: (d: OnboardingDraft) => void }) {
  if (!draft) return <Waiting />;
  const fm = draft.fileMetadata;
  return (
    <>
      <p className="obIntro">
        What Rexarr writes inside the file, as opposed to in its name. Plex and Jellyfin both read this, and Jellyfin can be told to prefer it over
        the name it matched — which is why it is worth a moment now rather than after a library full of encodes.
      </p>
      <div className="card mb">
        <div className="card-h">Metadata</div>
        <div className="card-b">
          <div className="field stack">
            <label>Title inside the file</label>
            <select value={fm.title} onChange={(e) => onChange({ ...draft, fileMetadata: { ...fm, title: e.target.value as 'clean' | 'none' } })}>
              <option value="clean">The show and episode, or the film</option>
              <option value="none">Nothing</option>
            </select>
            <div className="help">
              <strong>Nothing</strong> leaves Plex and Jellyfin to use the name they matched, which is the safer answer when the two disagree.
            </div>
          </div>
          <div className="field stack">
            <label className="check">
              <input type="checkbox" checked={fm.comment} onChange={(e) => onChange({ ...draft, fileMetadata: { ...fm, comment: e.target.checked } })} /> Write an
              “Encoded by Rexarr…” comment in the file
            </label>
            <div className="help">Useful for telling your own encodes apart later; off for a file that says nothing about where it came from.</div>
          </div>
        </div>
      </div>
      <p className="small dim">That is everything. Finish saves what you have filled in; the rest is under Settings whenever you want it.</p>
    </>
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
