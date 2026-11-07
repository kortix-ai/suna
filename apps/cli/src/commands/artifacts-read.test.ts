import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pid = '11111111-1111-4111-8111-111111111111';
const aid = '22222222-2222-4222-8222-222222222222';
const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function run(args: string[], base: string) {
  const home = mkdtempSync(join(tmpdir(), 'kortix-read-'));
  try {
    const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'index.ts'), 'artifacts', ...args], {
      cwd: home, stdout: 'pipe', stderr: 'pipe', env: {
        PATH: process.env.PATH ?? '', HOME: home, CI: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
        KORTIX_CONFIG_FILE: join(home, 'config.json'), KORTIX_DEFAULT_API_BASE: base,
        KORTIX_API_URL: `${base}/v1`, KORTIX_TOKEN: 'kortix_pat_synthetic', KORTIX_PROJECT_ID: pid,
      },
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout: stdout.replace(/\u001b\[[0-9;]*m/g, ''), stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const artifact = (over: Record<string, unknown>) => ({
  artifact_id: aid, type: 'doc', visibility: 'project', title: 'Q3 churn report', description: 'Churn by cohort', path: '/Artifacts/q3.md',
  pinned: true, can_edit: true, shared_with_user_ids: ['u1', 'u2'], created_by: { user_id: 'u0', name: 'Ada', email: 'ada@example.com' },
  entry_version: 'v-7', web_url: 'https://app/a', public_url: null, view_url: 'https://app/v',
  updated_at: ago(5 * MINUTE), version: { files: [{ path: 'index.md', size: 1234 }, { path: 'img/a.png', size: 7 }] }, ...over,
});

async function withApi(answer: (path: string) => unknown, body: (base: string) => Promise<void>) {
  const server = Bun.serve({ port: 0, fetch: (request) => Response.json(answer(new URL(request.url).pathname)) });
  try {
    await body(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
}

// The CLI calls the canonical /v1/workspaces names; /v1/projects is the permanent alias.
const answer = (rawPath: string) => {
  const path = rawPath.replace(/^\/v1\/workspaces\//, '/v1/projects/');
  if (path === `/v1/projects/${pid}/artifacts`) return { artifacts: [artifact({}), artifact({ artifact_id: '33333333-3333-4333-8333-333333333333', type: 'html', visibility: 'private', pinned: false, title: 'Old deck', path: '/Artifacts/deck', updated_at: ago(3 * 3600_000) }), artifact({ artifact_id: '44444444-4444-4444-8444-444444444444', title: 'Ancient', pinned: false, updated_at: ago(45 * 86_400_000) })] };
  if (path === `/v1/projects/${pid}/artifacts/${aid}/versions`) return { versions: [{ id: 'ver-b', number: 2, created_at: ago(2 * 86_400_000) }, { id: 'ver-a', number: 1, created_at: ago(10 * MINUTE) }] };
  if (path === `/v1/projects/${pid}/artifacts/${aid}`) return artifact({});
  return { error: path };
};

test('artifacts ls prints one row per artifact: short id, type, visibility, age, pin, title, path', async () => {
  await withApi(answer, async (base) => {
    const result = await run(['ls'], base);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      '22222222  doc   workspace  5m ago   ★ Q3 churn report  /Artifacts/q3.md',
      '33333333  html  private    3h ago   Old deck  /Artifacts/deck',
      '44444444  doc   workspace  45d ago  Ancient  /Artifacts/q3.md',
    ]);
  });
});

test('artifacts info prints the title line, the facts line, entry_version, description, files and the links in that order', async () => {
  await withApi(answer, async (base) => {
    const result = await run(['info', aid], base);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      `Q3 churn report  ${aid}`,
      '  doc · workspace + 2 people · by Ada · updated 5m ago',
      '  entry_version v-7',
      '  Churn by cohort',
      '  1234     index.md',
      '  7        img/a.png',
      '  files   /Artifacts/q3.md',
      '  app     https://app/a',
      '  view    https://app/v  (signed, 12 h)',
    ]);
  });
});

test('artifacts versions prints number, age and id per save', async () => {
  await withApi(answer, async (base) => {
    const result = await run(['versions', aid], base);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toEqual(['#2    2d ago   ver-b', '#1    10m ago  ver-a']);
  });
});
