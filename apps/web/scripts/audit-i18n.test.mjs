import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('the strict i18n audit accepts the complete source and locale catalogs', { timeout: 60_000 }, () => {
  const result = spawnSync(process.execPath, ['scripts/audit-i18n.mjs', '--max-hardcoded=0'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /sr: \d+ leaf keys, 0 missing, 0 extra, 0 invalid/);
  assert.match(result.stdout, /findings: 0/);
});
