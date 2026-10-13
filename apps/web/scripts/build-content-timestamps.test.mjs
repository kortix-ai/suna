import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const manifestUrl = new URL('../src/lib/seo/content-timestamps.json', import.meta.url);
const scriptUrl = new URL('./build-content-timestamps.mjs', import.meta.url);

describe('content timestamp manifest', () => {
  it('imports without writing', async () => {
    const beforeImport = await readFile(manifestUrl, 'utf8');
    const timestampModule = await import(`${scriptUrl.href}?test=import-without-writing`);
    const afterImport = await readFile(manifestUrl, 'utf8');

    assert.equal(afterImport, beforeImport);
    assert.equal(typeof timestampModule.createContentTimestampManifest, 'function');
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
});
