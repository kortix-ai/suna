import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor } from '../commands/doctor.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };
const PROJECT_ID = '00000000-0000-4000-a000-0000000000aa';
const ENV_KEYS = [
  'KORTIX_CONFIG_FILE',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
];

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const ORIGINAL_STDERR_WRITE = process.stderr.write.bind(process.stderr);

let tmp: string;
let originalCwd: string;
let saved: Record<string, string | undefined>;
let createBodies: unknown[];
let output: string;
let resolvedForCaller: string | null;
let modelLookupFails: boolean;
let modelLookups: number;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-doctor-'));
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
          default_project: PROJECT_ID,
        },
      },
    }),
  );
  process.env.KORTIX_CONFIG_FILE = configFile;
  process.env.KORTIX_PROJECT_ID = PROJECT_ID;

  createBodies = [];
  output = '';
  resolvedForCaller = 'provider/available';
  modelLookupFails = false;
  modelLookups = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/model-defaults')) {
      modelLookups += 1;
      if (modelLookupFails) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ resolvedForCaller });
    }
    if (url.endsWith('/v1/accounts/me')) {
      return new Response(
        JSON.stringify({
          user_id: 'user_1',
          email: 'user@example.test',
          accounts: [{ account_id: 'acct_1', name: 'A', role: 'owner' }],
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    if (url.endsWith(`/v1/projects/${PROJECT_ID}/sessions`) && init?.method === 'POST') {
      createBodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : null);
      return new Response(JSON.stringify({ error: 'stop here' }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
    if (url.endsWith(`/v1/projects/${PROJECT_ID}`)) {
      return new Response(
        JSON.stringify({ project_id: PROJECT_ID, name: 'demo', account_id: 'acct_1' }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }) as typeof fetch;

  (process.stdout as { write: unknown }).write = (chunk: string) => {
    output += chunk;
    return true;
  };
  (process.stderr as { write: unknown }).write = () => true;
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

describe('kortix doctor session create payload', () => {
  test('pins an available model instead of inheriting a paid runtime default', async () => {
    await runDoctor([]);
    expect(createBodies[0]).toHaveProperty('model', 'provider/available');
  });

  test('explicitly skips inference when no model resolves for a free account', async () => {
    resolvedForCaller = null;
    expect(await runDoctor([])).toBe(0);
    expect(createBodies).toHaveLength(0);
    expect(output).toContain('agent reply skipped');
    expect(output).toContain('kortix providers');
    expect(output).not.toContain('all checks passed');
  });

  test('reports model lookup errors without creating a session', async () => {
    modelLookupFails = true;
    expect(await runDoctor([])).toBe(1);
    expect(createBodies).toHaveLength(0);
    expect(output).toContain('model lookup failed');
    expect(output).not.toContain('agent reply skipped');
  });

  test('discloses that UI-prepared warm sessions are left unchanged', async () => {
    await runDoctor([]);
    expect(output).toContain('UI-prepared warm sessions are left unchanged and may remain billed.');

  });

  test('keep-session still discloses warm sessions without claiming deletion', async () => {
    await runDoctor(['--keep-session']);
    expect(output).toContain('UI-prepared warm sessions are left unchanged and may remain billed.');
    expect(output).not.toContain('cleaned up');
  });

  test('no-session creates nothing and does not claim cleanup', async () => {
    expect(await runDoctor(['--no-session'])).toBe(0);
    expect(createBodies).toHaveLength(0);
    expect(output).not.toContain('may remain billed');
    expect(modelLookups).toBe(0);
  });
  test('never sends a null initial_prompt, which the API schema rejects with 400', async () => {
    await runDoctor([]);
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0]).not.toHaveProperty('initial_prompt', null);
  });

  test('omits initial_prompt entirely rather than sending an empty value', async () => {
    await runDoctor([]);
    expect(Object.keys(createBodies[0] as Record<string, unknown>)).not.toContain('initial_prompt');
  });
});
