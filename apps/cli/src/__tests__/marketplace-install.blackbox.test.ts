import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const scenario of ['failed-session', 'failed-turn', 'failed-prompt', 'approval', 'installed', 'files-only', 'large-repo', 'stopped-completed', 'stopped-failed', 'timeout', 'stalled', 'invalid']) {
  test(`install process: ${scenario}`, async () => {
    const calls: string[] = [];
    let polls = 0;
    const server = Bun.serve({ port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      calls.push(`${req.method} ${path}`);
      if (scenario === 'stalled' && path.endsWith('/turn')) return new Promise<Response>(() => {});
      let body: unknown = {};
      if (path.endsWith('/install-session')) body = { session_id: 'session-install' };
      else if (path.includes('/marketplace/items/')) body = { name: 'pdf', type: 'registry:skill', files: [{ target: '@skills/pdf/SKILL.md', type: 'registry:file' }] };
      else if (path.endsWith('/turn')) body = { turns: [], last_ended: scenario === 'timeout' || (scenario.startsWith('stopped-') && polls < 3) ? undefined : { turn_token: 'turn-install', end_reason: scenario === 'failed-turn' ? 'failed' : 'completed', error: { message: 'model rejected' } } };
      else if (path.endsWith('/prompts')) body = { prompts: scenario === 'failed-prompt' ? [{ prompt_id: 'prompt-install', state: 'failed', last_error: 'delivery rejected' }] : [] };
      else if (path.endsWith('/detail')) body = { config: { skills: scenario === 'files-only' ? [] : [{ name: 'pdf' }] } };
      else if (path.endsWith('/files') && scenario === 'large-repo') body = new URL(req.url).searchParams.get('path') === 'skills/pdf/SKILL.md' ? [{ path: 'skills/pdf/SKILL.md', type: 'file' }] : Array.from({ length: 1000 }, (_, i) => ({ path: `archive/${i}.md`, type: 'file' }));
      else if (path.endsWith('/files')) body = ['installed', 'files-only', 'stopped-completed'].includes(scenario) ? [{ path: 'skills/pdf/SKILL.md', type: 'file' }] : [];
      else {
        polls++;
        body = { status: scenario === 'failed-session' || (scenario === 'stopped-failed' && polls > 1) ? 'failed' : scenario.startsWith('stopped-') && polls === 1 ? 'stopped' : 'running', error: 'sandbox rejected' };
      }
      return Response.json(body);
    } });
    const dir = mkdtempSync(join(tmpdir(), 'marketplace-install-'));
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ active: 'test', hosts: { test: { url: `http://127.0.0.1:${server.port}`, token: 'synthetic', account_id: 'account-test' } } }));
    const env: Record<string, string | undefined> = { ...process.env, HOME: dir, KORTIX_CONFIG_FILE: config, KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1' };
    for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'BASH_ENV']) delete env[key];
    try {
      const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), 'marketplace', 'install', 'test:pdf', '--project', 'project-test', '--json', '--timeout', scenario === 'invalid' ? '0' : scenario.startsWith('stopped-') ? '4' : '1'], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(code).toBe(['installed', 'large-repo', 'stopped-completed'].includes(scenario) ? 0 : ['approval', 'files-only'].includes(scenario) ? 3 : ['timeout', 'stalled'].includes(scenario) ? 124 : scenario === 'invalid' ? 2 : 1);
      if (scenario === 'invalid') expect(calls).toHaveLength(0);
      else {
        expect(JSON.parse(stdout)).toMatchObject({ session_id: 'session-install', project_id: 'project-test', item_id: 'test:pdf' });
        if (!['installed', 'large-repo', 'stopped-completed'].includes(scenario)) expect(stderr).toContain(scenario === 'failed-turn' ? 'model rejected' : scenario === 'failed-prompt' ? 'delivery rejected' : ['failed-session', 'stopped-failed'].includes(scenario) ? 'sandbox rejected' : ['timeout', 'stalled'].includes(scenario) ? 'timed out' : 'approval');
        expect(calls.filter(c => !c.startsWith('GET') && !c.endsWith('/install-session'))).toEqual([]);
      }
    } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  });
}
