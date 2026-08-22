import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const ACCOUNT = 'account_1';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_billing',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: ACCOUNT,
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

const ACCOUNT_STATE = {
  credits: { total: 42.5, daily: 0, monthly: 0, extra: 0, can_run: true },
  billing_state: 'active',
  plan: { key: 'per_seat', family: 'team', label: 'Team', sublabel: '$20/seat/mo' },
  subscription: {
    tier_key: 'per_seat',
    tier_display_name: 'Team',
    status: 'active',
    billing_period: 'monthly',
    cancel_at_period_end: false,
    current_period_end: 1800000000,
    has_scheduled_change: false,
  },
  tier: { name: 'per_seat', display_name: 'Team' },
  billing_model: 'per_seat',
  seats: { count: 3, price_per_seat_usd: 20 },
  member_count: 3,
  auto_topup: { enabled: true, threshold: 10, amount: 25 },
  can_manage_billing: true,
};

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path, search: url.search, body });

      if (path === '/v1/billing/account-state' && req.method === 'GET') {
        return Response.json(ACCOUNT_STATE);
      }
      if (path === '/v1/billing/transactions' && req.method === 'GET') {
        return Response.json({
          transactions: [
            {
              id: 'txn_1',
              created_at: '2026-08-01T10:00:00.000Z',
              amount: -1.25,
              balance_after: 41.25,
              type: 'usage',
              description: 'LLM: claude',
              is_expiring: false,
              expires_at: null,
              metadata: null,
            },
          ],
          pagination: { total: 1, limit: 5, offset: 0, has_more: false },
        });
      }
      if (path === '/v1/billing/credit-breakdown' && req.method === 'GET') {
        return Response.json({ total: 42.5, expiring: 2.5, non_expiring: 40, daily: 0 });
      }
      if (path === '/v1/usage/cost-summary' && req.method === 'GET') {
        return Response.json({
          totals: {
            llm_cost: 3.5,
            llm_kortix_cost: 3.5,
            llm_provider_cost: 0,
            compute_cost: 1.5,
            total_cost: 5,
            request_count: 12,
            compute_seconds: 600,
            session_count: 2,
            project_count: 1,
          },
          previous: { total_cost: 4 },
          series: [],
          models: [{ provider: 'anthropic', model: 'opus', cost: 3.5, request_count: 12 }],
        });
      }
      if (path === '/v1/usage/cost-by-project' && req.method === 'GET') {
        if (url.searchParams.get('format') === 'csv') {
          return new Response('project_id,total_cost_usd\nproj_1,5\n', {
            headers: { 'content-type': 'text/csv; charset=utf-8', 'x-kortix-row-cap': '10000' },
          });
        }
        return Response.json({
          projects: [
            {
              project_id: 'proj_1',
              project_name: 'Atlas',
              session_count: 2,
              llm_cost: 3.5,
              llm_kortix_cost: 3.5,
              llm_provider_cost: 0,
              compute_cost: 1.5,
              total_cost: 5,
              last_activity_at: null,
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
          next_offset: null,
        });
      }
      // Stands in for a self-hosted box that never enabled Stripe: the route
      // exists but 404s with `billing_disabled`.
      if (path === '/v1/billing/usage-history' && req.method === 'GET') {
        return Response.json({ error: 'Billing is not enabled', billing_disabled: true }, { status: 404 });
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
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

function call(method: string, path: string) {
  return calls.find((c) => c.method === method && c.path === path);
}

describe('kortix billing', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-billing-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents every subcommand; no args exits 2', async () => {
    const h = await runCli(['billing', '--help']);
    expect(h.code).toBe(0);
    for (const fragment of [
      'status',
      'transactions',
      '--breakdown',
      'costs',
      '--by project|session',
      '--csv <file>',
      'Read-only',
    ]) {
      expect(h.stdout).toContain(fragment);
    }
    // The write verbs are gone from the surface entirely.
    for (const gone of ['auto-topup', 'checkout', 'portal', 'topup', 'downgrade', 'cancel-scheduled']) {
      expect(h.stdout).not.toContain(gone);
    }
    const none = await runCli(['billing']);
    expect(none.code).toBe(2);
  });

  test('status GETs /billing/account-state?account_id and renders the plan panel', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['billing', 'status'], config);
    expect(r.code).toBe(0);
    const c = call('GET', '/v1/billing/account-state');
    expect(c?.search).toBe(`?account_id=${ACCOUNT}`);
    expect(r.stdout).toContain('Team');
    expect(r.stdout).toContain('$42.50');
    expect(r.stdout).toContain('3 × $20.00/mo');
    expect(r.stdout).toContain('on — buy $25.00 under $10.00');
  });

  test('status --json emits the raw account-state payload', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['billing', 'status', '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).plan.key).toBe('per_seat');
  });

  test('transactions sends limit/offset/type_filter; --breakdown hits credit-breakdown', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['billing', 'transactions', '--limit', '5', '--offset', '0', '--type', 'usage'],
      config,
    );
    expect(r.code).toBe(0);
    const c = call('GET', '/v1/billing/transactions');
    expect(c?.search).toContain('limit=5');
    expect(c?.search).toContain('offset=0');
    expect(c?.search).toContain('type_filter=usage');
    expect(r.stdout).toContain('usage');
    expect(r.stdout).toContain('LLM: claude');

    const b = await runCli(['billing', 'transactions', '--breakdown', '--json'], config);
    expect(b.code).toBe(0);
    expect(JSON.parse(b.stdout).non_expiring).toBe(40);
  });

  test('costs defaults to /usage/cost-summary and --by project rolls up', async () => {
    const config = writeConfig(startServer());
    const s = await runCli(
      ['billing', 'costs', '--since', '2026-08-01T00:00:00.000Z', '--until', '2026-08-08T00:00:00.000Z'],
      config,
    );
    expect(s.code).toBe(0);
    const summary = call('GET', '/v1/usage/cost-summary');
    expect(summary?.search).toContain('from=2026-08-01T00%3A00%3A00.000Z');
    expect(summary?.search).toContain('to=2026-08-08T00%3A00%3A00.000Z');
    expect(s.stdout).toContain('$5.00');
    expect(s.stdout).toContain('anthropic/opus');

    const p = await runCli(['billing', 'costs', '--by', 'project', '--sort', 'name_asc'], config);
    expect(p.code).toBe(0);
    expect(call('GET', '/v1/usage/cost-by-project')?.search).toContain('sort=name_asc');
    expect(p.stdout).toContain('Atlas');
  });

  test('costs --csv writes the CSV export and reports the row cap', async () => {
    const config = writeConfig(startServer());
    const out = join(tmp, 'projects.csv');
    const r = await runCli(['billing', 'costs', '--by', 'project', '--csv', out], config);
    expect(r.code).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('project_id,total_cost_usd');
    expect(r.stdout).toContain('capped at 10000 rows');
    const csvCall = calls.find((c) => c.path === '/v1/usage/cost-by-project' && c.search.includes('format=csv'));
    expect(csvCall).toBeTruthy();
  });

  test('costs --csv without --by exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['billing', 'costs', '--csv', join(tmp, 'x.csv')], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--csv needs --by');
  });

  test('a 404 from a billing-disabled host surfaces as exit 1', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['billing', 'transactions', '--usage'], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Billing is not enabled');
  });

  test('a dropped write verb is an unknown subcommand, not a silent no-op', async () => {
    const config = writeConfig(startServer());
    for (const verb of ['topup', 'checkout', 'portal', 'auto-topup', 'cancel', 'tiers']) {
      const r = await runCli(['billing', verb], config);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`unknown billing subcommand "${verb}"`);
    }
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
