import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pid = '11111111-1111-4111-8111-111111111111';
const aid = '22222222-2222-4222-8222-222222222222';

async function run(args: string[], base = 'http://127.0.0.1:1', command = 'artifacts') {
  const home = mkdtempSync(join(tmpdir(), 'kortix-comments-'));
  try {
    const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'index.ts'), ...(command ? [command] : []), ...args], {
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

test('real CLI help exposes comment commands and selector defaults', async () => {
  const result = await run(['--help']);
  expect(result.exitCode).toBe(0);
  for (const word of ['comments <artifact>', 'comment <artifact>', 'reply <thread-id>', 'resolve <thread-id>', 'reopen <thread-id>', 'activity <artifact>', 'viewport width 1280', '(0.5, 0.5)']) {
    expect(result.stdout).toContain(word);
  }
  const discovery = await run(['--help'], undefined, '');
  expect(discovery.exitCode).toBe(0);
  expect(discovery.stdout).toContain('publish, comments, reply, activity');
});

test('real CLI pins the Files history read and never posts a missing quote', async () => {
  const requests: Array<{ method: string; path: string; version: string | null }> = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname, version: url.searchParams.get('version') });
    if (url.pathname.endsWith('/versions')) return Response.json({ versions: [{ id: 'vc_pinned', number: 1, created_at: '2026-01-01T00:00:00Z' }] });
    if (url.pathname.endsWith('/content')) return new Response('The saved version has no matching words.');
    return Response.json({ error: 'Unexpected request' }, { status: 500 });
  } });
  try {
    const result = await run(['comment', aid, 'Review this.', '--quote', 'unavailable quote'], `http://127.0.0.1:${server.port}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('quote not found');
    expect(requests).toEqual([
      { method: 'GET', path: `/v1/projects/${pid}/artifacts/${aid}/versions`, version: null },
      { method: 'GET', path: `/v1/projects/${pid}/artifacts/${aid}/content`, version: 'vc_pinned' },
    ]);
  } finally {
    server.stop(true);
  }
});

test('real CLI rejects conflicting filters and nondecimal limits before API access', async () => {
  for (const args of [['comments', aid, '--all', '--resolved'], ['comment', aid, 'Review.', '--quote', 'x', '--selector', '#x'], ['activity', aid, '--limit', '1e3']]) {
    const result = await run(args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain('Unable to connect');
  }
});

test('real CLI replies through the thread lookup without scanning Artifacts', async () => {
  const tid = '33333333-3333-4333-8333-333333333333';
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === `/v1/projects/${pid}/artifact-comment-threads/${tid}`) return Response.json({ thread: { thread_id: tid, artifact_id: aid, comments: [] } });
    if (path === `/v1/projects/${pid}/artifacts/${aid}/comments/${tid}/replies`) return Response.json({ comment: { comment_id: 'reply-id', body: 'Confirmed.' } }, { status: 201 });
    return Response.json({ error: 'Unexpected request' }, { status: 500 });
  } });
  try {
    const result = await run(['reply', tid, 'Confirmed.', '--json'], `http://127.0.0.1:${server.port}`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ comment_id: 'reply-id', body: 'Confirmed.' });
    expect(requests).toEqual([
      `GET /v1/projects/${pid}/artifact-comment-threads/${tid}`,
      `POST /v1/projects/${pid}/artifacts/${aid}/comments/${tid}/replies`,
    ]);
  } finally {
    server.stop(true);
  }
});

test('real CLI retains the HTTP status and server reason for a denied SDK comment', async () => {
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/versions')) return Response.json({ versions: [{ id: 'vc_pinned', number: 1, created_at: '2026-01-01T00:00:00Z' }] });
    return Response.json({ error: 'You cannot comment on this Artifact', code: 'artifact_comment_forbidden' }, { status: 403 });
  } });
  try {
    const result = await run(['comment', aid, 'Not permitted.'], `http://127.0.0.1:${server.port}`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HTTP 403');
    expect(result.stderr).toContain('You cannot comment on this Artifact');
  } finally {
    server.stop(true);
  }
});

test('real CLI prints one HTTP status prefix for an SDK server error', async () => {
  const server = Bun.serve({ port: 0, fetch() {
    return Response.json({ error: 'Activity is unavailable' }, { status: 500 });
  } });
  try {
    const result = await run(['activity', aid], `http://127.0.0.1:${server.port}`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.match(/HTTP 500/g)).toHaveLength(1);
    expect(result.stderr).toContain('HTTP 500: Activity is unavailable');
  } finally {
    server.stop(true);
  }
});

test('real CLI distinguishes a failed handoff from the agent loop guard', async () => {
  const server = Bun.serve({ port: 0, fetch() {
    return Response.json({ threads: [
      { thread_id: 'loop', status: 'open', agent_state: 'paused', agent_error: null, comments: [] },
      { thread_id: 'failed', status: 'open', agent_state: 'paused', agent_error: 'Check access and send it again.', comments: [] },
    ] });
  } });
  try {
    const result = await run(['comments', aid], `http://127.0.0.1:${server.port}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('loop  open · Waiting for a person');
    expect(result.stdout).toContain('failed  open · Delivery failed: Check access and send it again.');
  } finally {
    server.stop(true);
  }
});
