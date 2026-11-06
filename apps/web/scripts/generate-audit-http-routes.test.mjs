import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// generate-audit-http-routes.mjs gained --check (it had none, so a stale
// apps/web/src/components/iam/audit-http-routes.generated.ts could ship
// silently). This pins that --check exits 0 when current and non-zero when
// the committed output drifts from the route manifest.

const root = resolve(import.meta.dirname, '..', '..', '..');
const OUTPUT = 'apps/web/src/components/iam/audit-http-routes.generated.ts';

test('generate-audit-http-routes.mjs --check: 0 when current, non-zero when stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-http-routes-'));
  const write = (path, value) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), value);
  };
  const run = (...args) =>
    spawnSync('node', ['apps/web/scripts/generate-audit-http-routes.mjs', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  try {
    // generate-audit-http-routes.mjs imports docs-generated-region.mjs, which
    // reads the feature-flag registry at module load.
    for (const script of ['generate-audit-http-routes.mjs', 'docs-generated-region.mjs']) {
      write(`apps/web/scripts/${script}`, '');
      copyFileSync(join(root, 'apps/web/scripts', script), join(dir, 'apps/web/scripts', script));
    }
    write('apps/api/src/feature-flags/registry.ts', '');
    copyFileSync(
      join(root, 'apps/api/src/feature-flags/registry.ts'),
      join(dir, 'apps/api/src/feature-flags/registry.ts'),
    );
    symlinkSync(join(root, 'apps/web/node_modules'), join(dir, 'apps/web/node_modules'), 'dir');
    write('tests/spec/routes.generated.json', JSON.stringify({ count: 1, routes: [{ method: 'GET', path: '/v1/thing' }] }));
    mkdirSync(join(dir, 'apps/web/src/components/iam'), { recursive: true });

    // Write the artifact, then --check must pass against it.
    assert.equal(run().status, 0);
    assert.equal(run('--check').status, 0);

    // Drift the committed artifact: --check must fail and name it stale.
    writeFileSync(join(dir, OUTPUT), `${readFileSync(join(dir, OUTPUT), 'utf8')}// hand edit\n`);
    const stale = run('--check');
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
