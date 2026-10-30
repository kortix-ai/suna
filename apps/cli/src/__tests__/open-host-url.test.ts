import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('open commands ignore frontend environment from a different API deployment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kortix-open-host-'));
  const projectId = '00000000-0000-4000-8000-000000000001';
  const sessionId = '00000000-0000-4000-8000-000000000002';
  const paths: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === `/v1/projects/${projectId}`) return Response.json({ project_id: projectId });
    if (path === `/v1/projects/${projectId}/sessions/${sessionId}`) {
      return Response.json({ session_id: sessionId, project_id: projectId });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  } });
  try {
    const config = join(root, 'config.json');
    writeFileSync(config, JSON.stringify({ active: 'selected', hosts: { selected: {
      url: `http://127.0.0.1:${server.port}`, token: 'synthetic-token',
      user_id: '', user_email: '', account_id: '', logged_in_at: '',
    } } }));
    for (const args of [
      ['projects', 'open', projectId],
      ['sessions', 'open', sessionId, '--project', projectId],
    ]) {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), ...args, '--host', 'selected'], {
        cwd: root, stdout: 'pipe', stderr: 'pipe', env: {
          ...process.env, KORTIX_CONFIG_FILE: config, KORTIX_NO_UPDATE_CHECK: '1',
          KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_API_URL: 'https://api.kortix.com',
          KORTIX_FRONTEND_URL: 'https://kortix.com', KORTIX_DASHBOARD_URL: 'https://kortix.com',
          KORTIX_TOKEN: '', KORTIX_PROJECT_ID: '', NO_COLOR: '1',
        },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stderr).toContain('host selected');
      expect(stdout).toContain(`Opening http://127.0.0.1:3000/projects/${projectId}${args[0] === 'sessions' ? `/sessions/${sessionId}` : ''}`);
    }
    expect(paths).toContain(`/v1/projects/${projectId}`);
    expect(paths).toContain(`/v1/projects/${projectId}/sessions/${sessionId}`);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
