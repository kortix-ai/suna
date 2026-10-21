import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

import { parseCustomModel } from '../commands/providers.ts';

/**
 * `kortix providers custom` drives the custom OpenAI-compatible endpoint
 * routes. Driven black-box through the real CLI process against a stub API:
 * what is pinned is the request that leaves the CLI and what lands on stdout.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT_ID = 'proj-test-1234';
const BASE = `/v1/projects/${PROJECT_ID}`;

const SAVED = {
  id: 'my-vllm',
  name: 'My vLLM',
  base_url: 'https://llm.example.test/v1',
  models: [{ id: 'qwen-3', name: 'Qwen 3' }, { id: 'llama-5', name: 'llama-5' }],
  secret_name: 'CUSTOM_MY_VLLM_API_KEY',
  has_key: false,
  configured: true,
};
const KEYED = {
  id: 'team-llm',
  name: 'Team LLM',
  base_url: 'https://team.example.test/v1',
  models: [{ id: 'm1', name: 'm1' }],
  secret_name: 'CUSTOM_TEAM_LLM_API_KEY',
  has_key: true,
  configured: true,
};
const LEGACY = {
  id: 'old',
  name: 'old',
  base_url: null,
  models: [],
  secret_name: 'CUSTOM_OLD_API_KEY',
  has_key: true,
  configured: false,
};

let server: ReturnType<typeof Bun.serve>;
let captured: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
/** Every secret-resources request with its query, for `providers retry`. */
let resourceRequests: Array<{ method: string; url: URL }> = [];
const ACCOUNT_ID = 'acc-1';
/** A ChatGPT login stored on the project, still resting after a rate limit. */
const COOLING = {
  secret_id: 'sec-1',
  label: 'ChatGPT',
  provider_id: 'codex',
  project_id: PROJECT_ID,
  cooldown_until: '2999-01-01T00:00:00.000Z',
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      captured.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === `${BASE}/custom-providers` && req.method === 'GET') {
        return json({ providers: [SAVED, KEYED, LEGACY] });
      }
      if (url.pathname === `${BASE}/custom-providers/my-vllm` && req.method === 'PUT') return json(SAVED);
      if (
        (url.pathname === `${BASE}/custom-providers/my-vllm` || url.pathname === `${BASE}/custom-providers/team-llm`) &&
        req.method === 'DELETE'
      ) {
        return new Response(null, { status: 204 });
      }
      // The secrets route answers 200 whether or not the secret existed.
      if (url.pathname.startsWith(`${BASE}/secrets/`) && req.method === 'DELETE') {
        return json({ ok: true });
      }
      if (url.pathname === `${BASE}/custom-providers/nope` && req.method === 'DELETE') {
        return json({ error: 'Custom provider not found' }, 404);
      }
      if (url.pathname === `${BASE}/secrets` && req.method === 'POST') {
        return json({ identifier: body.name, name: body.name });
      }
      if (url.pathname.startsWith(`/v1/accounts/${ACCOUNT_ID}/secret-resources`)) {
        resourceRequests.push({ method: req.method, url });
        if (req.method === 'POST') return json({ ...COOLING, cooldown_until: null });
        // Like the API: without project_id only account-wide (null-project) rows.
        const projectId = url.searchParams.get('project_id');
        return json({ secrets: projectId === COOLING.project_id ? [COOLING] : [] });
      }
      if (url.pathname === BASE) return json({ project_id: PROJECT_ID, account_id: 'acc-1' });
      return json({ error: 'unexpected' }, 500);
    },
  });
});

afterAll(() => server.stop(true));

async function runCli(args: string[], stdin?: string) {
  captured = [];
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, 'providers', 'custom', ...args, '--project', PROJECT_ID],
    cwd: CLI_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      KORTIX_TOKEN: 'kortix_pat_test',
      KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
      KORTIX_PROJECT_ID: PROJECT_ID,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const calls = captured.filter((c) => c.path.includes('/custom-providers') || c.path.includes('/secrets'));
  return { code, stdout, stderr, calls };
}

describe('parseCustomModel', () => {
  test('id=name splits on the first "="; a bare id names itself', () => {
    expect(parseCustomModel('qwen-3=Qwen 3')).toEqual({ id: 'qwen-3', name: 'Qwen 3' });
    expect(parseCustomModel('a=b=c')).toEqual({ id: 'a', name: 'b=c' });
    expect(parseCustomModel('llama-5')).toEqual({ id: 'llama-5', name: 'llama-5' });
  });
});

describe('kortix providers custom', () => {
  test('set PUTs the definition, then writes the stdin key as a gateway broker secret', async () => {
    const { code, stdout, calls } = await runCli(
      ['set', 'my-vllm', '--name', 'My vLLM', '--base-url', SAVED.base_url, '--model', 'qwen-3=Qwen 3', '--model', 'llama-5', '--key-stdin'],
      'sk-synthetic\n',
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: `${BASE}/custom-providers/my-vllm`,
        body: { name: 'My vLLM', base_url: SAVED.base_url, models: SAVED.models },
      },
      {
        method: 'POST',
        path: `${BASE}/secrets`,
        body: { name: 'CUSTOM_MY_VLLM_API_KEY', value: 'sk-synthetic', strategy: 'broker', consumer: 'llm_gateway' },
      },
    ]);
    expect(stdout).toContain('Saved my-vllm');
    expect(stdout).toContain('Key: CUSTOM_MY_VLLM_API_KEY');
  });

  test('set without --key-stdin writes no secret; --json prints the provider', async () => {
    const { code, stdout, calls } = await runCli([
      'set', 'my-vllm', '--base-url', SAVED.base_url, '--model', 'qwen-3', '--json',
    ]);
    expect(code).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(['PUT']);
    expect(calls[0]?.body).toEqual({ name: 'my-vllm', base_url: SAVED.base_url, models: [{ id: 'qwen-3', name: 'qwen-3' }] });
    expect(JSON.parse(stdout)).toEqual(SAVED);
  });

  test('set without --base-url or --model fails before any request', async () => {
    const noUrl = await runCli(['set', 'my-vllm', '--model', 'qwen-3']);
    expect(noUrl.code).not.toBe(0);
    expect(noUrl.stderr).toContain('--base-url');
    const noModel = await runCli(['set', 'my-vllm', '--base-url', SAVED.base_url]);
    expect(noModel.code).not.toBe(0);
    expect(noModel.stderr).toContain('--model');
    expect([...noUrl.calls, ...noModel.calls]).toEqual([]);
  });

  test('ls lists endpoints and the legacy key with no endpoint; --json passes the rows through', async () => {
    const table = await runCli(['ls']);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain('my-vllm');
    expect(table.stdout).toContain('https://llm.example.test/v1');
    expect(table.stdout).toContain('qwen-3, llama-5');
    expect(table.stdout).toContain('no endpoint (kortix providers custom set old');
    const listed = await runCli(['ls', '--json']);
    expect(JSON.parse(listed.stdout)).toEqual({ providers: [SAVED, KEYED, LEGACY] });
  });

  // KRTX-2992: the DELETE route removes the definition only; the key is the
  // project secret CUSTOM_<ID>_API_KEY, deleted through the secrets route
  // (the SDK's deleteCustomLlmProvider does the same two calls).
  test('rm DELETEs the definition and its CUSTOM_<ID>_API_KEY secret', async () => {
    const removed = await runCli(['rm', 'team-llm']);
    expect(removed.code).toBe(0);
    expect(removed.calls).toEqual([
      { method: 'GET', path: `${BASE}/custom-providers`, body: {} },
      { method: 'DELETE', path: `${BASE}/custom-providers/team-llm`, body: {} },
      { method: 'DELETE', path: `${BASE}/secrets/CUSTOM_TEAM_LLM_API_KEY`, body: {} },
    ]);
    expect(removed.stdout).toContain('Removed custom provider team-llm and its key CUSTOM_TEAM_LLM_API_KEY');
  });

  test('rm of an endpoint with no key deletes only the definition', async () => {
    const removed = await runCli(['rm', 'my-vllm']);
    expect(removed.code).toBe(0);
    expect(removed.calls.filter((c) => c.method === 'DELETE')).toEqual([
      { method: 'DELETE', path: `${BASE}/custom-providers/my-vllm`, body: {} },
    ]);
    expect(removed.stdout).toContain('Removed custom provider my-vllm');
    expect(removed.stdout).not.toContain('key');
  });

  test('rm of a legacy key with no endpoint deletes only the key', async () => {
    const removed = await runCli(['rm', 'old']);
    expect(removed.code).toBe(0);
    expect(removed.calls.filter((c) => c.method === 'DELETE')).toEqual([
      { method: 'DELETE', path: `${BASE}/secrets/CUSTOM_OLD_API_KEY`, body: {} },
    ]);
    expect(removed.stdout).toContain('Removed key CUSTOM_OLD_API_KEY');
  });

  test('rm of an unknown id removes nothing', async () => {
    const absent = await runCli(['rm', 'nope']);
    expect(absent.code).toBe(0);
    expect(absent.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(absent.stdout).toContain('Nothing to remove for "nope"');
  });

  test('an unknown custom action prints the usage with exit 2', async () => {
    const { code, stderr, calls } = await runCli(['bogus']);
    expect(code).toBe(2);
    expect(stderr).toContain('Usage: kortix providers');
    expect(calls).toEqual([]);
  });
});

// KRTX-2992: GET /accounts/:id/secret-resources without `project_id` lists only
// account-wide rows (apps/api/src/accounts/secret-resources.ts), but a ChatGPT
// login is stored on its project, so `retry` never found it.
describe('kortix providers retry', () => {
  async function runRetry(args: string[]) {
    resourceRequests = [];
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'providers', 'retry', ...args, '--account', ACCOUNT_ID],
      cwd: CLI_ROOT,
      env: {
        ...(process.env as Record<string, string>),
        KORTIX_TOKEN: 'kortix_pat_test',
        KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
        KORTIX_PROJECT_ID: PROJECT_ID,
        KORTIX_NO_UPDATE_CHECK: '1',
        KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { code, stdout };
  }

  test('lists the linked project\'s logins and ends the cooldown of the ChatGPT one', async () => {
    const r = await runRetry(['openai']);
    expect(r.code).toBe(0);
    expect(resourceRequests[0]?.url.searchParams.get('project_id')).toBe(PROJECT_ID);
    expect(resourceRequests.map((q) => `${q.method} ${q.url.pathname}`)).toEqual([
      `GET /v1/accounts/${ACCOUNT_ID}/secret-resources`,
      `POST /v1/accounts/${ACCOUNT_ID}/secret-resources/sec-1/retry`,
    ]);
    expect(r.stdout).toContain('ChatGPT (codex) is usable again');
  });

  test('--project names the project to read', async () => {
    const r = await runRetry(['--project', 'proj-other']);
    expect(r.code).toBe(0);
    expect(resourceRequests[0]?.url.searchParams.get('project_id')).toBe('proj-other');
  });
});
