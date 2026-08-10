/**
 * `kortix access invite` must not claim an email was sent when none was.
 *
 * Every deployment without `MAILTRAP_API_TOKEN` — which is every self-hosted
 * instance — skips the email. The server says so in the SAME response
 * (`email_sent: false`, a `email_skip_reason`, a `message`, and a working
 * `invite_url`, which is the only remaining way to reach the person), and the
 * comment at the route calls that out as deliberate: "we know synchronously
 * it'll be skipped, so report that honestly".
 *
 * The CLI typed the response as `{ status?: string }`, discarded all four
 * fields, and printed a green tick. The inviter waited for a delivery that never
 * happened, and the one link that would have worked was thrown away — with no
 * recovery path, since `--json` was ignored here and `access pending` returns
 * the invite id without the URL.
 *
 * The web dashboard already warns and offers a "Copy link" button for this exact
 * payload, so a CLI user and a web user doing the same thing were told opposite
 * things.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAccess } from '../commands/access.ts';
import { stripAnsi } from '../style.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_WORKSPACE_ID',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

const WORKSPACE = 'workspace-1';
const INVITE_URL = 'https://app.test/invite/inv_abc123';

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
/** What the mocked invite route answers. Each test sets this. */
let inviteResponse: Record<string, unknown>;
let pendingResponse: Record<string, unknown>;

function writeConfig(): void {
  const file = join(tmp, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: 'https://api.test',
          token: 'tok_test',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  process.env.KORTIX_CONFIG_FILE = file;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-invite-test-'));
  process.chdir(tmp);
  writeConfig();
  stdout = '';
  stderr = '';
  (process.stdout as any).write = (chunk: unknown) => ((stdout += String(chunk)), true);
  (process.stderr as any).write = (chunk: unknown) => ((stderr += String(chunk)), true);
  inviteResponse = {};
  pendingResponse = { pending: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/access/invite') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      return json(inviteResponse, 201);
    }
    if (url.includes('/access/pending-invites') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
      return json(pendingResponse);
    }
    return json({ error: `unexpected ${url}` }, 500);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (process.stdout as any).write = ORIGINAL_STDOUT_WRITE;
  (process.stderr as any).write = ORIGINAL_STDERR_WRITE;
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const invite = (extra: Record<string, unknown>) => ({
  status: 'invited',
  email: 'bob@corp.com',
  invite_id: 'inv_abc123',
  workspace_role: 'editor',
  invite_url: INVITE_URL,
  ...extra,
});

describe('kortix access invite — email honesty', () => {
  test('a SKIPPED email is reported as such, with the link that still works', async () => {
    inviteResponse = invite({ email_sent: false, email_skip_reason: 'email_not_configured' });

    const code = await runAccess(['invite', 'bob@corp.com', '--workspace', WORKSPACE, '--role', 'editor']);
    const out = stripAnsi(stdout);

    expect(code).toBe(0);
    // The claim that used to be printed unconditionally.
    expect(out).toContain('NO email was sent');
    // The only remaining delivery channel — discarding it left no recovery path.
    expect(out).toContain(INVITE_URL);
    // And it says WHY, so the operator can go fix the deployment.
    expect(out).toContain('email_not_configured');
  });

  test('a SENT email still reads as a plain success', async () => {
    inviteResponse = invite({ email_sent: true, email_skip_reason: null });

    const code = await runAccess(['invite', 'bob@corp.com', '--workspace', WORKSPACE, '--role', 'editor']);
    const out = stripAnsi(stdout);

    expect(code).toBe(0);
    expect(out).toContain('Invited');
    expect(out).toContain('bob@corp.com');
    expect(out).not.toContain('NO email was sent');
    // No link needed when it actually went out — printing one would train people
    // to ignore the warning case.
    expect(out).not.toContain(INVITE_URL);
  });

  test('an OLDER API that omits email_sent keeps the previous wording', async () => {
    // `undefined` is not `false`. Inventing a warning for a server that simply
    // predates the field would cry wolf on every deployment that is fine.
    inviteResponse = { status: 'invited' };

    const code = await runAccess(['invite', 'bob@corp.com', '--workspace', WORKSPACE, '--role', 'editor']);
    const out = stripAnsi(stdout);

    expect(code).toBe(0);
    expect(out).toContain('Invited');
    expect(out).not.toContain('NO email was sent');
  });

  test('--json emits the full payload, including the fields the CLI used to drop', async () => {
    // Previously ignored on this subcommand, so a scripted caller had no way to
    // detect the skip either.
    inviteResponse = invite({ email_sent: false, email_skip_reason: 'email_not_configured' });

    const code = await runAccess([
      'invite', 'bob@corp.com', '--workspace', WORKSPACE, '--role', 'editor', '--json',
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.email_sent).toBe(false);
    expect(parsed.email_skip_reason).toBe('email_not_configured');
    expect(parsed.invite_url).toBe(INVITE_URL);
  });

  test('pending displays the invited member email from the API payload', async () => {
    pendingResponse = {
      pending: [
        {
          invite_id: 'inv_abc123',
          email: 'pending@corp.com',
          workspace_role: 'editor',
          invited_by_email: 'owner@corp.com',
          invite_expired: false,
        },
      ],
    };

    const code = await runAccess(['pending', '--workspace', WORKSPACE]);

    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('pending@corp.com');
    expect(stripAnsi(stdout)).not.toContain('undefined');
  });

  test('the deprecated --project flag remains an alias for --workspace', async () => {
    inviteResponse = invite({ email_sent: true });

    const code = await runAccess(['invite', 'bob@corp.com', '--project', WORKSPACE, '--role', 'editor']);

    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('Invited');
  });
});
