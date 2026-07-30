import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSessionsDigest } from '../commands/sessions-digest.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const ORIGINAL_STDERR_WRITE = process.stderr.write.bind(process.stderr);
const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_CONFIG_FILE',
];

let tmp: string;
let originalCwd: string;
let saved: Record<string, string | undefined>;
let requests: string[];
let stdout: string;

function stoppedAcpSession() {
  return {
    session_id: '10533f77-00e3-420c-936b-82933e4d1025',
    account_id: 'acct_1',
    project_id: 'proj_1',
    branch_name: 'session/stopped',
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: '10533f77-00e3-420c-936b-82933e4d1025',
    sandbox_url: null,
    opencode_session_id: null,
    acp_server_id: '10533f77-00e3-420c-936b-82933e4d1025',
    acp_session_id: 'ses_04ff3eb99ffedjXUSdT2WJBShj',
    runtime_harness: 'opencode',
    native_agent: null,
    name: 'dead box',
    custom_name: null,
    agent_name: 'opencode',
    status: 'stopped',
    error: null,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function mockApi(): void {
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/sessions/10533f77-00e3-420c-936b-82933e4d1025/transcript')) {
      return new Response(
        JSON.stringify({
          available: true,
          reason: null,
          opencode_session_id: null,
          message_count: 1,
          messages: [
            {
              role: 'assistant',
              created: '2026-07-29T22:44:05.862Z',
              completed: '2026-07-29T22:44:10.756Z',
              text: 'served from postgres',
              tools: [],
              files: [],
              reasoning_omitted: true,
              error: null,
            },
          ],
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    if (url.includes('/projects/proj_1/sessions')) {
      return new Response(JSON.stringify([stoppedAcpSession()]), {
        status: 200,
        headers: JSON_HEADERS,
      });
    }
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }) as typeof fetch;
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-digest-'));
  process.chdir(tmp);
  const configFile = join(tmp, 'config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      active: 'cloud',
      hosts: {
        cloud: {
          url: 'https://api.test',
          token: 'kortix_pat_test',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'acct_1',
          logged_in_at: new Date().toISOString(),
        },
      },
    }),
  );
  process.env.KORTIX_CONFIG_FILE = configFile;
  mkdirSync(join(tmp, '.kortix'), { recursive: true });
  writeFileSync(
    join(tmp, '.kortix', 'link.json'),
    JSON.stringify({ host: 'cloud', project_id: 'proj_1' }),
  );
  stdout = '';
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  };
  (process.stderr as { write: unknown }).write = () => true;
  mockApi();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (process.stdout as { write: unknown }).write = ORIGINAL_STDOUT_WRITE;
  (process.stderr as { write: unknown }).write = ORIGINAL_STDERR_WRITE;
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE;
});

describe('kortix sessions digest — a stopped ACP session still has a transcript', () => {
  test('requests the transcript route for a stopped session instead of short-circuiting', async () => {
    await runSessionsDigest(['--all', '--json']);
    expect(requests.some((url) => url.includes('/transcript'))).toBe(true);
  });

  test('reports the transcript as available for a session whose sandbox is gone', async () => {
    const code = await runSessionsDigest(['--all', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      sessions: Array<{ transcript: { available: boolean; message_count: number } }>;
    };
    expect(parsed.sessions[0]!.transcript.available).toBe(true);
    expect(parsed.sessions[0]!.transcript.message_count).toBe(1);
  });

  test('carries the message text through to the digest', async () => {
    await runSessionsDigest(['--all', '--json']);
    const parsed = JSON.parse(stdout) as {
      sessions: Array<{ transcript: { messages: Array<{ text: string }> } }>;
    };
    expect(parsed.sessions[0]!.transcript.messages[0]!.text).toBe('served from postgres');
  });

  test('never claims a live sandbox is required', async () => {
    await runSessionsDigest(['--all', '--json']);
    expect(stdout).not.toContain('requires a running sandbox');
  });

  test('forwards the message and chars limits to the transcript route', async () => {
    await runSessionsDigest(['--all', '--json', '--messages', '7', '--chars', '250']);
    const transcriptUrl = requests.find((url) => url.includes('/transcript'))!;
    expect(transcriptUrl).toContain('limit=7');
    expect(transcriptUrl).toContain('chars=250');
  });
});
