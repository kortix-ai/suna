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
    for (const script of [
      'build-content-timestamps.mjs',
      'generate-audit-http-routes.mjs',
      // generate-audit-http-routes.mjs imports repositoryRoot + runFileGenerator from here.
      'docs-generated-region.mjs',
    ]) {
      write(`apps/web/scripts/${script}`, '');
      copyFileSync(join(root, 'apps/web/scripts', script), join(dir, 'apps/web/scripts', script));
    }
    symlinkSync(join(root, 'apps/web/node_modules'), join(dir, 'apps/web/node_modules'), 'dir');
    // docs-generated-region.mjs reads the feature-flag registry at module load.
    write('apps/api/src/feature-flags/registry.ts', '');
    copyFileSync(
      join(root, 'apps/api/src/feature-flags/registry.ts'),
      join(dir, 'apps/api/src/feature-flags/registry.ts'),
    );
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

test('staged web artifacts: regenerate the kortix.yaml reference region from staged schema inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-artifacts-kortix-doc-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (path, value) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), value);
  };
  const run = (env = process.env) =>
    spawnSync('sh', [join(root, 'scripts/refresh-staged-web-artifacts.sh')], {
      cwd: dir,
      encoding: 'utf8',
      env,
    });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Synthetic');
    git('config', 'user.email', 'agent@kortix.ai');
    git('config', 'core.hooksPath', '/dev/null');
    for (const script of ['generate-kortix-yaml-doc.mjs', 'docs-generated-region.mjs']) {
      write(`apps/web/scripts/${script}`, '');
      copyFileSync(join(root, 'apps/web/scripts', script), join(dir, 'apps/web/scripts', script));
    }
    copyFileSync(join(root, 'apps/web/scripts/build-content-timestamps.mjs'), join(dir, 'apps/web/scripts/build-content-timestamps.mjs'));
    symlinkSync(join(root, 'apps/web/node_modules'), join(dir, 'apps/web/node_modules'), 'dir');
    write('apps/api/src/feature-flags/registry.ts', '');
    copyFileSync(
      join(root, 'apps/api/src/feature-flags/registry.ts'),
      join(dir, 'apps/api/src/feature-flags/registry.ts'),
    );
    mkdirSync(join(dir, 'apps/web/public/schema'), { recursive: true });
    for (const schemaFile of ['kortix.schema.json', 'kortix.v3.schema.json']) {
      copyFileSync(
        join(root, 'apps/web/public/schema', schemaFile),
        join(dir, 'apps/web/public/schema', schemaFile),
      );
    }
    write(
      'apps/web/content/docs/developers.mdx',
      "# Developers\n\n{/* generated:kortix-yaml:start */}\n\nstale\n\n{/* generated:kortix-yaml:end */}\n",
    );
    execFileSync('bun', ['apps/web/scripts/generate-kortix-yaml-doc.mjs'], {
      cwd: dir,
      stdio: 'pipe',
    });
    git('add', '.');
    git('commit', '-qm', 'fixture');
    // The repo commits the content-timestamps manifest alongside the pages.
    // The manifest's value is the commit date of the fixture commit (the only
    // commit touching the page), deterministic from here on.
    execFileSync('node', ['apps/web/scripts/build-content-timestamps.mjs', '--strict'], { cwd: dir, stdio: 'pipe' });
    git('add', 'apps/web/src/lib/seo/content-timestamps.json');
    git('commit', '-qm', 'timestamps');

    // A published-schema change staged without the regenerated region: the
    // commit must carry the fresh region (the KRTX-3954 shape, where the
    // region went stale one schema change earlier).
    const schemaPath = join(dir, 'apps/web/public/schema/kortix.schema.json');
    const schema = readFileSync(schemaPath, 'utf8');
    const overlap = 'while the previous prompt still waits in that session.';
    assert.ok(schema.includes(overlap), 'fixture schema expected to carry the overlap description');
    writeFileSync(schemaPath, schema.replace(overlap, 'while the previous prompt waits in the session queue.'));
    git('add', 'apps/web/public/schema/kortix.schema.json');
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const stagedDoc = git('show', ':apps/web/content/docs/developers.mdx');
    assert.match(stagedDoc, /waits in the session queue/);
    assert.doesNotMatch(stagedDoc, /waits in that session/);

    // Idempotent: a second run changes nothing.
    const first = git('diff', '--cached');
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(git('diff', '--cached'), first);

    // An unstaged hand edit of the page is refused, never overwritten.
    const stagedPage = git('show', ':apps/web/content/docs/developers.mdx');
    write('apps/web/content/docs/developers.mdx', `${stagedPage}\n<!-- hand edit -->`);
    const refused = run();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /unstaged/);
    assert.match(readFileSync(join(dir, 'apps/web/content/docs/developers.mdx'), 'utf8'), /hand edit/);
    writeFileSync(join(dir, 'apps/web/content/docs/developers.mdx'), stagedPage);

    // The generator needs bun (it shares the region helper that reads the
    // flag registry .ts). Without it the commit is refused with the
    // regenerate command, never a silent stale doc.
    const stubBin = join(dir, 'stub-bin');
    mkdirSync(stubBin);
    for (const tool of ['git', 'grep', 'node', 'sh']) {
      symlinkSync(
        execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(),
        join(stubBin, tool),
      );
    }
    const noBun = run({ ...process.env, PATH: stubBin });
    assert.notEqual(noBun.status, 0);
    assert.match(noBun.stderr, /generate-kortix-yaml-doc\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('staged web artifacts: regenerate the learnings index from staged ledger entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-artifacts-learnings-'));
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
  let n = 0;
  const entry = (slug) => {
    n += 1;
    const stamp = `2026-01-0${n}T0${n}0000Z-${slug}.md`;
    write(
      `.agents/skills/learnings/entries/${stamp}`,
      `---\nrecorded: 2026-01-0${n}T00:00:00Z\nincident_date: 2026-01-0${n}\n---\n# Fixture entry ${slug}\n\n**Rule:** Run the synthetic command.\n`,
    );
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Synthetic');
    git('config', 'user.email', 'agent@kortix.ai');
    git('config', 'core.hooksPath', '/dev/null');
    const indexScript = '.agents/skills/learnings/scripts/index.sh';
    mkdirSync(join(dir, '.agents/skills/learnings/scripts'), { recursive: true });
    copyFileSync(join(root, indexScript), join(dir, indexScript));
    entry('first');
    git('add', '.');

    // Staging an entry without its index line: the commit carries the
    // regenerated MEMORY.md (the KRTX-3954 shape, five entries one index).
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const memory = git('show', ':.agents/skills/learnings/MEMORY.md');
    assert.match(memory, /Fixture entry first/);
    git('add', '.');
    git('commit', '-qm', 'fixture');

    entry('second');
    git('add', '.agents/skills/learnings/entries');
    assert.equal(run().status, 0);
    assert.match(git('show', ':.agents/skills/learnings/MEMORY.md'), /Fixture entry second/);
    git('add', '.agents/skills/learnings/MEMORY.md');

    // An unstaged or untracked entry would make the committed index list a
    // line the committed entries cannot generate. Refused, never a silent
    // stale or unreadable ledger.
    const stagedMemory = git('show', ':.agents/skills/learnings/MEMORY.md');
    entry('third');
    const refused = run();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /unstaged/);
    assert.equal(git('show', ':.agents/skills/learnings/MEMORY.md'), stagedMemory);

    // An entry without a # title fails the index build with the file named.
    write(
      '.agents/skills/learnings/entries/2026-01-09T000900Z-untitled.md',
      '---\nrecorded: 2026-01-09T00:00:00Z\n---\nno title line\n',
    );
    git('add', '.agents/skills/learnings/entries');
    const noTitle = run();
    assert.notEqual(noTitle.status, 0);
    assert.match(noTitle.stderr, /no # title line/);
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
    for (const shared of [
      'audit-labels.ts',
      'audit-route-labels.ts',
      'audit-event-labels.ts',
      // audit-labels.ts renames legacy route keys to their workspace name.
      'workspace-routes.ts',
    ]) {
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
    // The doc names each action's canonical /v1/workspaces route from the manifest.
    write('tests/spec/routes.generated.json', '');
    copyFileSync(join(root, 'tests/spec/routes.generated.json'), join(dir, 'tests/spec/routes.generated.json'));
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
