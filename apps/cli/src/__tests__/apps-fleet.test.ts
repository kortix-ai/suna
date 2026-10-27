import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = '11111111-2222-4333-8444-555555555555';
const APP_ID = '99999999-8888-4777-8666-555555555555';
const MACHINE = 'aaaaaaaa-1111-4222-8333-444444444444';
const VOLUME = 'bbbbbbbb-1111-4222-8333-444444444444';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];

const machine = {
  machine_id: MACHINE, instance_id: 'i1', process_group: 'app', state: 'started',
  release: { deployment_id: 'd3', version: 3 }, vm: { cpu: 1, memory_gb: 1, disk_gb: 10 },
  volume: { volume_id: VOLUME, name: 'data' }, created_at: 't', started_at: 't', stopped_at: null,
};
const volume = {
  volume_id: VOLUME, name: 'data', process_group: 'app', machine_id: MACHINE, size_gb: 10, status: 'ready',
  attached: true, snapshot_retention_days: 5, created_at: 't', used_bytes: 1_610_612_736, last_commit_at: '2026-10-14T16:00:00.000Z',
};

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(path, JSON.stringify({
    active: 'test',
    hosts: { test: { url: apiBase, token: 'tok_apps', user_id: 'user_1', user_email: 'user@example.test', account_id: 'account_1', logged_in_at: '2026-01-01T00:00:00.000Z' } },
  }), 'utf8');
  return path;
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path, search: url.search, body });
      const appBase = `/v1/projects/${PROJECT}/apps/${APP_ID}`;
      if (path === `/v1/projects/${PROJECT}`) {
        return Response.json({ project_id: PROJECT, account_id: 'account_1', name: 'Atlas', repo_url: 'https://example.test/r.git', default_branch: 'main', manifest_path: 'kortix.yaml', status: 'active', metadata: {}, experimental: { apps: true }, created_at: 't', updated_at: 't' });
      }
      if (path === `/v1/projects/${PROJECT}/apps`) {
        return Response.json({ apps: [{ app_id: APP_ID, slug: 'db', name: 'db', url: 'https://db.example.test', scale: { app: 1 }, labels: ['backend'], capabilities: ['machines', 'volumes'] }] });
      }
      if (path === appBase && req.method === 'PATCH') return Response.json({ app_id: APP_ID, slug: 'db', labels: (body as { labels: string[] }).labels });
      if (path === `${appBase}/machines`) return Response.json({ machines: [machine] });
      if (path.startsWith(`${appBase}/machines/`)) return Response.json({ machines: [{ ...machine, state: path.endsWith('/stop') ? 'stopped' : 'started' }] });
      if (path === `${appBase}/scale`) return Response.json({ scale: (body as { count: Record<string, number> }).count, machines: [machine] }, { status: 202 });
      if (path === `${appBase}/exec`) {
        const command = (body as { command: string[] }).command;
        return Response.json({ machine_id: MACHINE, exit_code: command[0] === 'false' ? 1 : 0, stdout: `ran ${command.join(' ')}`, stderr: '', truncated: false });
      }
      if (path === `${appBase}/volumes` && req.method === 'GET') return Response.json({ volumes: [volume] });
      if (path === `${appBase}/volumes` && req.method === 'POST') return Response.json({ ...volume, name: (body as { name: string }).name, attached: false }, { status: 201 });
      if (path === `${appBase}/volumes/${VOLUME}/snapshots` && req.method === 'GET') return Response.json({ snapshots: [{ snapshot_id: 'daily-20261010', kind: 'daily', commit_id: 'c1', created_at: 't' }] });
      if (path === `${appBase}/volumes/${VOLUME}/restore`) return Response.json(volume, { status: 202 });
      if (path === `${appBase}/volumes/${VOLUME}/fork`) return Response.json({ ...volume, name: 'copy', attached: false }, { status: 201 });
      if (path === `${appBase}/volumes/${VOLUME}` && req.method === 'PATCH') return Response.json({ ...volume, ...(body as object) });
      if (path === `${appBase}/volumes/${VOLUME}` && req.method === 'DELETE') return Response.json({ volume_id: VOLUME, status: 'destroying' });
      return Response.json({ error: `unexpected ${req.method} ${path}` }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

async function runCli(args: string[], configFile?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env, KORTIX_NO_UPDATE_CHECK: '1', NO_COLOR: '1', FORCE_COLOR: '0', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) delete env[key];
  const proc = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd: tmp, env, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

const last = (method: string) => calls.filter((c) => c.method === method).at(-1);

describe('kortix apps machines | scale | exec | volumes | labels', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-apps-fleet-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
  });
  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('machines ls prints each machine; stop takes an 8-character id prefix', async () => {
    const config = writeConfig(startServer());
    const ls = await runCli(['apps', 'machines', 'db', '--project', PROJECT], config);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toMatch(/aaaaaaaa\s+app\s+started\s+v3\s+1 vCPU · 1 GB\s+data/);
    const stop = await runCli(['apps', 'machines', 'stop', 'db', 'aaaaaaaa', '--project', PROJECT], config);
    expect(stop.code).toBe(0);
    expect(last('POST')?.path).toBe(`/v1/projects/${PROJECT}/apps/${APP_ID}/machines/${MACHINE}/stop`);
    expect(stop.stdout).toContain('stopped');
  });

  test('scale count sends the group and number; 0 is allowed, 21 is refused before any request', async () => {
    const config = writeConfig(startServer());
    const up = await runCli(['apps', 'scale', 'count', 'db', '3', '--process', 'worker', '--project', PROJECT], config);
    expect(up.code).toBe(0);
    expect(last('PUT')?.body).toEqual({ count: { worker: 3 } });
    const zero = await runCli(['apps', 'scale', 'count', 'db', '0', '--project', PROJECT], config);
    expect(zero.code).toBe(0);
    expect(last('PUT')?.body).toEqual({ count: { app: 0 } });
    const before = calls.length;
    const tooMany = await runCli(['apps', 'scale', 'count', 'db', '21', '--project', PROJECT], config);
    expect(tooMany.code).not.toBe(0);
    expect(calls.length).toBe(before);
  });

  test('scale count --new-volumes accepts one new, empty volume per machine of a group with a volume', async () => {
    const config = writeConfig(startServer());
    const up = await runCli(['apps', 'scale', 'count', 'db', '2', '--new-volumes', '--project', PROJECT], config);
    expect(up.code).toBe(0);
    expect(last('PUT')?.body).toEqual({ count: { app: 2 }, new_volumes: true });
  });

  test('exec passes everything after -- verbatim (flags included) and exits with the command\'s code', async () => {
    const config = writeConfig(startServer());
    const ok = await runCli(['apps', 'exec', 'db', '--project', PROJECT, '--', 'ls', '-la', '--json', '/data'], config);
    expect(ok.code).toBe(0);
    expect(last('POST')?.body).toEqual({ command: ['ls', '-la', '--json', '/data'] });
    expect(ok.stdout).toContain('ran ls -la --json /data');
    const failed = await runCli(['apps', 'exec', 'db', '--project', PROJECT, '--', 'false'], config);
    expect(failed.code).toBe(1);
    const missing = await runCli(['apps', 'exec', 'db', '--project', PROJECT], config);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('exec needs a command after --');
  });

  test('volumes: ls, create, snapshots, restore, fork; destroy needs --yes and sends confirm=<name>', async () => {
    const config = writeConfig(startServer());
    const ls = await runCli(['apps', 'volumes', 'ls', 'db', '--project', PROJECT], config);
    expect(ls.stdout).toMatch(/bbbbbbbb\s+data\s+app\s+1\.5 GB\s+10 GB\s+yes\s+ready\s+5 days/);
    const retention = await runCli(['apps', 'volumes', 'set', 'db', 'data', '--retention', '30', '--project', PROJECT], config);
    expect(retention.code).toBe(0);
    expect(last('PATCH')?.body).toEqual({ snapshot_retention_days: 30 });
    expect(retention.stdout).toContain('keeps daily snapshots 30 days');
    const created = await runCli(['apps', 'volumes', 'create', 'db', 'uploads', '--size', '20', '--project', PROJECT], config);
    expect(created.code).toBe(0);
    expect(last('POST')?.body).toEqual({ name: 'uploads', size_gb: 20 });
    const snapshots = await runCli(['apps', 'volumes', 'snapshots', 'db', 'data', '--project', PROJECT], config);
    expect(snapshots.stdout).toContain('daily-20261010');
    const restored = await runCli(['apps', 'volumes', 'restore', 'db', 'data', 'daily-20261010', '--project', PROJECT], config);
    expect(restored.code).toBe(0);
    expect(last('POST')?.body).toEqual({ snapshot_id: 'daily-20261010' });
    const forked = await runCli(['apps', 'volumes', 'fork', 'db', 'data', 'copy', '--project', PROJECT], config);
    expect(forked.stdout).toContain('forked into copy');
    const refused = await runCli(['apps', 'volumes', 'destroy', 'db', 'data', '--project', PROJECT], config);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('Pass --yes');
    const destroyed = await runCli(['apps', 'volumes', 'destroy', 'db', 'data', '--yes', '--project', PROJECT], config);
    expect(destroyed.code).toBe(0);
    expect(last('DELETE')?.search).toBe('?confirm=data');
  });

  test('labels replaces the list (deduplicated) and --clear empties it', async () => {
    const config = writeConfig(startServer());
    const set = await runCli(['apps', 'labels', 'db', 'backend,db,backend', '--project', PROJECT], config);
    expect(set.code).toBe(0);
    expect(last('PATCH')?.body).toEqual({ labels: ['backend', 'db'] });
    await runCli(['apps', 'labels', 'db', '--clear', '--project', PROJECT], config);
    expect(last('PATCH')?.body).toEqual({ labels: [] });
  });
});
