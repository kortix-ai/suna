import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runSessions } from '../commands/sessions';

const PROJECT_ID = '00000000-0000-4000-a000-000000000111';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000222';
const SESSION_ID = '00000000-0000-4000-a000-000000000333';
const PROXY_ID = 'external-approvals';

const ENV_KEYS = [
  'KORTIX_CONFIG_FILE',
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
] as const;

let dir = '';
let server: ReturnType<typeof Bun.serve> | null = null;
let acpReplies: unknown[] = [];
let pendingEnvelopes: unknown[] = [];
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const realStdoutWrite = process.stdout.write;
const realStderrWrite = process.stderr.write;

function sessionRow() {
  return {
    session_id: SESSION_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    branch_name: SESSION_ID,
    sandbox_provider: 'daytona',
    sandbox_id: 'sandbox-row-id',
    sandbox_url: `http://127.0.0.1/v1/p/${PROXY_ID}/8000`,
    opencode_session_id: 'ses_oc',
    name: null,
    agent_name: 'default',
    status: 'running',
    error: null,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('sessions pending/approve/answer', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
    dir = mkdtempSync(join(tmpdir(), 'kortix-approvals-'));
    acpReplies = [];
    pendingEnvelopes = [];
    stdoutChunks = [];
    stderrChunks = [];

    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`) {
          return Response.json(sessionRow());
        }
        if (req.method === 'GET' && url.pathname === `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/acp/transcript`) {
          return Response.json({ runtime_id: SESSION_ID, envelopes: pendingEnvelopes });
        }
        if (req.method === 'POST' && url.pathname === `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/acp`) {
          acpReplies.push(await req.json());
          return new Response(null, { status: 202 });
        }
        return Response.json({ error: `not found ${url.pathname}` }, { status: 404 });
      },
    });

    const configPath = join(dir, 'config.json');
    process.env.KORTIX_CONFIG_FILE = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        active: 'default',
        hosts: {
          default: {
            url: `http://127.0.0.1:${server.port}`,
            token: 'kortix_pat_test',
            user_id: 'user-1',
            user_email: 'user@example.test',
            account_id: ACCOUNT_ID,
            logged_in_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    server?.stop(true);
    server = null;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function permission(id: string) {
    return {
      ordinal: pendingEnvelopes.length + 1,
      direction: 'agent_to_client',
      streamEventId: pendingEnvelopes.length + 1,
      envelope: {
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId: 'acp-session',
          permission: 'bash',
          patterns: ['rm -rf *'],
          options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'reject', kind: 'reject', name: 'Reject' },
          ],
        },
      },
    };
  }

  function question(id: string) {
    return {
      ordinal: pendingEnvelopes.length + 1,
      direction: 'agent_to_client',
      streamEventId: pendingEnvelopes.length + 1,
      envelope: {
        jsonrpc: '2.0',
        id,
        method: 'elicitation/create',
        params: {
          sessionId: 'acp-session',
          message: 'Which environment should I deploy to?',
          requestedSchema: {
            type: 'object',
            properties: {
              environment: {
                title: 'Environment',
                enum: ['staging', 'production'],
              },
            },
          },
        },
      },
    };
  }

  test('pending --json emits permissions and questions', async () => {
    pendingEnvelopes = [permission('perm_1'), question('q_1')];

    const code = await runSessions(['pending', SESSION_ID, '--project', PROJECT_ID, '--json']);

    expect(code).toBe(0);
    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.permissions[0].id).toBe('perm_1');
    expect(payload.questions[0].id).toBe('q_1');
  });

  test('pending human output lists the ask and the command to answer it', async () => {
    pendingEnvelopes = [permission('perm_1')];

    const code = await runSessions(['pending', SESSION_ID, '--project', PROJECT_ID]);

    expect(code).toBe(0);
    const out = stdoutChunks.join('');
    expect(out).toContain('perm_1');
    expect(out).toContain('bash');
    expect(out).toContain(`kortix sessions approve ${SESSION_ID} perm_1`);
  });

  test('approve with an explicit request id replies once', async () => {
    const code = await runSessions(['approve', SESSION_ID, 'perm_1', '--project', PROJECT_ID]);

    expect(code).toBe(0);
    expect(acpReplies).toEqual([
      {
        jsonrpc: '2.0',
        id: 'perm_1',
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      },
    ]);
  });

  test('approve --always and --message pass through; bare approve resolves the single pending ask', async () => {
    pendingEnvelopes = [permission('perm_solo')];

    const code = await runSessions([
      'approve', SESSION_ID, '--always', '--message', 'go ahead', '--project', PROJECT_ID,
    ]);

    expect(code).toBe(0);
    expect(acpReplies).toEqual([
      {
        jsonrpc: '2.0',
        id: 'perm_solo',
        result: {
          outcome: { outcome: 'selected', optionId: 'allow_always' },
          _meta: { kortixMessage: 'go ahead' },
        },
      },
    ]);
  });

  test('approve --reject sends a rejection', async () => {
    const code = await runSessions(['approve', SESSION_ID, 'perm_x', '--reject', '--project', PROJECT_ID]);

    expect(code).toBe(0);
    expect(acpReplies).toEqual([
      {
        jsonrpc: '2.0',
        id: 'perm_x',
        result: { outcome: { outcome: 'cancelled' } },
      },
    ]);
  });

  test('bare approve with several pending permissions errors and lists ids', async () => {
    pendingEnvelopes = [permission('perm_a'), permission('perm_b')];

    const code = await runSessions(['approve', SESSION_ID, '--project', PROJECT_ID]);

    expect(code).toBe(1);
    expect(acpReplies).toEqual([]);
    const err = stderrChunks.join('');
    expect(err).toContain('perm_a');
    expect(err).toContain('perm_b');
  });

  test('answer maps option labels to canonical values', async () => {
    pendingEnvelopes = [question('q_1')];

    const code = await runSessions([
      'answer', SESSION_ID, 'q_1', '--option', 'Staging', '--project', PROJECT_ID,
    ]);

    expect(code).toBe(0);
    expect(acpReplies).toEqual([
      {
        jsonrpc: '2.0',
        id: 'q_1',
        result: { action: 'accept', content: { environment: 'staging' } },
      },
    ]);
  });

  test('answer --text sends free text; --reject dismisses', async () => {
    pendingEnvelopes = [question('q_1')];

    let code = await runSessions([
      'answer', SESSION_ID, 'q_1', '--text', 'use the blue one', '--project', PROJECT_ID,
    ]);
    expect(code).toBe(0);

    pendingEnvelopes = [question('q_2')];
    code = await runSessions(['answer', SESSION_ID, 'q_2', '--reject', '--project', PROJECT_ID]);
    expect(code).toBe(0);

    expect(acpReplies).toEqual([
      {
        jsonrpc: '2.0',
        id: 'q_1',
        result: { action: 'accept', content: { environment: 'use the blue one' } },
      },
      {
        jsonrpc: '2.0',
        id: 'q_2',
        result: { action: 'decline' },
      },
    ]);
  });

  test('answer without any answer flags errors before any network reply', async () => {
    const code = await runSessions(['answer', SESSION_ID, 'q_1', '--project', PROJECT_ID]);

    expect(code).toBe(2);
    expect(acpReplies).toEqual([]);
  });
});
