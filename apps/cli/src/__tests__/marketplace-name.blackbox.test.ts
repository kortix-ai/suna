import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const scenario of ['name', 'suffix', 'single', 'filtered', 'id', 'unknown', 'ambiguous', 'duplicate']) {
  test(`show and install resolve the same catalog item: ${scenario}`, async () => {
    const item = { id: 'starter:pdf', name: 'pdf', title: 'PDF', type: 'registry:skill', categories: [], dependencies: [], files: [{ target: '@skills/pdf/SKILL.md' }] };
    const raw = scenario === 'id' ? item.id : scenario === 'single' ? 'document' : 'pdf';
    const installed: unknown[] = [];
    const searches: URL[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/marketplace/items')) {
        searches.push(url);
        const items = scenario === 'duplicate' ? [item, { ...item, id: 'other:pdf' }] : scenario === 'unknown' ? [] : scenario === 'ambiguous'
          ? [{ ...item, id: 'first:one', name: 'one' }, { ...item, id: 'second:two', name: 'two' }]
          : [{ ...item, name: scenario === 'suffix' ? 'different' : item.name }];
        return Response.json({ items });
      }
      if (url.pathname.endsWith(`/marketplace/items/${encodeURIComponent(item.id)}`)) return Response.json(item);
      if (url.pathname.includes('/marketplace/items/')) return Response.json({ error: 'Unknown item' }, { status: 404 });
      if (url.pathname.endsWith('/install-session')) {
        installed.push(await req.json());
        return Response.json({ session_id: 'install-test' });
      }
      if (url.pathname.endsWith('/turn')) return Response.json({ turns: [], last_ended: { turn_token: 'turn-test', end_reason: 'completed' } });
      if (url.pathname.endsWith('/prompts')) return Response.json({ prompts: [] });
      if (url.pathname.endsWith('/detail')) return Response.json({ config: { skills: [{ name: 'pdf' }] } });
      if (url.pathname.endsWith('/files')) return Response.json([{ path: 'skills/pdf/SKILL.md', type: 'file' }]);
      return Response.json({ status: 'running' });
    } });
    const dir = mkdtempSync(join(tmpdir(), 'marketplace-name-'));
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ active: 'test', hosts: { test: { url: `http://127.0.0.1:${server.port}`, token: 'synthetic', account_id: 'account-test' } } }));
    const env: Record<string, string | undefined> = { ...process.env, HOME: dir, KORTIX_CONFIG_FILE: config, KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1' };
    for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_CLI_TOKEN', 'KORTIX_PROJECT_ID', 'BASH_ENV']) delete env[key];
    try {
      for (const command of ['show', 'install']) {
        const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), 'marketplace', command, raw, '--project', 'project-test', '--json', '--timeout', '2', ...(scenario === 'filtered' ? ['--source', 'starter', '--type', 'skill'] : [])], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const missing = ['unknown', 'ambiguous'].includes(scenario);
        expect(code).toBe(scenario === 'duplicate' ? 2 : missing ? 1 : 0);
        if (scenario === 'duplicate') expect(stderr).toContain('Pass the full id');
        else if (missing) expect(stderr).toContain(`No marketplace item matches "${raw}"`);
        else expect(JSON.parse(stdout)).toMatchObject(command === 'show' ? { id: item.id } : { item_id: item.id, outcome: 'installed' });
      }
      expect(installed).toEqual(['unknown', 'ambiguous', 'duplicate'].includes(scenario) ? [] : [{ id: item.id }]);
      if (scenario === 'filtered') {
        expect(searches).toHaveLength(2);
        for (const url of searches) {
          expect(url.searchParams.get('source')).toBe('starter');
          expect(url.searchParams.get('type')).toBe('skill');
        }
      }
    } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  });
}
