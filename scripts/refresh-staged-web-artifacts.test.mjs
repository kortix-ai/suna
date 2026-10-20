import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const timestamps = 'apps/web/src/lib/seo/content-timestamps.json';
const audit = 'apps/web/src/components/iam/audit-http-routes.generated.ts';

test('staged web artifacts: regenerate, stage, refuse partial inputs and preserve unrelated work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-artifacts-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (path, value) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), value);
  };
  const run = () => spawnSync('sh', [join(root, 'scripts/refresh-staged-web-artifacts.sh')], { cwd: dir, encoding: 'utf8' });
  const routes = (path) => JSON.stringify({ count: 1, routes: [{ method: 'GET', path }] });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Synthetic');
    git('config', 'user.email', 'agent@kortix.ai');
    git('config', 'core.hooksPath', '/dev/null');
    git('config', 'core.attributesfile', '/dev/null');
    for (const script of ['build-content-timestamps.mjs', 'generate-audit-http-routes.mjs']) {
      write(`apps/web/scripts/${script}`, '');
      copyFileSync(join(root, 'apps/web/scripts', script), join(dir, 'apps/web/scripts', script));
    }
    symlinkSync(join(root, 'apps/web/node_modules'), join(dir, 'apps/web/node_modules'), 'dir');
    write('apps/web/content/docs/old.mdx', '# Old');
    write('tests/spec/routes.generated.json', routes('/v1/old'));
    write(timestamps, '{}\n');
    write(audit, '// stale\n');
    write('unrelated.txt', 'original');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    write('unrelated.txt', 'unstaged');
    assert.equal(run().status, 0);
    assert.equal(readFileSync(join(dir, audit), 'utf8'), '// stale\n');

    git('rm', '-q', 'apps/web/content/docs/old.mdx');
    write('apps/web/content/docs/new page.mdx', '# New');
    write('tests/spec/routes.generated.json', routes('/v1/new'));
    git('add', 'apps/web/content', 'tests/spec/routes.generated.json');
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(git('show', `:${timestamps}`));
    assert.deepEqual(Object.keys(manifest), ['docs:new page']);
    assert.ok(!Number.isNaN(Date.parse(manifest['docs:new page'])));
    assert.match(git('show', `:${audit}`), /GET\|v1\|new/);
    assert.equal(git('show', ':unrelated.txt'), 'original');
    const first = git('diff', '--cached');
    assert.equal(run().status, 0);
    assert.equal(git('diff', '--cached'), first);

    write('apps/web/content/docs/new page.mdx', '# Unstaged version');
    const refused = run();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /unstaged/);
    assert.equal(git('diff', '--cached'), first);
    git('restore', 'apps/web/content/docs/new page.mdx');
    write(audit, '// hand edit\n');
    assert.notEqual(run().status, 0);
    assert.equal(readFileSync(join(dir, audit), 'utf8'), '// hand edit\n');
    git('restore', audit);

    // Strict timestamp generation must not treat an unwritable output as success.
    rmSync(join(dir, timestamps));
    mkdirSync(join(dir, timestamps));
    const strictFailure = spawnSync('node', ['apps/web/scripts/build-content-timestamps.mjs', '--strict'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(strictFailure.status, 0);
    assert.match(strictFailure.stderr, /EISDIR/);
    assert.equal(git('diff', '--cached'), first);
    rmSync(join(dir, timestamps), { recursive: true });
    git('restore', timestamps);

    write('tests/spec/routes.generated.json', '{bad json');
    git('add', 'tests/spec/routes.generated.json');
    const beforeFailure = git('diff', '--cached');
    assert.notEqual(run().status, 0);
    assert.equal(git('diff', '--cached'), beforeFailure);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
