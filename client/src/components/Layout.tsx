import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import type { DiscRip, HealthCheck, Job } from '@shared/types';
import { Icon } from './Icons';
import type { Toast } from '../hooks/useEvents';

const links = [
  { to: '/movies', label: 'Movies', icon: <Icon.Film /> },
  { to: '/series', label: 'Series', icon: <Icon.Tv /> },
  { to: '/search', label: 'Search', icon: <Icon.Search /> },
  { to: '/activity', label: 'Activity', icon: <Icon.Activity /> },
  { to: '/discs', label: 'Discs', icon: <Icon.Disc /> },
  { to: '/profiles', label: 'Profiles', icon: <Icon.Sliders /> },
  { to: '/settings', label: 'Settings', icon: <Icon.Settings /> },
  { to: '/system', label: 'System', icon: <Icon.Cpu /> },
];

function readTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem('rexarr.theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** *arr style frame: 60px header, 210px sidebar (with status messages at the bottom), page content. */
export function Layout({ children, jobs, rips, health, connected, toasts }: { children: ReactNode; jobs: Job[]; rips: DiscRip[]; health: HealthCheck[]; connected: boolean; toasts: Toast[] }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // "/" focuses the global search, like the *arr apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === '/' && !(t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  return (
    <div className="page">
      <header className="pageHeader">
        <button className="headerLink sidebarToggle" onClick={() => setSidebarOpen((o) => !o)} title="Menu">
          <Icon.Menu />
        </button>
        <div className="logoContainer">
          <Link to="/" className="logoLink">
            <span className="logo">RX</span>
            <span className="appName">rexarr</span>
          </Link>
        </div>
        <div className="headerSearch">
          <Icon.Search />
          <input
            ref={searchRef}
            type="text"
            placeholder="Search remux…  /"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && q.trim()) {
                nav(`/search?q=${encodeURIComponent(q.trim())}`);
                setQ('');
              }
            }}
          />
        </div>
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
        </div>
      </header>
      <div className="pageBody">
        {sidebarOpen && <div className="sidebarBackdrop" onClick={() => setSidebarOpen(false)} />}
        <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
          <nav className="nav">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'active' : '')} onClick={() => setSidebarOpen(false)}>
                <span className="iconContainer">{l.icon}</span>
                <span>{l.label}</span>
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
            ))}
          </nav>
          <div className="sidebarMessages">
            {toasts.map((t) => (
              <div key={t.id} className={`message ${t.level}`}>
                {t.level === 'error' ? <Icon.Alert /> : t.level === 'warn' ? <Icon.Alert /> : <Icon.Check />}
                <span>{t.message}</span>
              </div>
            ))}
          </div>
          <div className="sidebarStatus">
            <span className={`dot${connected ? '' : ' off'}`} />
            {connected ? 'Connected' : 'Reconnecting…'}
            <span className="spacer" />
            <span className="muted">v0.1.0</span>
          </div>
        </aside>
        <main className="pageContent">{children}</main>
      </div>
    </div>
  );
}

/** Page = 60px toolbar (left/right sections) + scrollable body, like Sonarr's PageContent. */
export function Page({ title, toolbarLeft, toolbarRight, actions, children, narrow, flush }: { title: string; toolbarLeft?: ReactNode; toolbarRight?: ReactNode; actions?: ReactNode; children: ReactNode; narrow?: boolean; flush?: boolean }) {
  useEffect(() => {
    document.title = `${title} - rexarr`;
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
