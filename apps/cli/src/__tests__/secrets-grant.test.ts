import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_secrets';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Call[] = [];
let alreadyGranted = false;
let adoptedGovernance = false;

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_secrets',
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

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: url.pathname + url.search, body });
      const base = `/v1/projects/${PROJECT}/secrets`;

      if (url.pathname === `${base}/STRIPE_KEY/grant` && req.method === 'POST') {
        return Response.json({
          identifier: 'STRIPE_KEY',
          agent: (body as { agent: string }).agent,
          already_granted: alreadyGranted,
          adopted_governance: adoptedGovernance,
        });
      }
      if (url.pathname === `${base}/GMAPS.primary/grant` && req.method === 'POST') {
        return Response.json({
          identifier: 'GMAPS.primary',
          agent: (body as { agent: string }).agent,
          already_granted: false,
          adopted_governance: false,
        });
      }
      if (url.pathname === `${base}/DENIED_KEY/grant` && req.method === 'POST') {
        return Response.json(
          {
            error: 'This secret is denied delivery. Change its delivery policy before granting it.',
            code: 'secret_not_grantable',
          },
          { status: 409 },
        );
      }
      if (url.pathname === `${base}/MISSING/grant` && req.method === 'POST') {
        return Response.json({ error: 'Not found' }, { status: 404 });
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
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix secrets grant', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-secrets-grant-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
    alreadyGranted = false;
    adoptedGovernance = false;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents grant and says there is no revoke', async () => {
    const r = await runCli(['secrets', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('grant IDENTIFIER --agent <name>');
    expect(r.stdout).toContain('There is no secrets revoke');
    expect(r.stdout).toContain('kortix agents scope');
  });

  test('grant POSTs {agent} to the identifier route', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['secrets', 'grant', 'STRIPE_KEY', '--agent', 'billing', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/secrets/STRIPE_KEY/grant`,
      body: { agent: 'billing' },
    });
    expect(r.stdout).toContain('billing now receives STRIPE_KEY');
  });

  test('grant percent-encodes an identifier with a dot', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['secrets', 'grant', 'GMAPS.primary', '--agent', 'maps', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)!.path).toBe(`/v1/projects/${PROJECT}/secrets/GMAPS.primary/grant`);
  });

  test('grant reports an idempotent no-op distinctly', async () => {
    const config = writeConfig(startServer());
    alreadyGranted = true;
    const r = await runCli(['secrets', 'grant', 'STRIPE_KEY', '--agent', 'billing', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already receives STRIPE_KEY');
  });

  test('grant warns loudly when it writes the first agents: block', async () => {
    const config = writeConfig(startServer());
    adoptedGovernance = true;
    const r = await runCli(['secrets', 'grant', 'STRIPE_KEY', '--agent', 'billing', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('first `agents:` block');
    expect(r.stdout).toContain('receives NO project secrets');
  });

  test('grant --json emits the API body', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['secrets', 'grant', 'STRIPE_KEY', '--agent', 'billing', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      identifier: 'STRIPE_KEY',
      agent: 'billing',
      already_granted: false,
      adopted_governance: false,
    });
  });

  test('grant without --agent exits 2 and never calls the API', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['secrets', 'grant', 'STRIPE_KEY', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass --agent');
    expect(calls).toEqual([]);
  });

  test('grant without an identifier exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['secrets', 'grant', '--agent', 'billing', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass a secret identifier');
    expect(calls).toEqual([]);
  });

  test('grant rejects a malformed identifier locally', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['secrets', 'grant', '_bad name', '--agent', 'billing', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is not a valid secret identifier');
    expect(calls).toEqual([]);
  });

  test('a 409 on a denied secret surfaces the API message', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['secrets', 'grant', 'DENIED_KEY', '--agent', 'billing', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('denied delivery');
  });

  test('a 404 on an unknown secret surfaces the API message', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['secrets', 'grant', 'MISSING', '--agent', 'billing', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Not found');
  });
});
