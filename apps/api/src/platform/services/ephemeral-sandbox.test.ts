import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realPlatinum from '../../shared/platinum';

// A box that booted before ephemeral sessions were on keeps its state on its
// own disk. Retiring it (commit + DELETE) is only safe once that state has been
// copied onto the session volume, which needs the box running.

let state = 'running';
let mounts: Array<{ id: string; sandbox_id: string; state: string; mount_path: string }> = [];
let calls: string[] = [];
let execScripts: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

mock.module('../../shared/platinum', () => ({
  ...realPlatinum,
  isPlatinumConfigured: () => true,
  platinumFetch: async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/v1/sandboxes/box-1') return json({ state });
    if (method === 'DELETE') return json({});
    if (method === 'PUT' && path.startsWith('/v1/volumes/')) return json({});
    if (method === 'GET' && path.endsWith('/mounts')) return json({ mounts: [] });
    if (method === 'GET' && path === '/v1/sandboxes/box-1/volumes') return json({ mounts });
    if (method === 'POST' && path.endsWith('/exec')) {
      execScripts.push(String(init.body));
      return json({ result: { exit_code: 0, stdout: '42\n' } });
    }
    if (method === 'POST' && path.endsWith('/commit')) return json({ commit_id: 'c1' });
    return json({});
  },
}));

mock.module('../../shared/db', () => ({
  db: { update: () => ({ set: () => ({ where: async () => [] }) }) },
}));

const { retireEphemeralBox, EphemeralRetireError } = await import('./ephemeral-sandbox');

beforeEach(() => {
  state = 'running';
  mounts = [];
  calls = [];
  execScripts = [];
});

describe('retireEphemeralBox on a box from before the flag', () => {
  test('a stopped box is not deleted: its state is still on its own disk', async () => {
    state = 'stopped';
    const err = await retireEphemeralBox({ externalId: 'box-1', sessionId: 's1', metadata: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(EphemeralRetireError);
    expect(err.phase).toBe('migrate');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  test('a running box with the volume already attached still copies its state before the delete', async () => {
    // An earlier migration attached the volume, then failed or was followed by
    // a plain stop; the box kept working on its own disk since.
    mounts = [{ id: 'm1', sandbox_id: 'box-1', state: 'mounted', mount_path: '/mnt/kortix-session' }];
    const t = await retireEphemeralBox({ externalId: 'box-1', sessionId: 's1', metadata: {} });
    expect(t.migrated).toBe(true);
    expect(execScripts.length).toBe(1);
    const exec = calls.findIndex((c) => c.endsWith('/exec'));
    const del = calls.findIndex((c) => c.startsWith('DELETE'));
    expect(exec).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(exec);
  });

  test('a box that booted with the volume is retired even when already stopped', async () => {
    state = 'stopped';
    await retireEphemeralBox({ externalId: 'box-1', sessionId: 's1', metadata: { sessionStateVolume: 'kss-s1' } });
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(true);
    expect(execScripts.length).toBe(0);
  });
});
