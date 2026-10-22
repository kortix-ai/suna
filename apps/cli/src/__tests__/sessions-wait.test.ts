import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyWaitPoll,
  isAuthoritativelySettled,
  settledTurnOutcome,
} from '../commands/sessions-wait.ts';
import { runSessions } from '../commands/sessions.ts';

describe('classifyWaitPoll', () => {
  test('an absent status entry means the agent loop is idle', () => {
    expect(classifyWaitPoll({}, 'oc_1', { permissions: 0, questions: 0 })).toBe('idle');
  });

  test('an explicit idle status is idle', () => {
    expect(
      classifyWaitPoll({ oc_1: { type: 'idle' } }, 'oc_1', { permissions: 0, questions: 0 }),
    ).toBe('idle');
  });

  test('any non-idle status means the agent is working', () => {
    expect(
      classifyWaitPoll({ oc_1: { type: 'busy' } }, 'oc_1', { permissions: 0, questions: 0 }),
    ).toBe('working');
    expect(
      classifyWaitPoll({ oc_1: { type: 'retry', attempt: 2 } }, 'oc_1', {
        permissions: 0,
        questions: 0,
      }),
    ).toBe('working');
  });

  test('pending permission or question asks report blocked, even mid-turn', () => {
    expect(
      classifyWaitPoll({ oc_1: { type: 'busy' } }, 'oc_1', { permissions: 1, questions: 0 }),
    ).toBe('blocked');
    expect(classifyWaitPoll({}, 'oc_1', { permissions: 0, questions: 2 })).toBe('blocked');
  });

  test('another session being busy does not affect this one', () => {
    expect(
      classifyWaitPoll({ oc_2: { type: 'busy' } }, 'oc_1', { permissions: 0, questions: 0 }),
    ).toBe('idle');
  });
});

describe('isAuthoritativelySettled', () => {
  test('accepts completed sessions', () => {
    expect(isAuthoritativelySettled('completed')).toBe(true);
  });

  test('does not treat a manual or interrupted stop as completion', () => {
    expect(isAuthoritativelySettled('stopped')).toBe(false);
  });
});

describe('settledTurnOutcome', () => {
  const now = Date.parse('2026-10-11T12:00:00.000Z');
  const fresh = (msBefore: number) => new Date(now - msBefore).toISOString();

  test('a turn running again between polls keeps the wait going', () => {
    expect(
      settledTurnOutcome(
        {
          turns: [{ turn_token: 't2' }],
          last_ended: {
            end_reason: 'failed',
            ended_at: fresh(1_000),
            error: { message: 'boom' },
          },
        },
        now,
      ),
    ).toEqual({ state: 'working' });
  });

  test('a completed last turn settles ok', () => {
    expect(
      settledTurnOutcome(
        { turns: [], last_ended: { end_reason: 'completed', ended_at: fresh(1_000) } },
        now,
      ),
    ).toEqual({ state: 'ok' });
  });

  test('no turn history settles ok', () => {
    expect(settledTurnOutcome({ turns: [] }, now)).toEqual({ state: 'ok' });
  });

  test('a failure older than the freshness window is history, not the waited turn', () => {
    expect(
      settledTurnOutcome(
        {
          turns: [],
          last_ended: {
            end_reason: 'failed',
            ended_at: fresh(61_001),
            error: { message: 'stale boom' },
          },
        },
        now,
      ),
    ).toEqual({ state: 'ok' });
  });

  test('a failure right at the freshness boundary still counts', () => {
    expect(
      settledTurnOutcome(
        {
          turns: [],
          last_ended: {
            end_reason: 'failed',
            ended_at: fresh(60_000),
            error: { message: 'boundary boom' },
          },
        },
        now,
      ),
    ).toEqual({ state: 'failed', reason: 'boundary boom' });
  });

  test('a fresh failure carries the recorded cause', () => {
    expect(
      settledTurnOutcome(
        {
          turns: [],
          last_ended: {
            end_reason: 'failed',
            ended_at: fresh(500),
            error: { message: 'Synthetic model requires a paid plan.' },
          },
        },
        now,
      ),
    ).toEqual({ state: 'failed', reason: 'Synthetic model requires a paid plan.' });
  });

  test('a fresh failure nobody named still fails, with a marker reason', () => {
    expect(
      settledTurnOutcome(
        { turns: [], last_ended: { end_reason: 'failed', ended_at: fresh(500), error: null } },
        now,
      ),
    ).toEqual({ state: 'failed', reason: 'No cause recorded' });
    expect(
      settledTurnOutcome({ turns: [], last_ended: { end_reason: 'failed', ended_at: null } }, now),
    ).toEqual({ state: 'failed', reason: 'No cause recorded' });
  });
});

// ─── End to end: the exit code carries the turn's outcome ───────────────────

const PROJECT_ID = '00000000-0000-4000-a000-00000000c411';
const ACCOUNT_ID = '00000000-0000-4000-a000-00000000c422';
const OPENCODE_SESSION_ID = 'ses_cli_wait';
const TOKEN = 'kortix_pat_cli_wait';
// One session per test: the SDK caches start/ready records per
// (projectId, sessionId) process-globally, so two tests sharing an id would
// point the second test's polls at the first test's already-stopped server.
const SESSION_ID_FAILED_JSON = '00000000-0000-4000-a000-00000000c433';
const SESSION_ID_FAILED_TEXT = '00000000-0000-4000-a000-00000000c434';
const SESSION_ID_COMPLETED = '00000000-0000-4000-a000-00000000c435';
let sessionId = '';
let externalId = '';

function sessionRow() {
  return {
    session_id: sessionId,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    branch_name: sessionId,
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: sessionId,
    sandbox_url: null,
    opencode_session_id: OPENCODE_SESSION_ID,
    name: 'SDK wait',
    custom_name: null,
    agent_name: 'default',
    status: 'running',
    error: null,
    metadata: {},
    created_at: '2026-10-11T00:00:00.000Z',
    updated_at: '2026-10-11T00:00:00.000Z',
  };
}

const ENV_KEYS = [
  'KORTIX_CONFIG_FILE',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
] as const;

const savedEnv: Record<string, string | undefined> = {};
const realStdoutWrite = process.stdout.write;
const realStderrWrite = process.stderr.write;

let directory = '';
let server: ReturnType<typeof Bun.serve> | null = null;
let stdout = '';
let stderr = '';
/** The control plane's `/turn` answer, per test. */
let turnStatus: Record<string, unknown> = { turns: [] };

function failedTurn(turnEndMs: number) {
  return {
    turns: [],
    last_ended: {
      turn_token: 'turn_failed',
      message_id: 'msg_failed',
      end_reason: 'failed',
      ended_at: new Date(turnEndMs).toISOString(),
      error: { message: 'Synthetic model requires a paid plan.' },
    },
    recent_failures: [
      {
        message_id: 'msg_failed',
        ended_at: new Date(turnEndMs).toISOString(),
        error: { message: 'Synthetic model requires a paid plan.' },
      },
    ],
  };
}

describe('wait-for carries a failed turn out through the exit code', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';

    directory = mkdtempSync(join(tmpdir(), 'kortix-cli-sdk-wait-'));
    stdout = '';
    stderr = '';
    turnStatus = { turns: [] };

    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (
          request.method === 'GET' &&
          url.pathname === `/v1/projects/${PROJECT_ID}/sessions/${sessionId}`
        ) {
          return Response.json(sessionRow());
        }
        if (
          request.method === 'POST' &&
          url.pathname === `/v1/projects/${PROJECT_ID}/sessions/${sessionId}/start`
        ) {
          return Response.json({
            stage: 'ready',
            agent_name: 'default',
            retriable: false,
            sandbox: { external_id: externalId },
            opencode_session_id: OPENCODE_SESSION_ID,
          });
        }
        if (
          request.method === 'GET' &&
          url.pathname === `/v1/projects/${PROJECT_ID}/sessions/${sessionId}/turn`
        ) {
          return Response.json(turnStatus);
        }
        if (
          request.method === 'GET' &&
          url.pathname === `/v1/p/${externalId}/8000/session/status`
        ) {
          return Response.json({});
        }
        if (request.method === 'GET' && url.pathname === `/v1/p/${externalId}/8000/permission`) {
          return Response.json([]);
        }
        if (request.method === 'GET' && url.pathname === `/v1/p/${externalId}/8000/question`) {
          return Response.json([]);
        }
        return Response.json(
          { error: `unexpected ${request.method} ${url.pathname}` },
          { status: 404 },
        );
      },
    });

    const configPath = join(directory, 'config.json');
    process.env.KORTIX_CONFIG_FILE = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        active: 'default',
        hosts: {
          default: {
            url: `http://127.0.0.1:${server.port}`,
            token: TOKEN,
            user_id: 'user-cli-wait',
            user_email: 'cli-wait@example.test',
            account_id: ACCOUNT_ID,
            logged_in_at: '2026-10-11T00:00:00.000Z',
          },
        },
      }),
    );

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    server?.stop(true);
    server = null;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test('a turn that just failed exits 1 and names the cause as JSON', async () => {
    sessionId = SESSION_ID_FAILED_JSON;
    externalId = 'external-cli-wait-1';
    turnStatus = failedTurn(Date.now());
    const code = await runSessions([
      'wait-for',
      sessionId,
      '--project',
      PROJECT_ID,
      '--timeout',
      '20',
      '--json',
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(1);
    const payload = JSON.parse(stdout) as {
      settled: boolean;
      blocked: boolean;
      waited_ms: number;
      failed?: boolean;
      error?: string;
    };
    expect(payload.settled).toBe(true);
    expect(payload.blocked).toBe(false);
    expect(payload.failed).toBe(true);
    expect(payload.error).toBe('Synthetic model requires a paid plan.');
  }, 30_000);

  test('a turn that just failed exits 1 and prints the cause as text', async () => {
    sessionId = SESSION_ID_FAILED_TEXT;
    externalId = 'external-cli-wait-2';
    turnStatus = failedTurn(Date.now());
    const code = await runSessions([
      'wait-for',
      sessionId,
      '--project',
      PROJECT_ID,
      '--timeout',
      '20',
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain('Agent turn failed: Synthetic model requires a paid plan.');
  }, 30_000);

  test('a completed turn still settles with exit 0', async () => {
    sessionId = SESSION_ID_COMPLETED;
    externalId = 'external-cli-wait-3';
    turnStatus = {
      turns: [],
      last_ended: {
        turn_token: 'turn_ok',
        message_id: 'msg_ok',
        end_reason: 'completed',
        ended_at: new Date(Date.now()).toISOString(),
      },
    };
    const code = await runSessions([
      'wait-for',
      sessionId,
      '--project',
      PROJECT_ID,
      '--timeout',
      '20',
      '--json',
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as { settled: boolean; failed?: boolean };
    expect(payload.settled).toBe(true);
    expect(payload.failed).toBeUndefined();
  }, 30_000);
});
