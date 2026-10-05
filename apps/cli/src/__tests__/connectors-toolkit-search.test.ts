// `kortix connectors apps` must search the COMPOSIO toolkit catalog, because
// those slugs are the ones `add --provider composio --app <slug>` accepts —
// the connector sync rejects anything else with `Invalid toolkit slugs`.
// Before this, `apps` only browsed the legacy Pipedream catalog, whose slugs
// (e.g. `microsoft_outlook`) do not exist in Composio (`outlook`), so the
// documented discovery path handed users slugs that always failed.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT = 'proj_toolkits';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: string[] = [];

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_toolkits',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
          default_project: { project_id: PROJECT, account_id: 'account_1', name: 'Toolkits' },
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
      calls.push(url.pathname + url.search);
      const ex = `/v1/connectors/projects/${PROJECT}`;

      if (url.pathname === `${ex}/connect/toolkits`) {
        return Response.json({
          items: [
            {
              slug: 'outlook',
              name: 'Outlook',
              description: "Microsoft's email and calendaring platform",
              categories: ['email', 'calendar'],
              connection: { isActive: false },
            },
          ],
          cursor: 'cur_2',
          totalPages: 3,
        });
      }
      if (url.pathname === `${ex}/pipedream/apps`) {
        return Response.json({
          apps: [
            {
              slug: 'microsoft_outlook',
              name: 'Microsoft Outlook Email',
              description: 'Legacy catalog entry',
              categories: ['Communication'],
            },
          ],
          hasMore: false,
        });
      }
      if (url.pathname === `/v1/projects/${PROJECT}`) {
        return Response.json({ project_id: PROJECT, account_id: 'account_1', name: 'Toolkits' });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], configFile: string) {
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
  const proc = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd: tmp, env, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('connectors apps → Composio toolkits', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-toolkits-'));
    calls = [];
  });
  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('searches the Composio catalog and prints the slug add expects', async () => {
    const config = writeConfig(startServer());
    const res = await runCli(['connectors', 'apps', 'outlook', '--project', PROJECT], config);
    expect(res.code).toBe(0);
    expect(calls.some((c) => c.startsWith(`/v1/connectors/projects/${PROJECT}/connect/toolkits?`))).toBe(true);
    expect(calls.some((c) => c.includes('/pipedream/apps'))).toBe(false);
    expect(res.stdout).toContain('outlook');
    expect(res.stdout).not.toContain('microsoft_outlook');
    expect(res.stdout).toContain('--provider composio');
  });

  test('forwards the query, category, cursor and limit', async () => {
    const config = writeConfig(startServer());
    const res = await runCli(
      ['connectors', 'apps', 'mail', '--category', 'email', '--cursor', 'cur_1', '--limit', '5', '--project', PROJECT],
      config,
    );
    expect(res.code).toBe(0);
    const call = calls.find((c) => c.includes('/connect/toolkits')) ?? '';
    expect(call).toContain('q=mail');
    expect(call).toContain('category=email');
    expect(call).toContain('cursor=cur_1');
    expect(call).toContain('limit=5');
  });

  test('toolkits is an alias for apps', async () => {
    const config = writeConfig(startServer());
    const res = await runCli(['connectors', 'toolkits', 'outlook', '--project', PROJECT], config);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('outlook');
    expect(calls.some((c) => c.includes('/connect/toolkits'))).toBe(true);
  });

  test('--json emits the raw Composio payload', async () => {
    const config = writeConfig(startServer());
    const res = await runCli(['connectors', 'apps', 'outlook', '--json', '--project', PROJECT], config);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(payload.items[0].slug).toBe('outlook');
  });

  test('--pipedream still reaches the legacy catalog', async () => {
    const config = writeConfig(startServer());
    const res = await runCli(['connectors', 'apps', 'outlook', '--pipedream', '--project', PROJECT], config);
    expect(res.code).toBe(0);
    expect(calls.some((c) => c.includes('/pipedream/apps'))).toBe(true);
    expect(res.stdout).toContain('microsoft_outlook');
    expect(res.stdout).toContain('legacy Pipedream app');
  });
});
