import { useEffect, useState, type ReactNode } from 'react';
import type { GeneralSettings, HostRuntime, Settings } from '@shared/types';
import { api } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarSeparator, ToolbarText } from '../components/Layout';
import { Icon } from '../components/Icons';
import { Modal } from '../components/Modal';

const ADVANCED_KEY = 'rexarr.showAdvanced';

/** One Sonarr-style form row: bold label on the left, input + help text on the right. Advanced labels are orange. */
function FormGroup({ label, advanced, show, children, help, warning, restart }: { label: string; advanced?: boolean; show: boolean; children: ReactNode; help?: ReactNode; warning?: ReactNode; restart?: boolean }) {
  if (advanced && !show) return null;
  return (
    <div className={`formRow${advanced ? ' advanced' : ''}`}>
      <label className="formRowLabel">{label}</label>
      <div className="formRowInput">
        {children}
        {help && <div className="formHelp">{help}</div>}
        {warning && <div className="formHelp warning">{warning}</div>}
        {restart && <div className="formHelp warning">Requires restart to take effect</div>}
      </div>
    </div>
  );
}

function NumberWithUnit({ value, onChange, unit, min, max, disabled }: { value: number; onChange: (n: number) => void; unit: string; min?: number; max?: number; disabled?: boolean }) {
  return (
    <div className="inputWithUnit">
      <input type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
      <span className="unit">{unit}</span>
    </div>
  );
}

/** Pick a file or folder on the server. */
function PathPicker({ title, initial, folders, onPick, onClose }: { title: string; initial: string; folders?: boolean; onPick: (p: string) => void; onClose: () => void }) {
  const { toast } = useApp();
  const [dir, setDir] = useState<{ path: string; parent: string | null; entries: { name: string; dir: boolean; path: string }[] } | null>(null);
  const [value, setValue] = useState(initial);
  const browse = (p: string) =>
    api
      .fsList(p)
      .then((d) => {
        setDir(d);
        if (folders) setValue(d.path);
      })
      .catch((e) => toast('error', (e as Error).message));
  useEffect(() => {
    void browse(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!value.trim()}
            onClick={() => {
              onPick(value.trim());
              onClose();
            }}
          >
            OK
          </button>
        </>
      }
    >
      <input type="text" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && browse(value)} className="mb" />
      {dir && (
        <div className="card flat pickerList">
          {dir.parent && (
            <div className="list-row" onClick={() => browse(dir.parent!)}>
              <Icon.Folder /> <span className="dim">..</span>
            </div>
          )}
          {dir.entries
            .filter((e) => e.dir || !folders)
            .map((e) => (
              <div key={e.path} className={`list-row${value === e.path ? ' selected' : ''}`} onClick={() => (e.dir ? browse(e.path) : setValue(e.path))}>
                {e.dir ? <Icon.Folder /> : <Icon.Copy />}
                <span className="truncate">{e.name}</span>
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}

function PathInput({ value, onChange, placeholder, folders, title, disabled }: { value: string; onChange: (v: string) => void; placeholder?: string; folders?: boolean; title: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="inputGroup">
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} />
      <button className="inputGroupButton primary" onClick={() => setOpen(true)} title="Browse" disabled={disabled}>
        <Icon.Folder />
      </button>
      {open && <PathPicker title={title} initial={value} folders={folders} onPick={onChange} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function SettingsGeneralPage() {
  const { settings, reloadSettings, reloadHealth, toast } = useApp();
  const [s, setS] = useState<Settings | null>(null);
  const [rt, setRt] = useState<HostRuntime | null>(null);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(() => {
    try {
      return localStorage.getItem(ADVANCED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (settings) setS(structuredClone(settings));
  }, [settings]);
  const loadRuntime = () => api.hostRuntime().then(setRt).catch(() => undefined);
  useEffect(() => {
    void loadRuntime();
  }, []);

  if (!s || !settings) return <Page title="General Settings"><div className="empty"><span className="spinner" /></div></Page>;
  const g = s.general;
  const set = <K extends keyof GeneralSettings>(k: K, patch: Partial<GeneralSettings[K]>) => setS({ ...s, general: { ...g, [k]: { ...g[k], ...patch } } });
  const env = (field: string) => rt?.envOverrides.includes(field);
  const dirty = JSON.stringify(s.general) !== JSON.stringify(settings.general) || Boolean(password) || Boolean(confirmation);
  const adv = showAdvanced;

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings({ ...s, general: { ...g, security: { ...g.security, ...(password ? { password, passwordConfirmation: confirmation } : {}) } as GeneralSettings['security'] } });
      setPassword('');
      setConfirmation('');
      await reloadSettings();
      await loadRuntime();
      void reloadHealth();
      toast('info', 'Settings saved');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const doRestart = async () => {
    setRestarting(true);
    try {
      const r = await api.restart();
      toast('info', 'Restarting…');
      const samePlace = r.port === Number(window.location.port || (window.location.protocol === 'https:' ? 443 : 80)) && r.urlBase === (window.__REXARR__?.urlBase ?? '');
      const target = samePlace ? window.location.href : `${window.location.protocol}//${window.location.hostname}:${r.port}${r.urlBase}/settings/general`;
      // wait for the server to come back, then reload (on the new port / URL base if those changed)
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, i === 0 ? 1500 : 750)); // the old server keeps answering for a moment
        try {
          const probe = await fetch(`${window.location.protocol}//${window.location.hostname}:${r.port}${r.urlBase}/api/health`, { cache: 'no-store', mode: samePlace ? 'same-origin' : 'no-cors' });
          if (probe.ok || probe.type === 'opaque') {
            window.location.href = target;
            return;
          }
        } catch {
          /* still restarting */
        }
      }
      toast('warn', `rexarr did not come back on port ${r.port}. Check System → Events.`);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setRestarting(false);
    }
  };

  const regenerate = async () => {
    setConfirmRegen(false);
    try {
      const { apiKey } = await api.regenerateApiKey();
      await reloadSettings();
      setS((cur) => (cur ? { ...cur, general: { ...cur.general, security: { ...cur.general.security, apiKey } } } : cur));
      toast('info', 'API key regenerated');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const localBind = ['localhost', '127.0.0.1', '::1'].includes(g.host.bindAddress);

  return (
    <Page
      title="General Settings"
      narrow
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.Save />} label={dirty ? 'Save Changes' : 'No Changes'} busy={saving} disabled={!dirty} onClick={save} selected={dirty} wide />
          <ToolbarSeparator />
          <ToolbarButton
            icon={<Icon.Settings />}
            label={showAdvanced ? 'Hide Advanced' : 'Show Advanced'}
            wide
            selected={showAdvanced}
            onClick={() => {
              setShowAdvanced(!showAdvanced);
              try {
                localStorage.setItem(ADVANCED_KEY, showAdvanced ? '0' : '1');
              } catch {
                /* ignore */
              }
            }}
          />
          {rt?.restartRequired && (
            <>
              <ToolbarSeparator />
              <ToolbarButton icon={<Icon.Refresh />} label="Restart" busy={restarting} onClick={doRestart} />
              <ToolbarText>Restart to apply host changes</ToolbarText>
            </>
          )}
        </>
      }
    >
      {rt?.restartRequired && (
        <div className="warn">
          Host settings were changed. rexarr is still listening on port {rt.port}
          {rt.urlBase ? ` with URL base ${rt.urlBase}` : ''}.{' '}
          <button className="btn sm warning" onClick={doRestart} disabled={restarting}>
            {restarting ? <span className="spinner" /> : <Icon.Refresh />} Restart now
          </button>
        </div>
      )}

      <fieldset className="fieldSet">
        <legend>Host</legend>
        <FormGroup label="Bind Address" advanced show={adv} help="Valid IP address, localhost or '*' for all interfaces" restart warning={env('bindAddress') ? 'Set by the REXARR_HOST environment variable' : undefined}>
          <input type="text" value={g.host.bindAddress} onChange={(e) => set('host', { bindAddress: e.target.value })} disabled={env('bindAddress')} />
        </FormGroup>
        <FormGroup label="Port Number" show={adv} restart warning={env('port') ? 'Set by the REXARR_PORT (or PORT) environment variable' : rt?.docker ? 'In Docker, change the published port in your compose file instead' : undefined}>
          <input type="number" value={g.host.port} min={1} max={65535} onChange={(e) => set('host', { port: Number(e.target.value) })} disabled={env('port')} />
        </FormGroup>
        <FormGroup label="URL Base" show={adv} help="For reverse proxy support, default is empty" restart warning={env('urlBase') ? 'Set by the REXARR_URL_BASE environment variable' : undefined}>
          <input type="text" value={g.host.urlBase} placeholder="/rexarr" onChange={(e) => set('host', { urlBase: e.target.value })} disabled={env('urlBase')} />
        </FormGroup>
        <FormGroup label="Instance Name" advanced show={adv} help="Instance name in tab and on the login page" restart>
          <input type="text" value={g.host.instanceName} onChange={(e) => set('host', { instanceName: e.target.value })} />
        </FormGroup>
        <FormGroup label="Application URL" advanced show={adv} help="This application's external URL including http(s)://, port and URL base. Used for webhook links.">
          <input type="text" value={g.host.applicationUrl} placeholder="https://rexarr.example.com" onChange={(e) => set('host', { applicationUrl: e.target.value })} />
        </FormGroup>
        <FormGroup label="Enable SSL" advanced show={adv} restart>
          <label className="check">
            <input type="checkbox" checked={g.host.enableSsl} onChange={(e) => set('host', { enableSsl: e.target.checked })} /> <span className="dim">Serve HTTPS on its own port as well as HTTP</span>
          </label>
        </FormGroup>
        {g.host.enableSsl && (
          <>
            <FormGroup label="SSL Port" advanced show={adv} restart>
              <input type="number" value={g.host.sslPort} min={1} max={65535} onChange={(e) => set('host', { sslPort: Number(e.target.value) })} />
            </FormGroup>
            <FormGroup label="SSL Cert Path" advanced show={adv} help="PEM certificate (fullchain.pem), or a .pfx / .p12 bundle" restart>
              <PathInput value={g.host.sslCertPath} onChange={(v) => set('host', { sslCertPath: v })} title="SSL certificate" placeholder="/config/ssl/fullchain.pem" />
            </FormGroup>
            {!/\.(pfx|p12)$/i.test(g.host.sslCertPath) && (
              <FormGroup label="SSL Key Path" advanced show={adv} help="PEM private key (privkey.pem)" restart>
                <PathInput value={g.host.sslKeyPath} onChange={(v) => set('host', { sslKeyPath: v })} title="SSL private key" placeholder="/config/ssl/privkey.pem" />
              </FormGroup>
            )}
            <FormGroup label="SSL Cert Password" advanced show={adv} help="For an encrypted key or .pfx bundle; leave empty otherwise" restart>
              <input type="password" value={g.host.sslCertPassword} autoComplete="new-password" onChange={(e) => set('host', { sslCertPassword: e.target.value })} />
            </FormGroup>
          </>
        )}
      </fieldset>

      <fieldset className="fieldSet">
        <legend>Security</legend>
        <FormGroup
          label="Authentication"
          show={adv}
          help="Require Username and Password to access rexarr"
          warning={g.security.authentication === 'none' && !localBind ? 'Without authentication anyone who can reach rexarr can change settings, grab releases and delete files. You can still skip it for local addresses.' : undefined}
        >
          <select value={g.security.authentication} onChange={(e) => set('security', { authentication: e.target.value as GeneralSettings['security']['authentication'] })}>
            <option value="none">None</option>
            <option value="basic">Basic (Browser Popup)</option>
            <option value="forms">Forms (Login Page)</option>
          </select>
        </FormGroup>
        {g.security.authentication !== 'none' && (
          <>
            <FormGroup label="Authentication Required" show={adv} help="Change which requests authentication is required for. Do not change unless you understand the risks.">
              <select value={g.security.authenticationRequired} onChange={(e) => set('security', { authenticationRequired: e.target.value as GeneralSettings['security']['authenticationRequired'] })}>
                <option value="enabled">Enabled</option>
                <option value="disabledForLocalAddresses">Disabled for Local Addresses</option>
              </select>
            </FormGroup>
            <FormGroup label="Username" show={adv}>
              <input type="text" value={g.security.username} autoComplete="username" onChange={(e) => set('security', { username: e.target.value })} />
            </FormGroup>
            <FormGroup label="Password" show={adv} help={g.security.passwordSet ? 'Leave empty to keep the current password' : 'At least 6 characters'}>
              <input type="password" value={password} placeholder={g.security.passwordSet ? '••••••••••••' : ''} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
            </FormGroup>
            <FormGroup label="Password Confirmation" show={adv} warning={password && confirmation && password !== confirmation ? 'Passwords do not match' : undefined}>
              <input type="password" value={confirmation} autoComplete="new-password" onChange={(e) => setConfirmation(e.target.value)} />
            </FormGroup>
          </>
        )}
        <FormGroup label="API Key" show={adv} help="Send as the X-Api-Key header or ?apikey= to reach the API (and webhooks) without logging in." restart>
          <div className="inputGroup">
            <input type="text" value={g.security.apiKey} readOnly className="mono" onFocus={(e) => e.target.select()} />
            <button className="inputGroupButton" title="Copy to clipboard" onClick={() => navigator.clipboard.writeText(g.security.apiKey).then(() => toast('info', 'API key copied'))}>
              <Icon.Copy />
            </button>
            <button className="inputGroupButton danger" title="Reset API Key" onClick={() => setConfirmRegen(true)}>
              <Icon.Refresh />
            </button>
          </div>
        </FormGroup>
        <FormGroup label="Certificate Validation" show={adv} help="Change how strict HTTPS certification validation is for Radarr, Sonarr, Prowlarr and other servers. Do not change unless you understand the risks.">
          <select value={g.security.certificateValidation} onChange={(e) => set('security', { certificateValidation: e.target.value as GeneralSettings['security']['certificateValidation'] })}>
            <option value="enabled">Enabled</option>
            <option value="disabledForLocalAddresses">Disabled for Local Addresses</option>
            <option value="disabled">Disabled</option>
          </select>
        </FormGroup>
      </fieldset>

      <fieldset className="fieldSet">
        <legend>Proxy</legend>
        <FormGroup label="Use Proxy" show={adv}>
          <label className="check">
            <input type="checkbox" checked={g.proxy.enabled} onChange={(e) => set('proxy', { enabled: e.target.checked })} />
          </label>
        </FormGroup>
        {g.proxy.enabled && (
          <>
            <FormGroup label="Proxy Type" show={adv} help="Used for AniDB data, cover art and *arr apps outside your network">
              <select value={g.proxy.type} onChange={() => undefined}>
                <option value="http">HTTP(S)</option>
              </select>
            </FormGroup>
            <FormGroup label="Hostname" show={adv}>
              <input type="text" value={g.proxy.hostname} placeholder="proxy.lan" onChange={(e) => set('proxy', { hostname: e.target.value })} />
            </FormGroup>
            <FormGroup label="Port" show={adv}>
              <input type="number" value={g.proxy.port} min={1} max={65535} onChange={(e) => set('proxy', { port: Number(e.target.value) })} />
            </FormGroup>
            <FormGroup label="Username" show={adv} help="You only need to enter a username and password if one is required. Leave them blank otherwise.">
              <input type="text" value={g.proxy.username} autoComplete="off" onChange={(e) => set('proxy', { username: e.target.value })} />
            </FormGroup>
            <FormGroup label="Password" show={adv}>
              <input type="password" value={g.proxy.password} autoComplete="new-password" onChange={(e) => set('proxy', { password: e.target.value })} />
            </FormGroup>
            <FormGroup label="Ignored Addresses" show={adv} help="Use ',' as a separator, and '*.' as a wildcard for subdomains">
              <input type="text" value={g.proxy.bypassFilter} placeholder="*.local, 192.168.1.*" onChange={(e) => set('proxy', { bypassFilter: e.target.value })} />
            </FormGroup>
            <FormGroup label="Bypass Proxy for Local Addresses" show={adv}>
              <label className="check">
                <input type="checkbox" checked={g.proxy.bypassLocalAddresses} onChange={(e) => set('proxy', { bypassLocalAddresses: e.target.checked })} />
              </label>
            </FormGroup>
          </>
        )}
      </fieldset>

      <fieldset className="fieldSet">
        <legend>Logging</legend>
        <FormGroup label="Log Level" show={adv} help={g.logging.level !== 'info' ? 'Debug and Trace also log every HTTP request; use them only while troubleshooting.' : undefined}>
          <select value={g.logging.level} onChange={(e) => set('logging', { level: e.target.value as GeneralSettings['logging']['level'] })}>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
            <option value="trace">Trace</option>
          </select>
        </FormGroup>
        <FormGroup label="Log Size Limit" advanced show={adv} help="Maximum log file size in MB before archiving. Default is 2MB.">
          <NumberWithUnit value={g.logging.sizeLimitMb} min={1} max={100} unit="MB" onChange={(n) => set('logging', { sizeLimitMb: n })} />
        </FormGroup>
      </fieldset>

      <fieldset className="fieldSet">
        <legend>Updates</legend>
        <FormGroup label="Branch" advanced show={adv} help="Branch used by external update mechanism">
          <input type="text" value={g.updates.branch} onChange={(e) => set('updates', { branch: e.target.value })} />
        </FormGroup>
        <FormGroup
          label="Automatic"
          advanced
          show={adv}
          warning={g.updates.mechanism === 'docker' ? 'Automatic updates are not directly supported when using the Docker update mechanism. You will need to update the container image outside of rexarr or use a script' : g.updates.automatic ? 'rexarr has no update server yet, so there is nothing to install automatically. Use a script or your package manager.' : undefined}
        >
          <label className="check">
            <input type="checkbox" checked={g.updates.automatic} disabled={g.updates.mechanism === 'docker'} onChange={(e) => set('updates', { automatic: e.target.checked })} />{' '}
            <span className="dim">Automatically download and install updates</span>
          </label>
        </FormGroup>
        <FormGroup label="Mechanism" advanced show={adv} help={g.updates.mechanism === 'docker' ? 'Pull the new image: docker compose pull && docker compose up -d' : g.updates.mechanism === 'script' ? 'Runs the script below to update' : 'Use a script or your package manager to update'}>
          <select value={g.updates.mechanism} onChange={(e) => set('updates', { mechanism: e.target.value as GeneralSettings['updates']['mechanism'], automatic: e.target.value === 'docker' ? false : g.updates.automatic })}>
            <option value="docker">Docker</option>
            <option value="script">Script</option>
            <option value="external">External</option>
          </select>
        </FormGroup>
        {g.updates.mechanism === 'script' && (
          <FormGroup label="Script Path" advanced show={adv} help="Path to a custom script that takes an extracted update package and handles the remainder of the update process">
            <PathInput value={g.updates.scriptPath} onChange={(v) => set('updates', { scriptPath: v })} title="Update script" />
          </FormGroup>
        )}
      </fieldset>

      <fieldset className="fieldSet">
        <legend>Backups</legend>
        <FormGroup label="Folder" advanced show={adv} help={`Relative paths will be under rexarr's config directory${rt ? ` (${rt.configDir})` : ''}. Empty uses ${rt?.defaultBackupFolder ?? 'the default Backups folder'}.`}>
          <PathInput value={g.backups.folder} onChange={(v) => set('backups', { folder: v })} folders title="Backup folder" placeholder={rt?.defaultBackupFolder ?? 'Backups'} />
        </FormGroup>
        <FormGroup label="Interval" advanced show={adv} help="Interval between automatic backups">
          <NumberWithUnit value={g.backups.intervalDays} min={1} max={7} unit="days" onChange={(n) => set('backups', { intervalDays: n })} />
        </FormGroup>
        <FormGroup label="Retention" advanced show={adv} help="Automatic backups older than the retention period will be cleaned up automatically">
          <NumberWithUnit value={g.backups.retentionDays} min={1} max={90} unit="days" onChange={(n) => set('backups', { retentionDays: n })} />
        </FormGroup>
      </fieldset>

      {!adv && <div className="formHelp" style={{ textAlign: 'center', marginBottom: 20 }}>Some settings are hidden. Use Show Advanced in the toolbar to see Bind Address, SSL, Updates and Backups.</div>}

      {confirmRegen && (
        <Modal
          title="Reset API Key"
          onClose={() => setConfirmRegen(false)}
          small
          footer={
            <>
              <button className="btn" onClick={() => setConfirmRegen(false)}>
                Cancel
              </button>
              <button className="btn danger" onClick={regenerate}>
                Reset
              </button>
            </>
          }
        >
          Are you sure you want to reset your API Key? Scripts and *arr webhooks that use the current key stop working until they are updated.
        </Modal>
      )}
    </Page>
  );
}
