/**
 * Settings → Experiments → barcode scanning.
 *
 * The phone opens /scan (the QR on the Experiments page carries the address, and the API key when authentication
 * is on), reads a disc's barcode, and posts it here. Rexarr looks the number up, matches it against the library
 * the way it matches a disc label, and - once confirmed - adds the title to Radarr / Sonarr and remembers that the
 * disc is on its way.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import qrcode from 'qrcode-generator';
import type { ExpectedDisc } from '../../../shared/types.js';
import { lookupBarcode, normaliseCode, rankAgainstLibrary, toExpected } from '../barcode.js';
import { wantedDiscs } from '../wanted.js';
import { arr } from '../arr/index.js';
import { discs } from '../disc/manager.js';
import { store } from '../store.js';
import { appEvents } from '../system.js';
import { hostRuntime } from '../runtime.js';

const enabled = () => store.settings.experiments?.barcode === true;

export default async function barcodeRoutes(app: FastifyInstance) {
  /** The page the QR points at, with the key when it is needed. */
  app.get('/api/scan/qr.svg', async (req, reply) => {
    if (!enabled()) return reply.code(404).send({ error: 'Barcode scanning is off (Settings → Experiments)' });
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || `localhost:${hostRuntime().port}`;
    const proto = (req.headers['x-forwarded-proto'] as string) || (req.protocol ?? 'http');
    const base = store.settings.general.host.applicationUrl?.trim().replace(/\/+$/, '') || `${proto}://${host}`;
    const key = store.settings.general.security.authentication !== 'none' ? `?apikey=${store.settings.general.security.apiKey}` : '';
    const url = `${base}${store.settings.general.host.urlBase ?? ''}/scan${key}`;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    reply.header('cache-control', 'no-store');
    reply.type('image/svg+xml');
    return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
  });

  /** What is this barcode? Returns the product, the best library match and what the *arr apps would add. */
  app.post('/api/barcode/lookup', async (req, reply) => {
    if (!enabled()) return reply.code(404).send({ error: 'Barcode scanning is off (Settings → Experiments)' });
    const body = z.object({ code: z.string().min(4).max(32) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'code required' });
    const code = normaliseCode(body.data.code);
    if (!code) return reply.code(400).send({ error: `"${body.data.code}" is not a barcode (8 to 14 digits)` });
    try {
      const product = await lookupBarcode(code);
      if (!product) return reply.code(404).send({ error: `Nothing found for ${code}. Type the title in on the Discs page instead.`, code });
      const { radarr, sonarr } = arr();
      const [movies, series] = await Promise.all([
        radarr.configured ? radarr.movies().catch(() => []) : Promise.resolve([]),
        sonarr.configured ? sonarr.series().catch(() => []) : Promise.resolve([]),
      ]);
      const candidates = [
        ...movies.map((m) => ({ kind: 'movie' as const, id: m.id, externalId: m.tmdbId, title: m.title, year: m.year, alternateTitles: m.alternateTitles })),
        ...series.map((s) => ({ kind: 'series' as const, id: s.id, externalId: s.tvdbId, title: s.title, year: s.year, alternateTitles: s.alternateTitles })),
      ];
      const inLibrary = rankAgainstLibrary(product, candidates);
      // Not in the library: ask the *arr apps what the title is, so it can be added
      let lookup: { kind: 'movie' | 'series'; title: string; year?: number; externalId: number; poster?: string }[] = [];
      if (!inLibrary) {
        const term = product.title;
        const [m, s] = await Promise.all([
          product.kind !== 'series' && radarr.configured ? radarr.lookup(term).catch(() => []) : Promise.resolve([]),
          product.kind !== 'movie' && sonarr.configured ? sonarr.lookup(term).catch(() => []) : Promise.resolve([]),
        ]);
        lookup = [
          ...m.slice(0, 5).map((x) => ({ kind: 'movie' as const, title: x.title, year: x.year, externalId: x.externalId, poster: x.poster })),
          ...s.slice(0, 5).map((x) => ({ kind: 'series' as const, title: x.title, year: x.year, externalId: x.externalId, poster: x.poster })),
        ];
      }
      return { product, inLibrary: inLibrary ? { ...inLibrary.item, season: inLibrary.season, score: inLibrary.score } : null, lookup };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Confirm a scan: add the title if it is not there, and remember the disc is coming. */
  app.post('/api/barcode/expected', async (req, reply) => {
    if (!enabled()) return reply.code(404).send({ error: 'Barcode scanning is off (Settings → Experiments)' });
    const body = z
      .object({
        code: z.string().min(4).max(32),
        kind: z.enum(['movie', 'series']),
        title: z.string().min(1).max(300),
        year: z.number().int().optional(),
        seasonNumber: z.number().int().min(0).optional(),
        externalId: z.number().int().optional(),
        arrId: z.number().int().optional(),
        product: z.string().max(300).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const d = body.data;
    const code = normaliseCode(d.code) ?? d.code;
    let arrId = d.arrId;
    const notes: string[] = [];
    if (!arrId && d.externalId) {
      try {
        const media = { kind: d.kind, title: d.title, year: d.year, externalId: d.externalId } as Parameters<typeof discs.addMediaToLibrary>[0];
        arrId = await discs.addMediaToLibrary(media, (line) => notes.push(line));
      } catch (err) {
        return reply.code(400).send({ error: `Could not add ${d.title}: ${(err as Error).message}` });
      }
    }
    const entry: ExpectedDisc = toExpected(
      { code, product: d.product ?? d.title, title: d.title, year: d.year, seasonNumber: d.seasonNumber, kind: d.kind, source: 'upcitemdb' },
      { arrId, kind: d.kind },
    );
    store.setExpectedDiscs([entry, ...store.expectedDiscs.filter((e) => e.code !== code)].slice(0, 100));
    appEvents.add('info', 'Barcode', `${d.title} scanned (${code})${arrId ? ' and added to the library' : ''}; waiting for the disc`);
    return { expected: entry, notes };
  });

  /** The ripping to-do list: what Radarr and Sonarr would like a better copy of, and which disc would do it. */
  app.get('/api/wanted', async (_req, reply) => {
    if (store.settings.experiments?.wanted !== true) return reply.code(404).send({ error: 'The ripping to-do list is off (Settings → Experiments)' });
    try {
      return await wantedDiscs();
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get('/api/barcode/expected', async (_req, reply) => {
    if (!enabled()) return reply.code(404).send({ error: 'Barcode scanning is off (Settings → Experiments)' });
    return store.expectedDiscs;
  });

  app.delete<{ Params: { id: string } }>('/api/barcode/expected/:id', async (req) => {
    store.setExpectedDiscs(store.expectedDiscs.filter((e) => e.id !== req.params.id));
    return { ok: true };
  });
}
