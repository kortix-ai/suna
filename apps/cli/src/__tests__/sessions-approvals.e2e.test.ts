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
let permissionReplies: Array<{ id: string; body: unknown }> = [];
let questionReplies: Array<{ id: string; body: unknown; kind: 'reply' | 'reject' }> = [];
let pendingPermissions: unknown[] = [];
let pendingQuestions: unknown[] = [];
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
    permissionReplies = [];
    questionReplies = [];
    pendingPermissions = [];
    pendingQuestions = [];
    stdoutChunks = [];
    stderrChunks = [];

    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`) {
          return Response.json(sessionRow());
        }
        if (req.method === 'GET' && url.pathname === `/v1/p/${PROXY_ID}/4096/permission`) {
          return Response.json(pendingPermissions);
        }
        if (req.method === 'GET' && url.pathname === `/v1/p/${PROXY_ID}/4096/question`) {
          return Response.json(pendingQuestions);
        }
        const permReply = url.pathname.match(
          new RegExp(`^/v1/p/${PROXY_ID}/4096/permission/([^/]+)/reply$`),
        );
        if (req.method === 'POST' && permReply) {
          permissionReplies.push({ id: permReply[1], body: await req.json() });
          return Response.json(true);
        }
        const qReply = url.pathname.match(
          new RegExp(`^/v1/p/${PROXY_ID}/4096/question/([^/]+)/(reply|reject)$`),
        );
        if (req.method === 'POST' && qReply) {
          questionReplies.push({
            id: qReply[1],
            body: await req.json().catch(() => null),
            kind: qReply[2] as 'reply' | 'reject',
          });
          return Response.json(true);
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
      id,
      sessionID: 'ses_oc',
      permission: 'bash',
      patterns: ['rm -rf *'],
      metadata: {},
      always: [],
      tool: { messageID: 'msg_1', callID: 'call_1' },
    };
  }

  function question(id: string) {
    return {
      id,
      sessionID: 'ses_oc',
      questions: [
        {
          question: 'Which environment should I deploy to?',
          header: 'Environment',
          options: [
            { label: 'Staging', value: 'staging' },
            { label: 'Production', value: 'production' },
          ],
        },
      ],
      tool: { messageID: 'msg_2', callID: 'call_2' },
    };
  }

  test('pending --json emits permissions and questions', async () => {
    pendingPermissions = [permission('perm_1')];
    pendingQuestions = [question('q_1')];

    const code = await runSessions(['pending', SESSION_ID, '--project', PROJECT_ID, '--json']);

    expect(code).toBe(0);
    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.permissions[0].id).toBe('perm_1');
    expect(payload.questions[0].id).toBe('q_1');
  });

  test('pending human output lists the ask and the command to answer it', async () => {
    pendingPermissions = [permission('perm_1')];

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
    expect(permissionReplies).toEqual([{ id: 'perm_1', body: { reply: 'once' } }]);
  });

  test('approve --always and --message pass through; bare approve resolves the single pending ask', async () => {
    pendingPermissions = [permission('perm_solo')];

    const code = await runSessions([
      'approve', SESSION_ID, '--always', '--message', 'go ahead', '--project', PROJECT_ID,
    ]);

    expect(code).toBe(0);
    expect(permissionReplies).toEqual([
      { id: 'perm_solo', body: { reply: 'always', message: 'go ahead' } },
    ]);
  });

  test('approve --reject sends a rejection', async () => {
    const code = await runSessions(['approve', SESSION_ID, 'perm_x', '--reject', '--project', PROJECT_ID]);

    expect(code).toBe(0);
    expect(permissionReplies).toEqual([{ id: 'perm_x', body: { reply: 'reject' } }]);
  });

  test('bare approve with several pending permissions errors and lists ids', async () => {
    pendingPermissions = [permission('perm_a'), permission('perm_b')];

    const code = await runSessions(['approve', SESSION_ID, '--project', PROJECT_ID]);

    expect(code).toBe(1);
    expect(permissionReplies).toEqual([]);
    const err = stderrChunks.join('');
    expect(err).toContain('perm_a');
    expect(err).toContain('perm_b');
  });

  test('answer maps option labels to canonical values', async () => {
    pendingQuestions = [question('q_1')];

    const code = await runSessions([
      'answer', SESSION_ID, 'q_1', '--option', 'Staging', '--project', PROJECT_ID,
    ]);

    expect(code).toBe(0);
    expect(questionReplies).toEqual([
      { id: 'q_1', body: { answers: [['staging']] }, kind: 'reply' },
    ]);
  });

  test('answer --text sends free text; --reject dismisses', async () => {
    pendingQuestions = [question('q_1')];

    let code = await runSessions([
      'answer', SESSION_ID, 'q_1', '--text', 'use the blue one', '--project', PROJECT_ID,
    ]);
    expect(code).toBe(0);

    pendingQuestions = [question('q_2')];
    code = await runSessions(['answer', SESSION_ID, 'q_2', '--reject', '--project', PROJECT_ID]);
    expect(code).toBe(0);

    expect(questionReplies).toEqual([
      { id: 'q_1', body: { answers: [['use the blue one']] }, kind: 'reply' },
      { id: 'q_2', body: {}, kind: 'reject' },
    ]);
  });

  test('answer without any answer flags errors before any network reply', async () => {
    const code = await runSessions(['answer', SESSION_ID, 'q_1', '--project', PROJECT_ID]);

    expect(code).toBe(2);
    expect(questionReplies).toEqual([]);
  });
});
