import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Black-box: the real CLI process against a fake API that answers the
// connector policy-set routes (connectors/routes/settings.ts) and the agent
// scope route (projects/routes/agent-scope.ts) with their real shapes.

// Each test spawns 1-2 CLI processes; a cold start on a loaded box passes 5 s.
setDefaultTimeout(30_000);

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = 'proj_sets';
const EX = `/v1/connectors/projects/${PROJECT}/connectors`;

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Call[] = [];
/** Set rules by name; `base` = the connector's base rules. */
let rules: Record<string, Array<Record<string, unknown>>> = {};

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: url.pathname + url.search, body });
      const set = url.searchParams.get('policy_set') ?? 'base';

      if (url.pathname === `${EX}/gmail/policies`) {
        if (!rules[set]) {
          return Response.json({ error: `policy set "${set}" not found`, code: 'policy_set_not_found' }, { status: 404 });
        }
        if (req.method === 'GET') return Response.json({ policies: rules[set], ...(set === 'base' ? {} : { policy_set: set }) });
        rules[set] = (body as { policies: Array<Record<string, unknown>> }).policies;
        return Response.json({ ok: true, sync: { synced: 1, errors: [] } });
      }
      if (url.pathname === `${EX}/gmail/policy-sets` && req.method === 'GET') {
        return Response.json({
          sets: Object.keys(rules)
            .filter((name) => name !== 'base')
            .map((name) => ({ name, description: null, policies: rules[name], agents: name === 'read_only' ? ['support'] : [] })),
        });
      }
      if (url.pathname === `${EX}/gmail/policy-sets/read_only` && req.method === 'DELETE') {
        return Response.json(
          { error: 'policy set "read_only" is used by agent support', code: 'policy_set_in_use', agents: ['support'] },
          { status: 409 },
        );
      }
      if (url.pathname === `${EX}/gmail/policy-sets/outreach` && req.method === 'PUT') {
        const created = !rules.outreach;
        rules.outreach ??= [];
        return Response.json({ ok: true, sync: { synced: 1, errors: [] }, created });
      }
      if (url.pathname === `${EX}/gmail/policy-sets/outreach/name` && req.method === 'PUT') {
        return Response.json({ ok: true, sync: { synced: 1, errors: [] } });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/agents/support/scope` && req.method === 'PUT') {
        const sets = (body as { policy_sets?: Record<string, string | null> }).policy_sets ?? {};
        if (sets.gmail === 'nope') {
          return Response.json(
            { error: 'policy_sets.gmail: no policy set "nope" on gmail', code: 'policy_set_not_found' },
            { status: 400 },
          );
        }
        return Response.json({
          ok: true,
          agent: 'support',
          env: 'all',
          connectors: ['gmail'],
          apps: [],
          connectors_required: [],
          // Like the route: an assignment on an ungranted connector is not stored.
          policy_sets: Object.fromEntries(Object.entries(sets).filter(([k, v]) => v !== null && k === 'gmail')),
        });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/agents/support/config` && req.method === 'GET') {
        return Response.json({ agent: 'support', block: { connectors: ['gmail'], policy_sets: { gmail: 'read_only' } } });
      }
      return Response.json({ error: `unhandled ${req.method} ${url.pathname}` }, { status: 500 });
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_sets',
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
  const proc = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd: tmp, env, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

const writes = () => calls.filter((c) => c.method !== 'GET');

describe('kortix connectors policy sets + agents scope --policy-set', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-policy-sets-'));
    calls = [];
    rules = {
      base: [{ match: 'send_*', action: 'require_approval', conditions: [{ arg: 'to', match: '*@corp.test' }] }],
      read_only: [{ match: 'list_*', action: 'always_run' }],
    };
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('policy <slug> --policy-set <name> set writes that set and keeps other rules', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['connectors', 'policy', 'gmail', '--policy-set', 'read_only', 'set', 'send_*', 'block', '--condition', 'to!=*@corp.test', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('gmail [read_only]: send_* → block when to!=*@corp.test');
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: `${EX}/gmail/policies?policy_set=read_only`,
        body: {
          policies: [
            { match: 'list_*', action: 'always_run' },
            { match: 'send_*', action: 'block', conditions: [{ arg: 'to', match: '*@corp.test', negate: true }] },
          ],
        },
      },
    ]);
    // The base rules were never touched.
    expect(rules.base).toHaveLength(1);
  });

  test('a base-rule edit sends back every other rule with its conditions', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy', 'gmail', 'set', 'delete_*', 'block', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(writes()[0]).toEqual({
      method: 'PUT',
      path: `${EX}/gmail/policies`,
      body: {
        policies: [
          { match: 'send_*', action: 'require_approval', conditions: [{ arg: 'to', match: '*@corp.test' }] },
          { match: 'delete_*', action: 'block' },
        ],
      },
    });
  });

  test('--policy-set base and --json ls read the base rules', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy', 'gmail', '--policy-set', 'base', 'ls', '--json', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls[0]?.path).toBe(`${EX}/gmail/policies`);
    expect(JSON.parse(r.stdout).policies[0].conditions).toEqual([{ arg: 'to', match: '*@corp.test' }]);
  });

  test('an unknown set exits 1 and names the commands that fix it', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy', 'gmail', '--policy-set', 'missing', 'ls', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('policy set "missing" not found');
    expect(r.stderr).toContain('kortix connectors policy-sets gmail ls');
  });

  test('policy-sets ls --json emits the route payload; ls prints rules and agents', async () => {
    const config = writeConfig(startServer());
    const asJson = await runCli(['connectors', 'policy-sets', 'gmail', 'ls', '--json', '--project', PROJECT], config);
    expect(asJson.code).toBe(0);
    expect(JSON.parse(asJson.stdout)).toEqual({
      sets: [{ name: 'read_only', description: null, policies: [{ match: 'list_*', action: 'always_run' }], agents: ['support'] }],
    });
    const human = await runCli(['connectors', 'policy', 'gmail', 'sets', '--project', PROJECT], config);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('read_only');
    expect(human.stdout).toContain('1 rule · support');
    expect(human.stdout).toContain('list_* → always_run');
  });

  test('policy-sets create sends only the description; rename sends { name }', async () => {
    const config = writeConfig(startServer());
    const created = await runCli(
      ['connectors', 'policy-sets', 'gmail', 'create', 'outreach', '--description', 'Sales may send', '--project', PROJECT],
      config,
    );
    expect(created.code).toBe(0);
    expect(created.stdout).toContain('policy set outreach created');
    const renamed = await runCli(['connectors', 'policy-sets', 'gmail', 'rename', 'outreach', 'sales', '--json', '--project', PROJECT], config);
    expect(renamed.code).toBe(0);
    expect(JSON.parse(renamed.stdout)).toMatchObject({ ok: true, slug: 'gmail', name: 'sales', from: 'outreach' });
    expect(writes()).toEqual([
      { method: 'PUT', path: `${EX}/gmail/policy-sets/outreach`, body: { description: 'Sales may send' } },
      { method: 'PUT', path: `${EX}/gmail/policy-sets/outreach/name`, body: { name: 'sales' } },
    ]);
  });

  test('policy-sets rm of a set in use exits 1 and names the agents and the fix', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy-sets', 'gmail', 'rm', 'read_only', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Used by: support');
    expect(r.stderr).toContain('kortix agents scope support --policy-set gmail=base');
  });

  test('policy-sets --help is focused; policy --help points to it', async () => {
    const sets = await runCli(['connectors', 'policy-sets', '--help']);
    expect(sets.code).toBe(0);
    expect(sets.stdout).toContain('Usage: kortix connectors policy-sets <slug>');
    expect(sets.stdout).toContain('rename <name> <new-name>');
    const policy = await runCli(['connectors', 'policy', '--help']);
    expect(policy.stdout).toContain('--policy-set <name>');
    expect(policy.stdout.split('\n').length).toBeLessThan(50);
  });

  test('agents scope --policy-set merges per connector; =base sends null', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['agents', 'scope', 'support', '--policy-set', 'gmail=read_only', '--policy-set', 'slack=base', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('gmail=read_only');
    expect(writes()).toEqual([
      { method: 'PUT', path: `/v1/projects/${PROJECT}/agents/support/scope`, body: { policy_sets: { gmail: 'read_only', slack: null } } },
    ]);
  });

  test('agents scope --policy-set without <slug>= exits 2 before any call', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['agents', 'scope', 'support', '--policy-set', 'read_only', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--policy-set must look like <connector>=<set>');
    expect(writes()).toEqual([]);
  });

  test('agents scope maps an unknown set to the policy-sets hint', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['agents', 'scope', 'support', '--policy-set', 'gmail=nope', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no policy set "nope" on gmail');
    expect(r.stderr).toContain('kortix connectors policy-sets gmail ls');
  });

  test('agents scope exits 1 when the server did not store an assignment', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['agents', 'scope', 'support', '--policy-set', 'other=read_only', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--policy-set other=read_only was not applied');
  });

  test('agents scope --show prints the assigned sets (and --json carries them)', async () => {
    const config = writeConfig(startServer());
    const human = await runCli(['agents', 'scope', 'support', '--show', '--project', PROJECT], config);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/policy sets\s+gmail=read_only/);
    const asJson = await runCli(['agents', 'scope', 'support', '--show', '--json', '--project', PROJECT], config);
    expect(JSON.parse(asJson.stdout).policy_sets).toEqual({ gmail: 'read_only' });
  });
});
