import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const timestamps = 'apps/web/src/lib/seo/content-timestamps.json';
const audit = 'apps/web/src/components/iam/audit-http-routes.generated.ts';
const auditDoc = 'apps/web/content/docs/audit-actions.mdx';

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

test('staged web artifacts: regenerate the audit-actions doc from staged audit label inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-artifacts-audit-doc-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (path, value) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), value);
  };
  const run = () =>
    spawnSync('sh', [join(root, 'scripts/refresh-staged-web-artifacts.sh')], {
      cwd: dir,
      encoding: 'utf8',
    });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Synthetic');
    git('config', 'user.email', 'agent@kortix.ai');
    git('config', 'core.hooksPath', '/dev/null');
    git('config', 'core.attributesfile', '/dev/null');
    for (const script of [
      'generate-audit-actions-doc.mjs',
      'docs-generated-region.mjs',
      'build-content-timestamps.mjs',
    ]) {
      write(`apps/web/scripts/${script}`, '');
      copyFileSync(join(root, 'apps/web/scripts', script), join(dir, 'apps/web/scripts', script));
    }
    for (const shared of ['audit-labels.ts', 'audit-route-labels.ts', 'audit-event-labels.ts']) {
      write(`packages/shared/src/${shared}`, '');
      copyFileSync(
        join(root, 'packages/shared/src', shared),
        join(dir, 'packages/shared/src', shared),
      );
    }
    write('apps/api/src/feature-flags/registry.ts', '');
    copyFileSync(
      join(root, 'apps/api/src/feature-flags/registry.ts'),
      join(dir, 'apps/api/src/feature-flags/registry.ts'),
    );
    mkdirSync(join(dir, 'apps/web/content/docs'), { recursive: true });
    execFileSync('bun', ['apps/web/scripts/generate-audit-actions-doc.mjs'], {
      cwd: dir,
      stdio: 'pipe',
    });
    git('add', '.');
    git('commit', '-qm', 'fixture');
    const committed = git('show', `HEAD:${auditDoc}`);

    // The #11283 shape (KRTX-3758): a labels change is staged, the committed
    // doc is now stale. The commit must carry the regenerated doc.
    const labels = 'packages/shared/src/audit-route-labels.ts';
    const catalog =
      'export const AUDIT_ROUTE_LABELS: Readonly<Record<string, AuditRouteLabel | string>> = {';
    write(
      labels,
      readFileSync(join(dir, labels), 'utf8').replace(
        catalog,
        `${catalog}\n  'POST /v1/fixture/routes': { action: 'fixture.route.create', title: 'Created fixture route' },`,
      ),
    );
    git('add', labels);

    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const stagedDoc = git('show', `:${auditDoc}`);
    assert.match(stagedDoc, /fixture\.route\.create/);
    assert.match(stagedDoc, /Created fixture route/);
    assert.notEqual(stagedDoc, committed);

    // An unstaged hand edit of the doc is refused, never overwritten.
    write(auditDoc, `${stagedDoc}\n<!-- hand edit -->`);
    const refused = run();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /unstaged/);
    assert.match(readFileSync(join(dir, auditDoc), 'utf8'), /hand edit/);
    write(auditDoc, stagedDoc);

    // The generator needs bun (it imports the .ts catalog). Without it the
    // commit is refused with the regenerate command, never a silent stale doc.
    const stubBin = join(dir, 'stub-bin');
    mkdirSync(stubBin);
    for (const tool of ['git', 'grep', 'node', 'sh']) {
      symlinkSync(
        execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(),
        join(stubBin, tool),
      );
    }
    const noBun = spawnSync('sh', [join(root, 'scripts/refresh-staged-web-artifacts.sh')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: stubBin },
    });
    assert.notEqual(noBun.status, 0);
    assert.match(noBun.stderr, /generate-audit-actions-doc\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
