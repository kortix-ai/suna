import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { REPO_ROOT as root, readWorkflow } from '../src/fixtures/repo';

const script = resolve(root, 'scripts/ci/deploy-dev-changes.sh');

/**
 * Deploy Dev `surface=changed` diffs each surface against the commit THAT
 * surface serves. Before 2026-11-06 every surface diffed against the API's
 * /health commit, so a web roll that failed while the API rolled was never
 * retried until a later commit touched the frontend paths again.
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-dev-changes-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'dev');
  const commit = (path: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${Math.random()}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', path);
    return git('rev-parse', 'HEAD').stdout.trim();
  };
  const run = (env: Record<string, string>) =>
    spawnSync('bash', [script], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  return { commit, run };
}

const FILTERS = `api:
  - 'apps/api/**'
  - 'VERSION'   # baked into the image
frontend:
  - 'apps/web/**'
  - 'VERSION'
`;

const parse = (stdout: string) => Object.fromEntries(stdout.trim().split('\n').map((l) => l.split('=')));

describe('deploy-dev-changes.sh', () => {
  it('rebuilds the web after a failed web roll even when the API already serves the newer commit', () => {
    const { commit, run } = repo();
    const old = commit('README.md');
    commit('apps/web/page.tsx'); // run N: the API rolled, the web roll failed
    const api = commit('apps/api/route.ts');
    commit('notes.md'); // run N+1 head touches neither surface
    const r = run({ FILTERS, BASE_API: api, BASE_FRONTEND: old });
    expect(r.status).toBe(0);
    expect(parse(r.stdout)).toEqual({ api: 'false', frontend: 'true' });
  });

  it('skips a surface with no change since the commit it serves', () => {
    const { commit, run } = repo();
    commit('apps/web/page.tsx');
    const served = commit('apps/api/route.ts');
    commit('notes.md');
    expect(parse(run({ FILTERS, BASE_API: served, BASE_FRONTEND: served }).stdout)).toEqual({
      api: 'false',
      frontend: 'false',
    });
  });

  it('builds a surface whose served commit is unknown or not in history (fail-safe)', () => {
    const { commit, run } = repo();
    const served = commit('notes.md');
    const r = run({ FILTERS, BASE_API: 'unknown', BASE_FRONTEND: 'f'.repeat(40) });
    expect(parse(r.stdout)).toEqual({ api: 'true', frontend: 'true' });
    expect(r.stderr).toContain('fail-safe');
    expect(parse(run({ FILTERS, BASE_API: '', BASE_FRONTEND: served }).stdout)).toEqual({
      api: 'true',
      frontend: 'false',
    });
  });

  it('parses the real deploy-dev.yml filters: every surface, every glob', () => {
    const workflow = readWorkflow('deploy-dev.yml');
    const start = workflow.indexOf('          FILTERS: |\n') + '          FILTERS: |\n'.length;
    const end = workflow.indexOf('        run: |', start);
    const filters = workflow.slice(start, end);
    const { commit, run } = repo();
    commit('notes.md');
    const r = run({ FILTERS: filters });
    expect(r.stderr).not.toContain('cannot parse');
    expect(r.status).toBe(0);
    expect(Object.keys(parse(r.stdout))).toEqual(['api', 'gateway', 'frontend', 'cli', 'apps_router', 'terraform']);
    // The script decides what builds, so a change to it rebuilds the surfaces
    // it decides for.
    expect(filters.match(/scripts\/ci\/deploy-dev-changes\.sh/g)?.length).toBe(5);
  });

  it('refuses empty filters', () => {
    const { run } = repo();
    expect(run({ FILTERS: '' }).status).toBe(2);
  });
});
