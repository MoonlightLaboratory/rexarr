import type { ArrConnection } from '../../../shared/types.js';

export class ArrError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'ArrError';
  }
}

export class ArrHttp {
  constructor(readonly conn: ArrConnection, private apiPrefix: string, private label: string) {}

  get configured() {
    return Boolean(this.conn.enabled && this.conn.url && this.conn.apiKey);
  }

  private url(pathname: string, query?: Record<string, string | number | boolean | undefined>) {
    const base = this.conn.url.replace(/\/+$/, '');
    const u = new URL(`${base}${this.apiPrefix}${pathname}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
      }
    }
    return u;
  }

  async request<T>(method: string, pathname: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    if (!this.conn.url || !this.conn.apiKey) throw new ArrError(`${this.label} is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await fetch(this.url(pathname, opts.query), {
        method,
        headers: {
          'X-Api-Key': this.conn.apiKey,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError' ? 'timed out' : (err as Error)?.message ?? String(err);
      throw new ArrError(`${this.label}: request failed (${msg})`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw new ArrError(`${this.label}: invalid API key`, 401);
    if (!res.ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { message?: string; error?: string } | { errorMessage?: string }[];
        detail = Array.isArray(j) ? j.map((e) => e.errorMessage).filter(Boolean).join('; ') : (j.message ?? j.error ?? '');
      } catch {
        /* ignore */
      }
      throw new ArrError(`${this.label}: HTTP ${res.status}${detail ? ` – ${detail}` : ''}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T>(pathname: string, query?: Record<string, string | number | boolean | undefined>, timeoutMs?: number) {
    return this.request<T>('GET', pathname, { query, timeoutMs });
  }
  post<T>(pathname: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>) {
    return this.request<T>('POST', pathname, { body, query });
  }
}
