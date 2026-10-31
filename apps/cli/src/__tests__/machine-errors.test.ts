import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `KORTIX_ERROR_FORMAT=json`: a program runs the CLI (My Kortix's platform
 * tools in kortixd, `services/tools/platform/platform.ts`), so a failure is one
 * `{"kortix_error":{…}}` line on stderr, never colored prose to parse. A
 * validation failure carries the API's issues, so the caller can fix its
 * input; a refusal names the refused action.
 *
 * Driven black-box: the real CLI process against a stub API.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT_ID = 'proj-test-machine-errors';

let server: ReturnType<typeof Bun.serve>;
let respondWith: () => Response;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-machine-errors-'));
  server = Bun.serve({ port: 0, fetch: () => respondWith() });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const json = (payload: unknown, status: number) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

async function runCli(args: string[], machine: boolean) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: CLI_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      KORTIX_TOKEN: 'session-agent-token',
      KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
      KORTIX_PROJECT_ID: PROJECT_ID,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      NO_COLOR: '1',
      ...(machine ? { KORTIX_ERROR_FORMAT: 'json' } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const lines = stderr
    .split('\n')
    .filter((line) => line.startsWith('{"kortix_error"'))
    .map((line) => (JSON.parse(line) as { kortix_error: Record<string, unknown> }).kortix_error);
  return { code, stdout, stderr, lines };
}

describe('KORTIX_ERROR_FORMAT=json', () => {
  test('a validation failure is one machine line with the API issues', async () => {
    respondWith = () =>
      json({ error: true, message: 'Validation failed', status: 400, issues: [{ code: 'unrecognized_keys', path: [], message: "Unrecognized key(s) in object: 'description'" }] }, 400);
    const file = join(dir, 'block.json');
    writeFileSync(file, JSON.stringify({ description: 'x' }));
    const result = await runCli(['agents', 'config', 'writer', '--file', file, '--json'], true);
    expect(result.code).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ kind: 'failed', status: 400 });
    expect(String(result.lines[0]?.message)).toContain("(body): Unrecognized key(s) in object: 'description'");
  });

  test('a refusal is a denied line that names the action', async () => {
    respondWith = () => json({ error: true, message: 'Forbidden', status: 403, code: 'forbidden', action: 'project.agent.update' }, 403);
    const file = join(dir, 'block.json');
    writeFileSync(file, JSON.stringify({ behavior: { prompt: 'x' } }));
    const result = await runCli(['agents', 'config', 'writer', '--file', file, '--json'], true);
    expect(result.code).not.toBe(0);
    expect(result.lines.find((line) => line.kind === 'denied')).toMatchObject({ kind: 'denied', status: 403, action: 'project.agent.update' });
  });

  test('without the variable, people still get the human output and no machine line', async () => {
    respondWith = () => json({ error: true, message: 'Validation failed', status: 400 }, 400);
    const file = join(dir, 'block.json');
    writeFileSync(file, JSON.stringify({ description: 'x' }));
    const result = await runCli(['agents', 'config', 'writer', '--file', file, '--json'], false);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([]);
    expect(result.stderr).toContain('Validation failed');
  });
});

describe('a session box reads its own project usage', () => {
  test('billing costs --project sends the project id and no account id', async () => {
    const seen: string[] = [];
    respondWith = () => json({ totals: { total_cost: 1.5, llm_cost: 1, compute_cost: 0.5 }, previous: { total_cost: 1 } }, 200);
    const stub = Bun.serve({ port: 0, fetch: (req) => { seen.push(new URL(req.url).pathname + new URL(req.url).search); return respondWith(); } });
    try {
      const proc = Bun.spawn({
        cmd: [process.execPath, CLI_ENTRY, 'billing', 'costs', '--project', PROJECT_ID, '--json'],
        cwd: CLI_ROOT,
        env: { ...(process.env as Record<string, string>), KORTIX_TOKEN: 'session-agent-token', KORTIX_API_URL: `http://127.0.0.1:${stub.port}/v1`, KORTIX_PROJECT_ID: PROJECT_ID, KORTIX_NO_UPDATE_CHECK: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(code).toBe(0);
      const summary = seen.find((path) => path.startsWith('/v1/usage/cost-summary'));
      expect(summary).toContain(`project_id=${PROJECT_ID}`);
      expect(summary).not.toContain('account_id');
      expect(JSON.parse(stdout).credits.total).toBe('150');
    } finally {
      stub.stop(true);
    }
  });
});

describe('kortix agents ls', () => {
  test('a built-in agent shows as "My Kortix, built in", never a file path', async () => {
    respondWith = () => json({}, 200);
    const stub = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path.endsWith('/model-defaults')) return json({ agentDefaults: {}, projectDefault: null, accountDefault: null, platformDefault: 'kimi' }, 200);
        if (path.endsWith('/detail')) {
          return json({ config: { default_agent: 'mykortix', agents: [{ name: 'mykortix', path: '', platform: true, description: 'The one agent you talk to.' }, { name: 'worker', path: 'agents/worker.md' }] } }, 200);
        }
        return json({}, 404);
      },
    });
    try {
      const proc = Bun.spawn({
        cmd: [process.execPath, CLI_ENTRY, 'agents', 'ls'],
        cwd: CLI_ROOT,
        env: { ...(process.env as Record<string, string>), KORTIX_TOKEN: 'session-agent-token', KORTIX_API_URL: `http://127.0.0.1:${stub.port}/v1`, KORTIX_PROJECT_ID: PROJECT_ID, KORTIX_NO_UPDATE_CHECK: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(code).toBe(0);
      const row = stdout.split('\n').find((line) => line.trim().startsWith('mykortix'));
      expect(row).toContain('My Kortix, built in');
      expect(row).toContain('default agent');
      expect(stdout).not.toContain('AGENTS.md');
      expect(stdout.split('\n').find((line) => line.trim().startsWith('worker'))).toContain('agents/worker.md');
    } finally {
      stub.stop(true);
    }
  });
});
