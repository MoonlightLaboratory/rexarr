/** Values the server injects into index.html (Settings → General → Host). */
declare global {
  interface Window {
    __REXARR__?: { urlBase?: string; instanceName?: string };
  }
}

/** Reverse proxy sub-path, e.g. "/rexarr"; "" when served at the root. */
export const URL_BASE = window.__REXARR__?.urlBase ?? '';
export const INSTANCE_NAME = window.__REXARR__?.instanceName ?? 'Rexarr';

/** Prefix an absolute app path ("/api/…") with the URL base. */
export const withBase = (p: string) => (p.startsWith('/') ? `${URL_BASE}${p}` : p);
