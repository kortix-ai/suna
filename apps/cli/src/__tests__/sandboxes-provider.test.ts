import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_provider';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Array<{ method: string; path: string; body: unknown }> = [];

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_provider',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

function transitionView(status: string, target: string, errorClass: string | null = null) {
  return {
    transition_id: 'tr_1',
    project_id: PROJECT,
    status,
    source_provider: 'daytona',
    target_provider: target,
    generation: 1,
    label: `daytona → ${target}`,
    error_class: errorClass,
    requested_at: '2026-01-01T00:00:00.000Z',
    ready_at: null,
    activated_at: status === 'activated' ? '2026-01-01T00:01:00.000Z' : null,
    immediate: false,
  };
}

interface ServerOpts {
  /** Provider name that answers with a `kind:'preparation'` PATCH result. */
  preparesFor?: string;
  /** The status each successive GET /transition reports. */
  pollStatuses?: string[];
  pinned?: string | null;
}

function startServer(opts: ServerOpts = {}): string {
  let pinned = opts.pinned === undefined ? 'daytona' : opts.pinned;
  const statuses = [...(opts.pollStatuses ?? ['activated'])];
  let target = opts.preparesFor ?? 'platinum';
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json();
      calls.push({ method: req.method, path: url.pathname, body });
      const p = url.pathname;
      if (p === `/v1/projects/${PROJECT}` && req.method === 'GET') {
        return Response.json({
          project_id: PROJECT,
          name: 'Provider',
          default_sandbox_provider: pinned,
          available_sandbox_providers: ['daytona', 'platinum', 'e2b'],
        });
      }
      if (p === `/v1/projects/${PROJECT}/sandbox-provider` && req.method === 'PATCH') {
        const wanted = (body as { provider: string | null }).provider;
        if (wanted !== null && !['daytona', 'platinum', 'e2b'].includes(wanted)) {
          return Response.json(
            { error: `Unknown or disabled sandbox provider: ${wanted}` },
            { status: 400 },
          );
        }
        if (wanted !== null && wanted === opts.preparesFor) {
          target = wanted;
          return Response.json({ kind: 'preparation', ...transitionView('building', wanted) });
        }
        pinned = wanted;
        return Response.json({
          kind: 'project',
          project_id: PROJECT,
          name: 'Provider',
          default_sandbox_provider: pinned,
          available_sandbox_providers: ['daytona', 'platinum', 'e2b'],
        });
      }
      if (p === `/v1/projects/${PROJECT}/sandbox-provider/transition` && req.method === 'GET') {
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
        const latest = transitionView(status, target, status === 'failed' ? 'build_failed' : null);
        return Response.json({
          active_provider: status === 'activated' ? target : 'daytona',
          latest,
          history: [latest],
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], configFile?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_CLI_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_TOKEN',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 30_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix sandboxes provider', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-sbx-provider-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents provider, its --clear/--timeout flags, and the permission', async () => {
    const r = await runCli(['sandboxes', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('provider <name>');
    expect(r.stdout).toContain('provider --clear');
    expect(r.stdout).toContain('provider status');
    expect(r.stdout).toContain('project.customize.write');
  });

  test('bare `provider` prints the pin and what this host offers; --json is machine-readable', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['sandboxes', 'provider', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pinned     daytona');
    expect(r.stdout).toContain('available  daytona, platinum, e2b');
    expect(calls).toEqual([{ method: 'GET', path: `/v1/projects/${PROJECT}`, body: null }]);

    const j = await runCli(['sandboxes', 'provider', '--project', PROJECT, '--json'], config);
    expect(JSON.parse(j.stdout)).toEqual({
      default_sandbox_provider: 'daytona',
      available_sandbox_providers: ['daytona', 'platinum', 'e2b'],
    });
  });

  test('an immediate switch PATCHes {provider} and reports the new pin without polling', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['sandboxes', 'provider', 'e2b', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      {
        method: 'PATCH',
        path: `/v1/projects/${PROJECT}/sandbox-provider`,
        body: { provider: 'e2b' },
      },
    ]);
    expect(r.stdout).toContain('Pinned to e2b');
  });

  test('--clear PATCHes {provider:null}', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['sandboxes', 'provider', '--clear', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'PATCH',
      path: `/v1/projects/${PROJECT}/sandbox-provider`,
      body: { provider: null },
    });
    expect(r.stdout).toContain('Pin cleared');
  });

  test('a preparation is followed to activation', async () => {
    const config = writeConfig(
      startServer({ preparesFor: 'platinum', pollStatuses: ['building', 'activated'] }),
    );
    const r = await runCli(
      ['sandboxes', 'provider', 'platinum', '--timeout', '30', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Preparing platinum');
    expect(r.stdout).toContain('Now on platinum');
    const polls = calls.filter((c) => c.path.endsWith('/sandbox-provider/transition'));
    expect(polls.length).toBeGreaterThanOrEqual(2);
  }, 40_000);

  test('a failed preparation exits 1 and names the error class', async () => {
    const config = writeConfig(startServer({ preparesFor: 'platinum', pollStatuses: ['failed'] }));
    const r = await runCli(
      ['sandboxes', 'provider', 'platinum', '--timeout', '30', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Transition ended failed (build_failed)');
  }, 40_000);

  test('`provider status` reads the transition log', async () => {
    const config = writeConfig(startServer({ pollStatuses: ['activated'] }));
    const r = await runCli(['sandboxes', 'provider', 'status', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      {
        method: 'GET',
        path: `/v1/projects/${PROJECT}/sandbox-provider/transition`,
        body: null,
      },
    ]);
    expect(r.stdout).toContain('active   platinum');
    expect(r.stdout).toMatch(/activated\s+daytona\s+platinum/);

    const j = await runCli(
      ['sandboxes', 'provider', 'status', '--project', PROJECT, '--json'],
      config,
    );
    expect(JSON.parse(j.stdout).latest.status).toBe('activated');
  });

  test('an unknown provider surfaces the API 400', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['sandboxes', 'provider', 'nope', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown or disabled sandbox provider: nope');
  });
});
