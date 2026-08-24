/**
 * `GET /v1/runtime-assets/agent` — the daemon binary this deploy bakes.
 *
 * Mounted here EXACTLY as apps/api/src/index.ts mounts it: one
 * `app.use('/v1/runtime-assets/*', <auth>)` wildcard in front of
 * `app.route('/v1/runtime-assets', runtimeAssetsApp)`. That is the property
 * worth testing — a payload route added beside the sub-app instead of inside it
 * would serve a ~96 MB root-executed binary to an unauthenticated caller. The
 * auth middleware is stubbed because `combinedAuth` needs a database; what is
 * under test is the WIRING, not the token parser.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAssetsApp } from '../index';
import { _resetRuntimeAssetsCache } from '../manifest';

const CLI_BIN_ENV = 'KORTIX_SNAPSHOT_CLI_BIN_PATH';
const AGENT_BIN_ENV = 'KORTIX_SNAPSHOT_AGENT_BIN_PATH';
const VERSION_ENV = 'KORTIX_VERSION';
const COMMIT_ENV = 'KORTIX_COMMIT';
const MANAGED_ENV = [CLI_BIN_ENV, AGENT_BIN_ENV, VERSION_ENV, COMMIT_ENV] as const;
const originalEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

const AGENT_BYTES = 'compiled-kortix-agent-elf';
const AGENT_SHA = new Bun.CryptoHasher('sha256').update(AGENT_BYTES).digest('hex');

/** The same mount shape as index.ts, with a stand-in for combinedAuth. */
function mountedApp() {
  const app = new Hono();
  app.use('/v1/runtime-assets/*', async (c, next) => {
    if (!c.req.header('Authorization')) return c.json({ error: true, status: 401 }, 401);
    await next();
  });
  app.route('/v1/runtime-assets', runtimeAssetsApp as never);
  return app;
}

async function stageAgent(bytes: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-assets-agent-route-'));
  tempDirs.push(dir);
  const path = join(dir, 'kortix-agent');
  await writeFile(path, bytes);
  return path;
}

beforeEach(() => {
  // Never the repo's real ~96 MB / ~104 MB dist artifacts.
  process.env[CLI_BIN_ENV] = join(tmpdir(), 'kortix-agent-route-unset-cli');
  process.env[AGENT_BIN_ENV] = join(tmpdir(), 'kortix-agent-route-unset-agent');
  delete process.env[VERSION_ENV];
  delete process.env[COMMIT_ENV];
  _resetRuntimeAssetsCache();
});

afterEach(async () => {
  for (const key of MANAGED_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetRuntimeAssetsCache();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('GET /v1/runtime-assets/agent', () => {
  test('is behind the same auth wildcard as /cli — no token, no binary', async () => {
    process.env[AGENT_BIN_ENV] = await stageAgent(AGENT_BYTES);
    _resetRuntimeAssetsCache();

    const app = mountedApp();
    const anonymous = await app.request('/v1/runtime-assets/agent');
    expect(anonymous.status).toBe(401);
    // The CLI route it mirrors behaves identically; both live inside the mount.
    expect((await app.request('/v1/runtime-assets/cli')).status).toBe(401);
    expect((await app.request('/v1/runtime-assets/manifest')).status).toBe(401);
  });

  test('streams the baked binary with a content-addressed ETag', async () => {
    process.env[AGENT_BIN_ENV] = await stageAgent(AGENT_BYTES);
    process.env[VERSION_ENV] = '0.13.1-dev.abc12345';
    process.env[COMMIT_ENV] = 'abc12345def';
    _resetRuntimeAssetsCache();

    const res = await mountedApp().request('/v1/runtime-assets/agent', {
      headers: { Authorization: 'Bearer kortix_pat_test' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe(`"${AGENT_SHA}"`);
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Length')).toBe(String(AGENT_BYTES.length));
    expect(res.headers.get('X-Kortix-Agent-Sha256')).toBe(AGENT_SHA);
    expect(res.headers.get('X-Kortix-Agent-Version')).toBe('0.13.1-dev.abc12345+abc12345');
    // The bytes on the wire must hash to the digest the manifest advertised —
    // that digest is the ONLY thing standing between a box and a bad binary.
    const body = await res.arrayBuffer();
    expect(new Bun.CryptoHasher('sha256').update(body).digest('hex')).toBe(AGENT_SHA);
  });

  test('honours If-None-Match with a 304 and no body', async () => {
    process.env[AGENT_BIN_ENV] = await stageAgent(AGENT_BYTES);
    _resetRuntimeAssetsCache();

    const res = await mountedApp().request('/v1/runtime-assets/agent', {
      headers: {
        Authorization: 'Bearer kortix_pat_test',
        'If-None-Match': `"${AGENT_SHA}"`,
      },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  test('HEAD reports the size without transferring ~96 MB', async () => {
    process.env[AGENT_BIN_ENV] = await stageAgent(AGENT_BYTES);
    _resetRuntimeAssetsCache();

    const res = await mountedApp().request('/v1/runtime-assets/agent', {
      method: 'HEAD',
      headers: { Authorization: 'Bearer kortix_pat_test' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(AGENT_BYTES.length));
    expect(res.headers.get('X-Kortix-Agent-Sha256')).toBe(AGENT_SHA);
    expect(await res.text()).toBe('');
  });

  test('404s when the image carries no agent binary — the same degradation as /cli', async () => {
    _resetRuntimeAssetsCache();
    const app = mountedApp();
    const headers = { Authorization: 'Bearer kortix_pat_test' };

    const res = await app.request('/v1/runtime-assets/agent', { headers });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: true,
      message: 'This deploy carries no sandbox agent binary',
      status: 404,
    });
    // …and the manifest agrees, so a box skips the agent half instead of
    // polling a route that will never answer.
    const manifest = (await (await app.request('/v1/runtime-assets/manifest', { headers })).json()) as {
      components: Record<string, unknown>;
    };
    expect(manifest.components.agent).toBeUndefined();
  });

  test('an absent agent does not take the CLI route down with it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-assets-agent-route-'));
    tempDirs.push(dir);
    const cliPath = join(dir, 'kortix');
    await writeFile(cliPath, 'compiled-kortix-cli');
    await writeFile(`${cliPath}.version`, '0.13.1+abc12345\n');
    process.env[CLI_BIN_ENV] = cliPath;
    _resetRuntimeAssetsCache();

    const app = mountedApp();
    const headers = { Authorization: 'Bearer kortix_pat_test' };
    expect((await app.request('/v1/runtime-assets/agent', { headers })).status).toBe(404);

    const cli = await app.request('/v1/runtime-assets/cli', { headers });
    expect(cli.status).toBe(200);
    // The v1 CLI headers are part of the deployed-daemon contract too.
    expect(cli.headers.get('X-Kortix-Cli-Sha256')).toBe(
      new Bun.CryptoHasher('sha256').update('compiled-kortix-cli').digest('hex'),
    );
    expect(cli.headers.get('X-Kortix-Cli-Version')).toBe('0.13.1+abc12345');
  });
});
