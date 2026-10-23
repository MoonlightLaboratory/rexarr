/**
 * Keyboard shortcuts, in the shape the *arr apps and GitHub already taught people: `g` then a letter goes
 * somewhere, `?` says what the letters are.
 *
 * A chord rather than single keys on purpose. A bare `d` for Discs would fire the moment someone searching for
 * "Die Hard" typed the first letter of it — this listener is on the window, so it sees everything. Typing is left
 * alone anyway (inputs, textareas, anything contenteditable), but a chord means that even a missed case costs a
 * stray `g` rather than a page change under the user.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './Modal';

export const SHORTCUTS: { keys: string; label: string; to?: string }[] = [
  { keys: 'g h', label: 'Home', to: '/' },
  { keys: 'g m', label: 'Movies', to: '/movies' },
  { keys: 'g s', label: 'Series', to: '/series' },
  { keys: 'g u', label: 'Music', to: '/music' },
  { keys: 'g d', label: 'Discs', to: '/discs' },
  { keys: 'g a', label: 'Activity', to: '/activity' },
  { keys: 'g p', label: 'Profiles', to: '/profiles' },
  { keys: 'g c', label: 'Settings', to: '/settings' },
  { keys: 'g y', label: 'System', to: '/system' },
  { keys: '/', label: 'Search' },
  { keys: 'Ctrl/Cmd + K', label: 'Search' },
  { keys: '?', label: 'This list' },
  { keys: 'Esc', label: 'Close what is open' },
];

/** Is the user typing into something, rather than at the page? */
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return Boolean(el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable));
}

export function Shortcuts() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // how long ago `g` was pressed; a chord that is never finished simply expires
  const armed = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'g') {
        armed.current = Date.now();
        return;
      }
      if (!armed.current || Date.now() - armed.current > 1500) return;
      armed.current = 0;
      const hit = SHORTCUTS.find((s) => s.to && s.keys === `g ${e.key.toLowerCase()}`);
      if (!hit?.to) return;
      e.preventDefault();
      setOpen(false);
      navigate(hit.to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setOpen(false)} small>
      <div className="shortcutList">
        {SHORTCUTS.map((s) => (
          <div key={s.keys + s.label} className="shortcutRow">
            <kbd>{s.keys}</kbd>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
      <p className="small dim" style={{ marginTop: 12 }}>
        Press <kbd>g</kbd> then the letter. Nothing fires while you are typing.
      </p>
    </Modal>
  );
}
