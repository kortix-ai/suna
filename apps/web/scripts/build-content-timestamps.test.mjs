import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const manifestUrl = new URL('../src/lib/seo/content-timestamps.json', import.meta.url);
const scriptUrl = new URL('./build-content-timestamps.mjs', import.meta.url);

describe('content timestamp manifest', () => {
  it('imports without writing', async () => {
    const beforeImport = await readFile(manifestUrl, 'utf8');
    await import(`${scriptUrl.href}?test=import-without-writing`);
    const afterImport = await readFile(manifestUrl, 'utf8');

    assert.equal(afterImport, beforeImport);
  });

  // Tree content only: the same result on dev, staging and every promotion
  // branch. The dates themselves come from git history, which a squash merge
  // rewrites, so they are not compared here.
  it('lists exactly the content sources on disk, each with an ISO instant', async () => {
    const timestampModule = await import(`${scriptUrl.href}?test=matches-tree`);
    const committedManifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
    assert.deepEqual(timestampModule.invalidContentTimestamps(committedManifest), []);
  });

  it('flags a missing source, an orphan entry and a malformed date', async () => {
    const timestampModule = await import(`${scriptUrl.href}?test=flags-drift`);
    const committed = JSON.parse(await readFile(manifestUrl, 'utf8'));
    const [first, second] = Object.keys(committed);
    const { [first]: _removed, ...rest } = committed;
    const broken = { ...rest, [second]: 'yesterday', 'docs:no-such-page': '2026-01-01T00:00:00.000Z' };
    assert.deepEqual(timestampModule.invalidContentTimestamps(broken), [first, 'docs:no-such-page', second].sort());
  });

  // --strict (the staged-artifact refresh) and the build-time refresh that
  // next.config.ts calls share one writer; both must write the same bytes for
  // the same tree. Restores the committed manifest afterwards.
  it('--strict writes the same manifest bytes as the build-time refresh', async () => {
    const committed = await readFile(manifestUrl, 'utf8');
    try {
      execFileSync(process.execPath, [fileURLToPath(scriptUrl), '--strict'], { stdio: 'pipe' });
      const strictBytes = await readFile(manifestUrl, 'utf8');

      await writeFile(manifestUrl, '{}\n');
      const timestampModule = await import(`${scriptUrl.href}?test=same-bytes`);
      const refreshed = timestampModule.refreshContentTimestamps();
      const refreshBytes = await readFile(manifestUrl, 'utf8');

      assert.ok(Object.keys(refreshed).length > 0);
      assert.equal(refreshBytes, `${JSON.stringify(refreshed, null, 2)}\n`);
      assert.equal(strictBytes, refreshBytes);
    } finally {
      await writeFile(manifestUrl, committed);
    }
  });
});
