import { INSTANCE_NAME, URL_BASE } from '../base';
import { APP_VERSION } from '@shared/version';
import { api } from '../api';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { DiscDrive, DiscRip, HealthCheck, Job } from '@shared/types';
import { Icon } from './Icons';
import { HeaderSearch } from './HeaderSearch';
import type { Toast } from '../hooks/useEvents';

const links = [
  { to: '/movies', label: 'Movies', icon: <Icon.Film /> },
  { to: '/series', label: 'Series', icon: <Icon.Tv /> },
  { to: '/music', label: 'Music', icon: <Icon.Music /> },
  { to: '/search', label: 'Search', icon: <Icon.Search /> },
  { to: '/activity', label: 'Activity', icon: <Icon.Activity /> },
  { to: '/discs', label: 'Discs', icon: <Icon.Disc /> },
  { to: '/profiles', label: 'Profiles', icon: <Icon.Sliders /> },
  {
    to: '/settings',
    label: 'Settings',
    icon: <Icon.Settings />,
    children: [
      { to: '/settings', label: 'Connections' },
      { to: '/settings/general', label: 'General' },
    ],
  },
  {
    to: '/system',
    label: 'System',
    icon: <Icon.Cpu />,
    children: [
      { to: '/system', label: 'Status' },
      { to: '/system/tasks', label: 'Tasks' },
      { to: '/system/backup', label: 'Backup' },
      { to: '/system/events', label: 'Events' },
      { to: '/system/logs', label: 'Log Files' },
    ],
  },
] as { to: string; label: string; icon: ReactNode; children?: { to: string; label: string }[] }[];

function readTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem('rexarr.theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** *arr style frame: 60px header, 210px sidebar (with status messages at the bottom), page content. */
/** Optical drive status rows for the sidebar footer: open / closed / loaded / reading / ripping. */
function DriveStatus({ drives, rips }: { drives: DiscDrive[]; rips: DiscRip[] }) {
  const real = drives.filter((d) => !d.virtual);
  const rows = real.length ? real : drives.slice(0, 2);
  if (!rows.length) {
    return (
      <Link to="/discs" className="sidebarDrive none" title="No optical drive detected – open Discs to add a virtual drive">
        <Icon.Disc />
        <span className="driveName">No optical drive</span>
        <span className="driveState muted">—</span>
      </Link>
    );
  }
  return (
    <>
      {rows.map((d) => {
        const rip = rips.find((r) => r.drivePath === d.path && ['scanning', 'ripping', 'transcoding', 'delivering'].includes(r.status));
        let state = d.state === 'open' ? 'Open' : d.state === 'loading' ? 'Loading' : d.state === 'loaded' ? 'Loaded' : d.state === 'empty' ? 'Closed' : 'Unknown';
        let cls = d.state === 'open' ? 'blue' : d.state === 'loaded' ? 'green' : d.state === 'loading' ? 'teal' : 'grey';
        if (rip?.status === 'scanning') {
          state = 'Reading';
          cls = 'teal';
        } else if (rip?.status === 'ripping') {
          state = `Ripping ${rip.progress.percent.toFixed(0)}%`;
          cls = 'gold';
        } else if (rip?.status === 'transcoding' || rip?.status === 'delivering') {
          state = rip.status === 'transcoding' ? 'Encoding' : 'Importing';
          cls = 'gold';
        }
        const model = (d.name || 'Optical drive').replace(/\s+\d+\.\d+$/, '').replace(/^(BD-RE|BD-ROM|DVD\+?-?RW|DVD-ROM)\s+/i, '').trim();
        return (
          <Link key={d.index} to="/discs" className="sidebarDrive" title={`${d.name} (${d.path})${d.discLabel ? ` – ${d.discLabel}` : ''}`}>
            <span className={`dot ${cls}${cls === 'gold' ? ' pulse' : ''}`} />
            <span className="driveName">{d.virtual ? `Virtual · ${d.discLabel ?? 'drive'}` : d.state === 'loaded' && d.discLabel ? d.discLabel : model || 'Optical drive'}</span>
            <span className={`driveState ${cls}`}>{state}</span>
          </Link>
        );
      })}
    </>
  );
}

const SIDEBAR_KEY = 'rexarr.sidebarWidth';
const SIDEBAR_DEFAULT = 210;
const SIDEBAR_MIN = 64;
const SIDEBAR_MAX = 380;
/** Dragged narrower than this, the sidebar snaps to icons only. */
const SIDEBAR_COLLAPSE_AT = 130;

function readSidebarWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_KEY));
    return n ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n)) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

/**
 * Sidebar width: drag the right edge (snaps to icons only below 130px), double-click it to collapse / expand,
 * or focus it and use ← →. Remembered per browser.
 */
function useSidebarWidth(pageRef: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(readSidebarWidth);
  const lastExpanded = useRef(width >= SIDEBAR_COLLAPSE_AT ? width : SIDEBAR_DEFAULT);
  const snap = (w: number) => (w < SIDEBAR_COLLAPSE_AT ? SIDEBAR_MIN : Math.min(SIDEBAR_MAX, Math.round(w)));
  const commit = (w: number) => {
    const next = snap(w);
    if (next >= SIDEBAR_COLLAPSE_AT) lastExpanded.current = next;
    setWidth(next);
    pageRef.current?.style.setProperty('--sidebarWidth', `${next}px`);
    try {
      localStorage.setItem(SIDEBAR_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const page = pageRef.current;
    const left = page?.querySelector('.sidebar')?.getBoundingClientRect().left ?? 0;
    let current = width;
    document.body.classList.add('resizingSidebar');
    // Live width goes straight to the CSS variable; React only re-renders once, on release.
    const move = (ev: PointerEvent) => {
      current = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX - left));
      page?.style.setProperty('--sidebarWidth', `${current}px`);
      page?.classList.toggle('sidebarCollapsed', current < SIDEBAR_COLLAPSE_AT);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizingSidebar');
      commit(current);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const toggle = () => commit(width < SIDEBAR_COLLAPSE_AT ? lastExpanded.current : SIDEBAR_MIN);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') commit(width <= SIDEBAR_COLLAPSE_AT ? SIDEBAR_MIN : Math.max(SIDEBAR_COLLAPSE_AT, width - 20));
    else if (e.key === 'ArrowRight') commit(width < SIDEBAR_COLLAPSE_AT ? SIDEBAR_COLLAPSE_AT : width + 20);
    else if (e.key === 'Enter' || e.key === ' ') toggle();
    else if (e.key === 'Home') commit(SIDEBAR_DEFAULT);
    else return;
    e.preventDefault();
  };

  return { width, collapsed: width < SIDEBAR_COLLAPSE_AT, onPointerDown, onKeyDown, toggle };
}

export function Layout({ children, jobs, rips, drives, health, connected, toasts, toastControls }: { children: ReactNode; jobs: Job[]; rips: DiscRip[]; drives: DiscDrive[]; health: HealthCheck[]; connected: boolean; toasts: Toast[]; toastControls: { dismiss: (id: number) => void; pause: (id: number) => void; resume: (id: number) => void } }) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const sidebar = useSidebarWidth(pageRef);
  const [phone, setPhone] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  const encoding = jobs.filter((j) => j.status === 'encoding');
  const progressLabel = encoding.length === 1 ? `${Math.floor(encoding[0].progress.percent)}%` : encoding.length > 1 ? `${encoding.length} encoding` : '';
  useEffect(() => {
    tabTitle.progress = progressLabel;
    applyTabTitle();
  }, [progressLabel]);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [authMode, setAuthMode] = useState<string>('none');
  useEffect(() => {
    api.authStatus().then((a) => setAuthMode(a.authentication)).catch(() => undefined);
  }, []);
  const [theme, setTheme] = useState<'dark' | 'light'>(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('rexarr.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const active = jobs.filter((j) => ['probing', 'encoding', 'finalizing'].includes(j.status)).length;
  const pending = jobs.filter((j) => ['queued', 'waiting'].includes(j.status)).length;
  const activeRips = rips.filter((r) => ['inserted', 'scanning', 'ready', 'ripping', 'transcoding', 'delivering'].includes(r.status)).length;
  const healthErrors = health.filter((h) => h.type === 'error').length;
  const healthWarnings = health.filter((h) => h.type === 'warning').length;

  // Messages sit at the bottom of the sidebar; on phones the sidebar is off-canvas, so they float over the page instead.
  const messages = (
            <div className="sidebarMessages" role="status" aria-live="polite">
              {toasts.map((t) => (
                <div key={t.id} className={`toastMessage toast-${t.level}`} role={t.level === 'error' ? 'alert' : undefined} onMouseEnter={() => toastControls.pause(t.id)} onMouseLeave={() => toastControls.resume(t.id)}>
                  <span className="toastIcon">{t.level === 'info' ? <Icon.Check /> : <Icon.Alert />}</span>
                  <span className="toastText">
                    {t.message}
                    {t.count > 1 && <span className="toastCount">×{t.count}</span>}
                  </span>
                  <button className="toastClose" onClick={() => toastControls.dismiss(t.id)} title="Dismiss" aria-label="Dismiss">
                    <Icon.X />
                  </button>
                </div>
              ))}
            </div>
  );

  return (
    <div ref={pageRef} className={`page${sidebar.collapsed ? ' sidebarCollapsed' : ''}`} style={{ '--sidebarWidth': `${sidebar.width}px` } as React.CSSProperties}>
      <header className="pageHeader">
        <button className="headerLink sidebarToggle" onClick={() => setSidebarOpen((o) => !o)} title="Menu">
          <Icon.Menu />
        </button>
        <div className="logoContainer">
          <Link to="/" className="logoLink" title="Rexarr" draggable={false}>
            <span className="appName withTag">
              Rexarr
              <span className="betaTag">beta</span>
            </span>
            <span className="appName short">R</span>
          </Link>
        </div>
        <HeaderSearch />
        <div className="headerRight">
          <button className="headerLink" title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Icon.Sun /> : <Icon.Moon />}
          </button>
          <a className="headerLink" href="https://github.com/Sonarr/Sonarr/wiki" target="_blank" rel="noreferrer" title="Wiki">
            <Icon.Question />
          </a>
          <Link className="headerLink" to="/system" title="System">
            <Icon.Cpu />
          </Link>
          <Link className="headerLink" to="/settings" title="Settings">
            <Icon.Settings />
          </Link>
          {authMode === 'forms' && (
            <a className="headerLink" href={`${URL_BASE}/logout`} title="Logout">
              <Icon.User />
            </a>
          )}
        </div>
      </header>
      <div className="pageBody">
        {sidebarOpen && <div className="sidebarBackdrop" onClick={() => setSidebarOpen(false)} />}
        <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
          <nav className="nav">
            {links.map((l) => {
              const parentActive = l.children ? pathname === l.to || pathname.startsWith(l.to + '/') : false;
              return (
              <div key={l.to} className={parentActive ? 'navGroup active' : 'navGroup'}>
              <NavLink to={l.to} end={Boolean(l.children)} className={({ isActive }) => (isActive || parentActive ? 'active' : '')} onClick={() => setSidebarOpen(false)} draggable={false} title={sidebar.collapsed ? l.label : undefined}>
                <span className="iconContainer">{l.icon}</span>
                <span className="navLabel">{l.label}</span>
                {l.to === '/activity' && (active > 0 || pending > 0) && (
                  <span className="status">
                    {active > 0 && <span className="badge remux sm">{active}</span>}
                    {pending > 0 && <span className="badge sm">{pending}</span>}
                  </span>
                )}
                {l.to === '/discs' && activeRips > 0 && (
                  <span className="status">
                    <span className="badge remux sm">{activeRips}</span>
                  </span>
                )}
                {l.to === '/system' && (healthErrors > 0 || healthWarnings > 0) && (
                  <span className="status" title={`${healthErrors} error(s), ${healthWarnings} warning(s)`}>
                    <span className={`badge sm ${healthErrors ? 'red' : 'warning'}`}>{healthErrors + healthWarnings}</span>
                  </span>
                )}
              </NavLink>
              {l.children && parentActive && (
                <div className="navChildren">
                  {l.children.map((c) => (
                    <NavLink key={c.to} to={c.to} end className={({ isActive }) => `childLink${isActive ? ' active' : ''}`} onClick={() => setSidebarOpen(false)} draggable={false}>
                      {c.label}
                    </NavLink>
                  ))}
                </div>
              )}
              </div>
              );
            })}
          </nav>
          {!phone && messages}
          <div className="sidebarDrives">
            <DriveStatus drives={drives} rips={rips} />
          </div>
          <div className="sidebarStatus" title={sidebar.collapsed ? (connected ? `Connected · v${APP_VERSION}` : 'Reconnecting…') : undefined}>
            <span className={`dot${connected ? '' : ' off'}`} />
            <span className="statusText">{connected ? 'Connected' : 'Reconnecting…'}</span>
            <span className="spacer" />
            <span className="muted statusText">v{APP_VERSION}</span>
          </div>
          <div
            className="sidebarResizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            aria-valuenow={sidebar.width}
            tabIndex={0}
            title="Drag to resize · double-click to collapse or expand"
            onPointerDown={sidebar.onPointerDown}
            onDoubleClick={sidebar.toggle}
            onKeyDown={sidebar.onKeyDown}
          />
        </aside>
        <main className="pageContent">{children}</main>
        {phone && createPortal(<div className="floatingMessages">{messages}</div>, document.body)}
      </div>
    </div>
  );
}

/** Browser tab title: the page name, prefixed with encode progress while something is encoding ("42% · Movies"). */
const tabTitle = { page: '', progress: '' };
function applyTabTitle() {
  document.title = `${tabTitle.progress ? `${tabTitle.progress} · ` : ''}${tabTitle.page || INSTANCE_NAME} - ${INSTANCE_NAME}`;
}

/** Page = 60px toolbar (left/right sections) + scrollable body, like Sonarr's PageContent. */
export function Page({ title, toolbarLeft, toolbarRight, actions, children, narrow, flush }: { title: string; toolbarLeft?: ReactNode; toolbarRight?: ReactNode; actions?: ReactNode; children: ReactNode; narrow?: boolean; flush?: boolean }) {
  useEffect(() => {
    tabTitle.page = title;
    applyTabTitle();
  }, [title]);
  return (
    <>
      <div className="pageToolbar">
        <div className="toolbarSection left">{toolbarLeft ?? actions}</div>
        <div className="toolbarSection right">{toolbarRight}</div>
      </div>
      <div className="contentBody">
        <div className={`innerContentBody${narrow ? ' narrow' : ''}${flush ? ' flush' : ''}`}>{children}</div>
      </div>
    </>
  );
}

/** Icon-over-label toolbar button, 60px wide. */
export function ToolbarButton({ icon, label, onClick, disabled, busy, selected, title, wide, indicator, to }: { icon: ReactNode; label: string; onClick?: () => void; disabled?: boolean; busy?: boolean; selected?: boolean; title?: string; wide?: boolean; indicator?: boolean; to?: string }) {
  const cls = `toolbarButton${selected ? ' selected' : ''}${wide ? ' wide' : ''}`;
  const inner = (
    <>
      {busy ? <span className="spinner" style={{ width: 18, height: 18 }} /> : icon}
      <div className="labelContainer">
        <div className="label">{label}</div>
      </div>
      {indicator && <span className="indicator" />}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={cls} title={title ?? label}>
        {inner}
      </Link>
    );
  }
  return (
    <button className={cls} onClick={onClick} disabled={disabled || busy} title={title ?? label}>
      {inner}
    </button>
  );
}

export function ToolbarSeparator() {
  return <div className="toolbarSeparator" />;
}

export function ToolbarText({ children }: { children: ReactNode }) {
  return <div className="toolbarText">{children}</div>;
}

export interface MenuItemDef {
  key: string;
  label: ReactNode;
  onSelect?: () => void;
  selected?: boolean;
  disabled?: boolean;
  header?: boolean;
  separator?: boolean;
  icon?: ReactNode;
}

/** Toolbar dropdown menu (sort / filter / view) matching Sonarr's ToolbarMenuButton. Rendered in a portal so no ancestor can clip it. */
export function ToolbarMenu({ icon, label, items, align = 'right', selected }: { icon: ReactNode; label: string; items: MenuItemDef[]; align?: 'left' | 'right'; selected?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos(align === 'left' ? { top: r.bottom, left: r.left } : { top: r.bottom, right: Math.max(0, window.innerWidth - r.right) });
  };
  const toggle = () => {
    if (!open) place();
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onMove = () => place();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="toolbarMenu">
      <button ref={btnRef} className={`toolbarButton${selected ? ' selected' : ''}${open ? ' open' : ''}`} onClick={toggle} title={label} aria-haspopup="menu" aria-expanded={open}>
        {icon}
        <div className="labelContainer">
          <div className="label">{label}</div>
        </div>
        <span className="caret">▾</span>
      </button>
      {open &&
        createPortal(
          <div ref={menuRef} className="menuContent portal" role="menu" style={{ top: pos.top, left: pos.left, right: pos.right }}>
            {items.map((it) =>
              it.separator ? (
                <div key={it.key} className="menuSeparator" />
              ) : it.header ? (
                <div key={it.key} className="menuHeader">
                  {it.label}
                </div>
              ) : (
                <button
                  key={it.key}
                  role="menuitem"
                  className={`menuItem${it.selected ? ' selected' : ''}`}
                  disabled={it.disabled}
                  onClick={() => {
                    it.onSelect?.();
                    setOpen(false);
                  }}
                >
                  <span className="checkmark">{it.selected ? <Icon.Check /> : it.icon ?? null}</span>
                  <span className="truncate">{it.label}</span>
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
