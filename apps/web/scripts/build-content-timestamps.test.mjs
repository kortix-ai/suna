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

  // Walks the git history of every content file: up to ~6 s while `pnpm test`
  // runs every lane at once, over bun's 5 s default.
  it('matches the current git history when full history is available', { timeout: 30_000 }, async () => {
    const timestampModule = await import(`${scriptUrl.href}?test=matches-git-history`);
    const generatedManifest = timestampModule.createContentTimestampManifest();
    if (Object.keys(generatedManifest).length === 0) return;

    const committedManifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
    assert.ok(Object.values(generatedManifest).every((value) => value.endsWith('Z')));
    assert.deepEqual(committedManifest, generatedManifest);
  });
});
