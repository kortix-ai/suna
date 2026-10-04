/**
 * `GET /v1/runtime-assets/chunk/{sha256}` — ONE chunk, not the file it came from.
 *
 * THE DEFECT THIS EXISTS FOR, found on a deployed preview and not by any unit
 * test: the handler returned `Bun.file(path).slice(offset, offset + length)
 * .stream()`, and on the API image's Bun that streamed the WHOLE FILE. A
 * request for one 1 MiB chunk answered `200` with all 116,127,104 bytes and no
 * `Content-Length` at all. The index was right, the manifest was right, the
 * digest check downstream still refused it — so the mechanism degraded safely
 * and delivered the exact opposite of the optimization it exists for.
 *
 * `chunks.test.ts` could not catch it: it tests `runtimeChunkSource`, which
 * answers WHERE the bytes are, never whether the route sends those and only
 * those. This file asserts the bytes on the wire.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAssetsApp } from '../../../http/runtime-assets/index';
import { RUNTIME_CHUNK_SIZE, _resetRuntimeAssetsCache } from '../manifest';

const CLI_BIN_ENV = 'KORTIX_SNAPSHOT_CLI_BIN_PATH';
const AGENT_BIN_ENV = 'KORTIX_SNAPSHOT_AGENT_BIN_PATH';
const ENTRYPOINT_ENV = 'KORTIX_SANDBOX_ENTRYPOINT_PATH';
const MANAGED_ENV = [CLI_BIN_ENV, AGENT_BIN_ENV, ENTRYPOINT_ENV] as const;
const originalEnv = new Map(MANAGED_ENV.map((k) => [k, process.env[k]]));
const dirs: string[] = [];

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Three full 1 MiB chunks plus a short tail, each chunk a distinct byte. */
function body(): Buffer {
  const tail = 1234;
  const out = Buffer.alloc(3 * RUNTIME_CHUNK_SIZE + tail);
  for (let i = 0; i < 3; i++) out.fill(i + 1, i * RUNTIME_CHUNK_SIZE, (i + 1) * RUNTIME_CHUNK_SIZE);
  out.fill(0xfe, 3 * RUNTIME_CHUNK_SIZE);
  return out;
}

function mountedApp() {
  const app = new Hono();
  app.use('/v1/runtime-assets/*', async (c, next) => {
    if (!c.req.header('Authorization')) return c.json({ error: true, status: 401 }, 401);
    await next();
  });
  app.route('/v1/runtime-assets', runtimeAssetsApp as never);
  return app;
}

async function stage(name: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-chunk-route-'));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

const authed = (app: ReturnType<typeof mountedApp>, path: string) =>
  app.request(`http://local${path}`, { headers: { Authorization: 'Bearer test' } });

beforeEach(() => {
  process.env[CLI_BIN_ENV] = join(tmpdir(), 'runtime-chunk-route-unset-cli');
  process.env[AGENT_BIN_ENV] = join(tmpdir(), 'runtime-chunk-route-unset-agent');
  process.env[ENTRYPOINT_ENV] = join(tmpdir(), 'runtime-chunk-route-unset-entrypoint');
  _resetRuntimeAssetsCache();
});

afterEach(async () => {
  for (const k of MANAGED_ENV) {
    const v = originalEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetRuntimeAssetsCache();
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

describe('GET /v1/runtime-assets/chunk/{sha256}', () => {
  test('sends that chunk and ONLY that chunk, with its own length', async () => {
    const bytes = body();
    process.env[CLI_BIN_ENV] = await stage('kortix', bytes);
    const app = mountedApp();

    const manifest = await (await authed(app, '/v1/runtime-assets/chunks/cli')).json();
    expect(manifest.chunks).toHaveLength(4);

    // A MIDDLE chunk: offset 0 would pass even for a handler that ignores the
    // offset and truncates, and the last would pass for one that ignores length.
    const index = 2;
    const want = bytes.subarray(index * RUNTIME_CHUNK_SIZE, (index + 1) * RUNTIME_CHUNK_SIZE);
    const res = await authed(app, `/v1/runtime-assets/chunk/${manifest.chunks[index]}`);

    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    // The bytes on the wire hash to the name they were requested under. This is
    // the assertion the deployed defect failed: it answered with the whole file.
    expect(sha(got)).toBe(manifest.chunks[index]);
    expect(got.length).toBe(RUNTIME_CHUNK_SIZE);
    expect(Buffer.compare(got, want)).toBe(0);
    expect(res.headers.get('content-length')).toBe(String(RUNTIME_CHUNK_SIZE));
    expect(res.headers.get('etag')).toBe(`"${manifest.chunks[index]}"`);
  });

  test('a short trailing chunk is served at its real length, not padded', async () => {
    const bytes = body();
    process.env[CLI_BIN_ENV] = await stage('kortix', bytes);
    const app = mountedApp();
    const manifest = await (await authed(app, '/v1/runtime-assets/chunks/cli')).json();

    const last = manifest.chunks[manifest.chunks.length - 1];
    const res = await authed(app, `/v1/runtime-assets/chunk/${last}`);
    const got = Buffer.from(await res.arrayBuffer());

    expect(got.length).toBe(bytes.length - 3 * RUNTIME_CHUNK_SIZE);
    expect(sha(got)).toBe(last);
  });

  test('every chunk of both binaries reassembles into exactly the advertised file', async () => {
    const cli = body();
    const agent = Buffer.concat([Buffer.alloc(RUNTIME_CHUNK_SIZE, 9), Buffer.alloc(77, 8)]);
    process.env[CLI_BIN_ENV] = await stage('kortix', cli);
    process.env[AGENT_BIN_ENV] = await stage('kortix-agent', agent);
    const app = mountedApp();

    for (const [component, source] of [['cli', cli], ['agent', agent]] as const) {
      const m = await (await authed(app, `/v1/runtime-assets/chunks/${component}`)).json();
      const parts: Buffer[] = [];
      for (const digest of m.chunks) {
        const res = await authed(app, `/v1/runtime-assets/chunk/${digest}`);
        expect(res.status).toBe(200);
        parts.push(Buffer.from(await res.arrayBuffer()));
      }
      const assembled = Buffer.concat(parts);
      expect(assembled.length).toBe(m.size);
      expect(sha(assembled)).toBe(m.sha256);
      expect(Buffer.compare(assembled, source)).toBe(0);
    }
  });

  test('ANON gets nothing, and an unknown digest is a 404', async () => {
    process.env[CLI_BIN_ENV] = await stage('kortix', body());
    const app = mountedApp();
    const m = await (await authed(app, '/v1/runtime-assets/chunks/cli')).json();

    const anon = await app.request(`http://local/v1/runtime-assets/chunk/${m.chunks[0]}`);
    expect(anon.status).toBe(401);
    const unknown = await authed(app, `/v1/runtime-assets/chunk/${'1'.repeat(64)}`);
    expect(unknown.status).toBe(404);
  });
});
