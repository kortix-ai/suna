import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const REVIEW_MODULE = join(CLI_ROOT, 'src', 'commands', 'review.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_review';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let tmp: string;
let entry: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Call[] = [];
let featureDisabled = false;

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_review',
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

/**
 * `kortix review` is dispatched from index.ts, which the orchestrator owns and
 * this slice must not edit. Spawn the command through a one-line entry that
 * calls the exported `runReview` instead: still a real process, real HTTP, real
 * exit code — only the argv[0] switch is bypassed.
 */
function writeEntry(): string {
  const path = join(tmp, 'review-entry.ts');
  writeFileSync(
    path,
    `import { runReview } from ${JSON.stringify(REVIEW_MODULE)};\n` +
      `process.exit(await runReview(process.argv.slice(2)));\n`,
    'utf8',
  );
  return path;
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    review_item_id: 'rv_1',
    account_id: 'account_1',
    project_id: PROJECT,
    origin_session_id: 'sess_1',
    kind: 'output',
    status: 'needs_you',
    risk: 'medium',
    source: 'agent',
    title: 'Draft the Q3 pricing note',
    summary: 'Three options, one recommendation.',
    detail: { options: 3 },
    agent: 'writer',
    created_by: 'user_1',
    acted_by: null,
    acted_at: null,
    feedback: null,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: url.pathname + url.search, body });
      const base = `/v1/projects/${PROJECT}`;

      if (featureDisabled) {
        return Response.json(
          {
            error: 'Review Center is not enabled for this project. Enable it in Settings → Feature flags.',
            code: 'feature_disabled',
            feature: 'review_center',
          },
          { status: 403 },
        );
      }

      if (url.pathname === `${base}/review/items` && req.method === 'GET') {
        return Response.json({
          review_items: [
            item(),
            item({ review_item_id: 'cr:cr_9', kind: 'change', title: 'Rename the flag', risk: 'low' }),
            item({ review_item_id: 'call:ex_7', kind: 'approval', title: 'send_email', risk: 'high' }),
          ],
        });
      }
      if (url.pathname === `${base}/review/items` && req.method === 'POST') {
        return Response.json(
          item({ review_item_id: 'rv_new', kind: (body as any).kind, title: (body as any).title }),
          { status: 201 },
        );
      }
      if (url.pathname === `${base}/review/items/rv_1` && req.method === 'GET') {
        return Response.json({ review_item: item() });
      }
      if (url.pathname === `${base}/review/items/rv_missing` && req.method === 'GET') {
        return Response.json({ error: 'Review item not found' }, { status: 404 });
      }
      if (url.pathname === `${base}/review/items/rv_1/act` && req.method === 'POST') {
        return Response.json(item({ status: 'approved', acted_by: 'user_1' }));
      }
      if (url.pathname === `${base}/review/bulk` && req.method === 'POST') {
        const ids = (body as { ids: string[] }).ids;
        return Response.json({ updated: ids.length, review_items: ids.map((id) => item({ review_item_id: id, status: 'dismissed' })) });
      }
      if (url.pathname === `${base}/approvals/ex_7` && req.method === 'POST') {
        return Response.json({ ok: true });
      }
      if (url.pathname === `${base}/change-requests/cr_9/merge` && req.method === 'POST') {
        return Response.json({
          change_request: { cr_id: 'cr_9', number: 9 },
          merge: { merge_commit_sha: 'abcdef1234', fast_forward: true, base_sha_before: 'a', base_sha_after: 'b' },
        });
      }
      if (url.pathname === `${base}/change-requests/cr_9/close` && req.method === 'POST') {
        return Response.json({ cr_id: 'cr_9', status: 'closed' });
      }
      if (url.pathname === `${base}/change-requests/cr_9/request-changes` && req.method === 'POST') {
        return Response.json({ change_request: { cr_id: 'cr_9' }, delivering: true });
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
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'KORTIX_SESSION_ID', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, entry, ...args],
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

describe('kortix review', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-review-'));
    entry = writeEntry();
    process.env = { ...ORIGINAL_ENV };
    calls = [];
    featureDisabled = false;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents every subcommand and the id routing', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: kortix review');
    for (const fragment of ['ls [--segment', 'show <item-id>', 'act <item-id>', 'bulk <verdict>', 'submit --kind', 'cr:<id>', 'call:<id>', 'review_center']) {
      expect(r.stdout).toContain(fragment);
    }
  });

  test('no args prints help and exits 2', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('Usage: kortix review');
  });

  test('ls sends segment + kind as query params and prints a row per item', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['ls', '--segment', 'needs_you', '--kind', 'output', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'GET',
      path: `/v1/projects/${PROJECT}/review/items?segment=needs_you&kind=output`,
      body: null,
    });
    expect(r.stdout).toContain('rv_1');
    expect(r.stdout).toContain('Draft the Q3 pricing note');
    expect(r.stdout).toContain('cr:cr_9');
    expect(r.stdout).toContain('call:ex_7');
    expect(r.stdout).toContain('3 items');
  });

  test('ls --json emits the raw envelope', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['ls', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { review_items: Array<{ review_item_id: string }> };
    expect(parsed.review_items.map((x) => x.review_item_id)).toEqual(['rv_1', 'cr:cr_9', 'call:ex_7']);
  });

  test('ls rejects an unknown segment before any request', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['ls', '--segment', 'nope', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--segment must be one of');
    expect(calls).toEqual([]);
  });

  test('show reads the per-item route for a native id', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['show', 'rv_1', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls[0].path).toBe(`/v1/projects/${PROJECT}/review/items/rv_1`);
    expect(r.stdout).toContain('Draft the Q3 pricing note');
    expect(r.stdout).toContain('sess_1');
  });

  test('show reads the LIST for an adapted id — the per-item route only holds native rows', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['show', 'cr:cr_9', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(calls[0].path).toBe(`/v1/projects/${PROJECT}/review/items`);
    expect(JSON.parse(r.stdout).review_item_id).toBe('cr:cr_9');
  });

  test('act on a native id POSTs {verdict, feedback} to /act', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['act', 'rv_1', 'approve', '--message', 'looks right', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/review/items/rv_1/act`,
      body: { verdict: 'approve', feedback: 'looks right' },
    });
    expect(r.stdout).toContain('rv_1 → approved');
  });

  test('act approve on cr: merges; reject closes; changes needs --message', async () => {
    const config = writeConfig(startServer());
    const merged = await runCli(['act', 'cr:cr_9', 'approve', '--project', PROJECT], config);
    expect(merged.code).toBe(0);
    expect(calls[0].path).toBe(`/v1/projects/${PROJECT}/change-requests/cr_9/merge`);
    expect(merged.stdout).toContain('Shipped cr:cr_9');

    calls = [];
    const closed = await runCli(['act', 'cr:cr_9', 'reject', '--project', PROJECT], config);
    expect(closed.code).toBe(0);
    expect(calls[0].path).toBe(`/v1/projects/${PROJECT}/change-requests/cr_9/close`);

    calls = [];
    const noNote = await runCli(['act', 'cr:cr_9', 'changes', '--project', PROJECT], config);
    expect(noNote.code).toBe(2);
    expect(noNote.stderr).toContain('--message');
    expect(calls).toEqual([]);

    calls = [];
    const withNote = await runCli(['act', 'cr:cr_9', 'changes', '--message', 'Rename it first', '--project', PROJECT], config);
    expect(withNote.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/change-requests/cr_9/request-changes`,
      body: { feedback: 'Rename it first' },
    });
    expect(withNote.stdout).toContain('Sent to the agent');
  });

  test('act on call: resolves the approval; any other verdict is refused', async () => {
    const config = writeConfig(startServer());
    const denied = await runCli(['act', 'call:ex_7', 'reject', '--project', PROJECT], config);
    expect(denied.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/approvals/ex_7`,
      body: { decision: 'deny' },
    });

    calls = [];
    const dismissed = await runCli(['act', 'call:ex_7', 'dismiss', '--project', PROJECT], config);
    expect(dismissed.code).toBe(2);
    expect(dismissed.stderr).toContain('approve or reject');
    expect(calls).toEqual([]);
  });

  test('bulk sends only native ids and reports the skipped ones', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['bulk', 'dismiss', 'rv_1', 'cr:cr_9', 'call:ex_7', 'rv_2', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/review/bulk`,
      body: { ids: ['rv_1', 'rv_2'], verdict: 'dismiss' },
    });
    expect(r.stdout).toContain('2 items → dismiss');
    expect(r.stdout).toContain('call:ex_7 needs its own parameter review');
    expect(r.stdout).toContain('cr:cr_9 has no bulk path');
  });

  test('bulk over adapted ids only acts on nothing and exits 1', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['bulk', 'approve', 'cr:cr_9', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(calls).toEqual([]);
  });

  test('submit POSTs the full body and prints the new id', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['submit', '--kind', 'decision', '--title', 'Ship v2 pricing', '--summary', 'Two options', '--risk', 'medium', '--detail', '{"options":2}', '--agent', 'analyst', '--session', 'sess_1', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/review/items`,
      body: {
        kind: 'decision',
        title: 'Ship v2 pricing',
        summary: 'Two options',
        risk: 'medium',
        detail: { options: 2 },
        agent: 'analyst',
        session_id: 'sess_1',
      },
    });
    expect(r.stdout).toContain('rv_new');
  });

  test('submit without --title exits 2 and never calls the API', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['submit', '--kind', 'output', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--title');
    expect(calls).toEqual([]);
  });

  test('a 403 feature_disabled prints the server prose plus the enable command', async () => {
    const config = writeConfig(startServer());
    featureDisabled = true;
    const r = await runCli(['ls', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Review Center is not enabled for this project');
    expect(r.stderr).toContain('kortix projects features enable review_center');
  });

  test('a 404 on show surfaces the API message', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['show', 'rv_missing', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Review item not found');
  });

  test('an unknown subcommand exits 2 with help', async () => {
    const r = await runCli(['nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown subcommand "nope"');
  });
});
