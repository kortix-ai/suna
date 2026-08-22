import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveExpiry } from '../commands/tokens.ts';
import {
  runCommand,
  startFakeApi,
  writeConfig,
  writeRunner,
  type FakeApi,
} from './support/account-cli-harness.ts';

const ACCOUNT = 'account_1';
const SA = '55555555-5555-4555-8555-555555555555';
const IAM = `/v1/accounts/${ACCOUNT}/iam`;

let tmp: string;
let runner: string;
let api: FakeApi | null = null;

const routes: Parameters<typeof startFakeApi>[0] = (req, url, body) => {
  const p = url.pathname;
  if (p === '/v1/accounts/tokens' && req.method === 'GET') {
    const mine = url.searchParams.get('mine') === 'true';
    return Response.json(
      mine
        ? [
            {
              token_id: 'tok_a',
              name: 'laptop',
              project_id: null,
              public_key: 'kx_pub_a',
              status: 'active',
              expires_at: null,
              last_used_at: null,
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ]
        : [
            {
              token_id: 'tok_a',
              name: 'laptop',
              project_id: null,
              public_key: 'kx_pub_a',
              status: 'active',
              expires_at: null,
              last_used_at: null,
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              token_id: 'tok_b',
              name: 'ci',
              project_id: 'p1',
              public_key: 'kx_pub_b',
              status: 'revoked',
              expires_at: '2026-12-01T00:00:00.000Z',
              last_used_at: null,
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ],
    );
  }
  if (p === '/v1/accounts/tokens' && req.method === 'POST') {
    const b = body as { name: string };
    if (!b.name) return Response.json({ error: 'name is required' }, { status: 400 });
    return Response.json(
      {
        token_id: 'tok_new',
        name: b.name,
        project_id: (body as { project_id?: string }).project_id ?? null,
        public_key: 'kx_pub_new',
        secret_key: 'kx_sec_PLAINTEXT_ONCE',
        status: 'active',
        expires_at: (body as { expires_at?: string }).expires_at ?? null,
        created_at: '2026-08-01T00:00:00.000Z',
      },
      { status: 201 },
    );
  }
  if (p === '/v1/accounts/tokens/tok_a' && req.method === 'DELETE') {
    return Response.json({ ok: true });
  }
  if (p === '/v1/accounts/tokens/tok_missing' && req.method === 'DELETE') {
    return Response.json({ error: 'token not found or already revoked' }, { status: 404 });
  }
  if (p === `${IAM}/service-accounts` && req.method === 'GET') {
    return Response.json({
      service_accounts: [
        {
          service_account_id: SA,
          name: 'nightly',
          description: 'Cron',
          public_prefix: 'sa_abc',
          status: 'active',
          last_used_at: null,
          expires_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          disabled_at: null,
        },
      ],
    });
  }
  if (p === `${IAM}/service-accounts` && req.method === 'POST') {
    const b = body as { name: string; description?: string; expires_at?: string };
    return Response.json(
      {
        service_account_id: SA,
        name: b.name,
        description: b.description ?? null,
        public_prefix: 'sa_new',
        status: 'active',
        secret: 'sa_sec_PLAINTEXT_ONCE',
        expires_at: b.expires_at ?? null,
        created_at: '2026-08-01T00:00:00.000Z',
      },
      { status: 201 },
    );
  }
  if (p === `${IAM}/service-accounts/${SA}/disable` && req.method === 'POST') {
    return Response.json({ disabled: true });
  }
  if (p === `${IAM}/service-accounts/${SA}` && req.method === 'DELETE') {
    return Response.json({ deleted: true });
  }
  return undefined;
};

function boot(): string {
  api = startFakeApi(routes);
  return writeConfig(tmp, api.url, ACCOUNT);
}

describe('resolveExpiry', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');

  test('resolves a forward span against the caller clock', () => {
    expect(resolveExpiry('30d', now)).toBe('2026-08-31T00:00:00.000Z');
    expect(resolveExpiry('12h', now)).toBe('2026-08-01T12:00:00.000Z');
    expect(resolveExpiry('2w', now)).toBe('2026-08-15T00:00:00.000Z');
    expect(resolveExpiry('1y', now)).toBe('2027-08-01T00:00:00.000Z');
  });

  test('passes an ISO instant through, and rejects nonsense', () => {
    expect(resolveExpiry('2027-01-01T00:00:00.000Z', now)).toBe('2027-01-01T00:00:00.000Z');
    expect(resolveExpiry('soon', now)).toBeNull();
    expect(resolveExpiry('0d', now)).toBeNull();
    expect(resolveExpiry('', now)).toBeNull();
  });
});

describe('kortix tokens', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-tokens-'));
    runner = writeRunner(tmp, 'tokens.ts', 'runTokens');
  });

  afterEach(() => {
    api?.stop();
    api = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('--help documents both credential kinds; no args exits 2', async () => {
    const h = await runCommand(runner, ['--help'], { cwd: tmp });
    expect(h.code).toBe(0);
    for (const fragment of [
      'Usage: kortix tokens',
      'ls [--mine] [--json]',
      'new <name>',
      'service-accounts ls',
      'token.create',
      'token.revoke',
      'kortix access grant --service-account',
    ]) {
      expect(h.stdout).toContain(fragment);
    }
    const bare = await runCommand(runner, [], { cwd: tmp });
    expect(bare.code).toBe(2);
  });

  test('ls sends account_id; --mine narrows with mine=true', async () => {
    const config = boot();
    const all = await runCommand(runner, ['ls'], { cwd: tmp, configFile: config });
    expect(all.code).toBe(0);
    expect(all.stdout).toMatch(/laptop\s+kx_pub_a\s+active\s+never/);
    expect(all.stdout).toMatch(/ci\s+kx_pub_b\s+revoked\s+2026-12-01/);
    expect(api!.requests[0]!.query).toContain(`account_id=${ACCOUNT}`);
    expect(api!.requests[0]!.query).not.toContain('mine=');

    const mine = await runCommand(runner, ['ls', '--mine', '--json'], {
      cwd: tmp,
      configFile: config,
    });
    expect(mine.code).toBe(0);
    expect(api!.requests.at(-1)!.query).toContain('mine=true');
    expect(JSON.parse(mine.stdout).map((t: { name: string }) => t.name)).toEqual(['laptop']);
  });

  test('new POSTs account_id IN THE BODY and prints the secret once', async () => {
    const config = boot();
    const r = await runCommand(
      runner,
      ['new', 'ci-deploy', '--expires', '90d', '--project', 'p1'],
      { cwd: tmp, configFile: config },
    );
    expect(r.code).toBe(0);
    const sent = api!.requests[0]!;
    expect(sent).toMatchObject({ method: 'POST', path: '/v1/accounts/tokens' });
    const body = sent.body as { name: string; account_id: string; expires_at: string; project_id: string };
    // account_id must ride in the body: this route resolves the account from
    // the body, not the query string.
    expect(body.account_id).toBe(ACCOUNT);
    expect(body.name).toBe('ci-deploy');
    expect(body.project_id).toBe('p1');
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(r.stdout).toContain('kx_sec_PLAINTEXT_ONCE');
    expect(r.stdout).toContain('only time the secret is shown');
  });

  test('an unparseable --expires exits 2 before any HTTP call', async () => {
    const config = boot();
    const r = await runCommand(runner, ['new', 'x', '--expires', 'whenever'], {
      cwd: tmp,
      configFile: config,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is not an ISO-8601 instant or a span like 30d');
    expect(api!.requests).toHaveLength(0);
  });

  test('rm -y DELETEs with account_id; a 404 surfaces and exits 1', async () => {
    const config = boot();
    const ok = await runCommand(runner, ['rm', 'tok_a', '-y'], { cwd: tmp, configFile: config });
    expect(ok.code).toBe(0);
    expect(api!.requests[0]).toMatchObject({
      method: 'DELETE',
      path: '/v1/accounts/tokens/tok_a',
    });
    expect(api!.requests[0]!.query).toContain(`account_id=${ACCOUNT}`);

    const miss = await runCommand(runner, ['rm', 'tok_missing', '-y'], {
      cwd: tmp,
      configFile: config,
    });
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain('token not found or already revoked');
  });

  test('service-accounts ls/new/disable/rm hit the IAM routes', async () => {
    const config = boot();
    const ls = await runCommand(runner, ['service-accounts', 'ls'], {
      cwd: tmp,
      configFile: config,
    });
    expect(ls.code).toBe(0);
    expect(ls.stdout).toMatch(/nightly\s+sa_abc\s+active\s+never/);

    const created = await runCommand(
      runner,
      ['service-accounts', 'new', 'reporter', '--description', 'Cron'],
      { cwd: tmp, configFile: config },
    );
    expect(created.code).toBe(0);
    expect(api!.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: `${IAM}/service-accounts`,
      body: { name: 'reporter', description: 'Cron' },
    });
    expect(created.stdout).toContain('sa_sec_PLAINTEXT_ONCE');
    expect(created.stdout).toContain('It holds no permissions yet');

    const disabled = await runCommand(runner, ['service-accounts', 'disable', SA], {
      cwd: tmp,
      configFile: config,
    });
    expect(disabled.code).toBe(0);
    expect(api!.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: `${IAM}/service-accounts/${SA}/disable`,
    });

    const removed = await runCommand(runner, ['service-accounts', 'rm', SA, '-y'], {
      cwd: tmp,
      configFile: config,
    });
    expect(removed.code).toBe(0);
    expect(api!.requests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `${IAM}/service-accounts/${SA}`,
    });
  });

  test('missing required arguments exit 2 without any HTTP call', async () => {
    const config = boot();
    for (const args of [
      ['new'],
      ['rm'],
      ['service-accounts', 'new'],
      ['service-accounts', 'disable'],
      ['service-accounts', 'bogus'],
    ]) {
      const r = await runCommand(runner, args, { cwd: tmp, configFile: config });
      expect(r.code).toBe(2);
    }
    expect(api!.requests).toHaveLength(0);
  });
});
