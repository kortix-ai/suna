import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const BASE = '/v1/projects/project-1/connections';

// Exercise the real CLI and SDK transport; only the remote API is a fixture.
// An HTTP 200 acknowledgement alone must never certify a persisted revoke.
test.each([
  { name: 'persists revoked', ack: { ok: true }, state: 'revoked', code: 0 },
  { name: 'acknowledged but still active', ack: { ok: true }, state: 'active', code: 2 },
  { name: 'unexpected row status', ack: { ok: true }, state: 'error', code: 2 },
  { name: 'missing row is not proof', ack: { ok: true }, state: 'absent', code: 2 },
  { name: 'malformed acknowledgement', ack: {}, state: 'revoked', code: 2 },
  { name: 'null acknowledgement', ack: null, state: 'revoked', code: 2 },
  { name: 'malformed verification', ack: { ok: true }, state: 'malformed', code: 2 },
  { name: 'negative acknowledgement', ack: { ok: false }, state: 'revoked', code: 2 },
  { name: 'verification denied', ack: { ok: true }, state: 'denied', code: 1 },
  { name: 'mutation denied', ack: { ok: true }, state: 'revoked', mutationStatus: 403, code: 1 },
])('$name', async ({ ack, state, mutationStatus, code }) => {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(`${req.method} ${path}`);
      expect(req.headers.get('authorization')).toBe('Bearer kortix_pat_fixture');
      if (req.method === 'PUT' && path === `${BASE}/${CONNECTION_ID}/revoke`) {
        expect(await req.json()).toEqual({});
        return Response.json(mutationStatus ? { error: 'denied' } : ack, { status: mutationStatus ?? 200 });
      }
      if (req.method === 'GET' && path === BASE) {
        if (state === 'denied') return Response.json({ error: 'denied' }, { status: 403 });
        if (state === 'malformed') return Response.json({});
        return Response.json({ connections: state === 'absent' ? [] : [{
          connection_id: CONNECTION_ID,
          connector_alias: 'fixture',
          owner_type: 'project',
          owner_id: null,
          // A manager can revoke a shared account outside their audience.
          usable: false,
          status: state,
        }] });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  const cwd = mkdtempSync(join(tmpdir(), 'kortix-revoke-'));
  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, '../index.ts'), 'connectors', 'connections', 'revoke', CONNECTION_ID, '--json'],
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        KORTIX_CONFIG_FILE: join(cwd, 'config.json'),
        KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
        KORTIX_PROJECT_ID: 'project-1',
        KORTIX_SESSION_ID: '',
        KORTIX_TOKEN: 'kortix_pat_fixture',
        KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
        KORTIX_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => proc.kill(), 10_000);
    const [exit, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]).finally(() => clearTimeout(timeout));
    expect(exit).toBe(code);
    if (code === 0) {
      expect(JSON.parse(stdout)).toEqual({ ok: true });
      expect(stderr).toBe('');
    } else {
      expect(stdout).toBe('');
      expect(stderr.length).toBeGreaterThan(0);
    }
    expect(requests.filter((request) => request !== 'GET /v1/accounts/me')).toEqual([
      `PUT ${BASE}/${CONNECTION_ID}/revoke`,
      ...(!mutationStatus && ack?.ok === true ? [`GET ${BASE}`] : []),
    ]);
  } finally {
    server.stop(true);
    rmSync(cwd, { recursive: true, force: true });
  }
});
