/**
 * Stand-in for the Kortix control plane's session store.
 *
 * Append-only JSONL per session, over HTTP. Two routes:
 *   POST /sessions/:id/log   append one item
 *   GET  /sessions/:id/log   read the whole log
 *
 * In production this is the Kortix API backed by Postgres or object storage.
 * The point of it being a separate process here is that it OUTLIVES the
 * worker: killing the worker must not take the conversation with it.
 */
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export async function startStoreService(opts: { root: string; port?: number }) {
  const root = resolve(opts.root);
  await mkdir(root, { recursive: true });
  const fileFor = (id: string) => join(root, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);

  const server = createServer((req, res) => {
    const m = /^\/sessions\/([^/]+)\/log$/.exec(req.url ?? '');
    if (!m) { res.writeHead(404).end(); return; }
    const file = fileFor(decodeURIComponent(m[1]));

    if (req.method === 'GET') {
      if (!existsSync(file)) { res.writeHead(404).end('[]'); return; }
      readFile(file, 'utf8').then((text) => {
        const items = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const payload = JSON.stringify(items);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }).end(payload);
      });
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          JSON.parse(body); // reject malformed before it reaches the log
          await appendFile(file, body.replace(/\n/g, ' ') + '\n');
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        } catch (e: any) {
          res.writeHead(400, { 'content-type': 'application/json' })
             .end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
      });
      return;
    }
    res.writeHead(405).end();
  });

  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '0.0.0.0', r));
  const port = (server.address() as any).port;
  return { port, root, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startStoreService({ root: process.env.STORE_ROOT ?? join(tmpdir(), 'kortix-session-store'), port: Number(process.env.PORT ?? 8200) })
    .then((s) => console.log(`[store-service] ${s.url}  root=${s.root}`));
}
