import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pid = '11111111-1111-4111-8111-111111111111';
const aid = '22222222-2222-4222-8222-222222222222';
const tid = '33333333-3333-4333-8333-333333333333';
const agentPath = `/v1/workspaces/${pid}/artifacts/${aid}/live/agent`;

async function run(args: string[], base = 'http://127.0.0.1:1') {
  const home = mkdtempSync(join(tmpdir(), 'kortix-focus-'));
  try {
    const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'index.ts'), 'artifacts', ...args], {
      cwd: home, stdout: 'pipe', stderr: 'pipe', env: {
        PATH: process.env.PATH ?? '', HOME: home, CI: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
        KORTIX_CONFIG_FILE: join(home, 'config.json'), KORTIX_DEFAULT_API_BASE: base,
        KORTIX_API_URL: `${base}/v1`, KORTIX_TOKEN: 'kortix_pat_synthetic', KORTIX_PROJECT_ID: pid,
        KORTIX_FEATURE_FLAGS: 'artifacts,artifact_comments',
      },
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** A fake API that records every request and answers the agent route with `answer`. */
async function withApi(answer: () => Response, body: (base: string, requests: Array<{ method: string; path: string; body: unknown }>) => Promise<void>) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const text = await request.text();
    requests.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined });
    return path === agentPath ? answer() : Response.json({ error: 'Unexpected request' }, { status: 500 });
  } });
  try {
    await body(`http://127.0.0.1:${server.port}`, requests);
  } finally {
    server.stop(true);
  }
}

test('real CLI help lists focus and its flags', async () => {
  const result = await run(['--help']);
  expect(result.exitCode).toBe(0);
  for (const word of ['focus <artifact>', '--thread <thread-id>', '--status reading|editing|writing|idle', 'default editing']) {
    expect(result.stdout).toContain(word);
  }
});

test('real CLI focus posts the signal with the default status editing and prints one line', async () => {
  await withApi(() => new Response(null, { status: 204 }), async (base, requests) => {
    const result = await run(['focus', aid, '--thread', tid], base);
    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([{ method: 'POST', path: agentPath, body: { status: 'editing', thread_id: tid } }]);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout).toContain('editing');
    expect(result.stdout).toContain(tid);
  });
});

test('real CLI focus sends a quote, an explicit status, or only the status', async () => {
  await withApi(() => new Response(null, { status: 204 }), async (base, requests) => {
    expect((await run(['focus', aid, '--quote', 'Churn fell to 2.1%', '--status', 'writing'], base)).exitCode).toBe(0);
    expect((await run(['focus', aid, '--status', 'idle'], base)).exitCode).toBe(0);
    const json = await run(['focus', aid, '--status', 'reading', '--thread', tid, '--json'], base);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ artifact_id: aid, status: 'reading', thread_id: tid });
    expect(requests.map((request) => request.body)).toEqual([
      { status: 'writing', quote: 'Churn fell to 2.1%' },
      { status: 'idle' },
      { status: 'reading', thread_id: tid },
    ]);
  });
});

test('real CLI focus refuses bad arguments before any request', async () => {
  await withApi(() => new Response(null, { status: 204 }), async (base, requests) => {
    for (const args of [
      ['focus'],
      ['focus', aid, '--status', 'dancing'],
      ['focus', aid, '--thread', 'not-a-uuid'],
      ['focus', aid, '--thread', tid, '--quote', 'Both'],
      ['focus', aid, '--quote', ''],
      ['focus', aid, '--quote', 'q'.repeat(501)],
    ]) {
      const result = await run(args, base);
      expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 2 });
      expect(result.stderr).not.toContain('unknown subcommand');
    }
    expect(requests).toEqual([]);
  });
});

test('real CLI focus with a person token says focus is for agent sessions', async () => {
  await withApi(() => Response.json({ error: 'Only an agent session can signal focus' }, { status: 403 }), async (base) => {
    const result = await run(['focus', aid, '--thread', tid], base);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('focus is for agent sessions');
  });
});
