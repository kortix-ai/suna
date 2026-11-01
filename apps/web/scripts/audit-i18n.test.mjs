import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test(
  'the strict i18n audit accepts the complete source and locale catalogs',
  { timeout: 60_000 },
  () => {
    const result = spawnSync(process.execPath, ['scripts/audit-i18n.mjs', '--max-hardcoded=0'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /sr: \d+ leaf keys, 0 missing, 0 extra, 0 invalid/);
    assert.match(result.stdout, /findings: 0/);
    // Machine-read values (SVG transforms, class lists, emails, …) never differ
    // from English and never come from a translation call.
    assert.match(result.stdout, /locale mismatches: 0/);
    assert.match(result.stdout, /translated non-linguistic bindings: 0/);
  },
);

// Catalog parity cannot detect a namespace missing from every locale.
test('desktop control translations exist in every supported locale', () => {
  const keys = ['title', 'openTab', 'offline', 'start', 'retry', 'takeOver',
    'userControl', 'agentControl', 'returnControl', 'escape'];
  for (const locale of ['en', 'de', 'es', 'fr', 'it', 'ja', 'pt', 'sr', 'zh']) {
    const catalog = JSON.parse(readFileSync(`translations/${locale}.json`, 'utf8'));
    for (const key of keys) {
      assert.equal(typeof catalog.sessionDesktop?.[key], 'string', `${locale}: ${key}`);
      assert.ok(catalog.sessionDesktop[key].trim().length > 0, `${locale}: empty ${key}`);
    }
  }
});

// Catalog releases must remain valid independently of unrelated source-copy findings.
test('every release locale has complete, valid translations', { timeout: 60_000 }, () => {
  const result = spawnSync(process.execPath, ['scripts/audit-i18n.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  for (const locale of ['de', 'it', 'zh', 'ja', 'pt', 'fr', 'es', 'sr']) {
    assert.match(result.stdout, new RegExp(`${locale}: \\d+ leaf keys, 0 missing, 0 extra, 0 invalid`));
  }
});
