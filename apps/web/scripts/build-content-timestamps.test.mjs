import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.deepEqual(timestampModule.staleContentTimestamps(committedManifest), []);
  });

  // A squash merge stamps one new committer date on the commit that carries
  // both the content and the manifest the PR regenerated, and the manifest
  // cannot know that date. The entry is excused only while content and manifest
  // share their last commit; content changed without the manifest still fails.
  it('tolerates the squash commit that carries the manifest, not content changed without it', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'content-timestamps-'));
    try {
      const git = (date, ...args) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
          cwd: repo,
          env: { ...process.env, GIT_COMMITTER_DATE: date },
        });
      const scriptsDir = join(repo, 'apps/web/scripts');
      const docsDir = join(repo, 'apps/web/content/docs');
      const manifestPath = join(repo, 'apps/web/src/lib/seo/content-timestamps.json');
      for (const dir of [scriptsDir, docsDir, join(repo, 'apps/web/src/lib/seo')]) mkdirSync(dir, { recursive: true });
      copyFileSync(scriptUrl, join(scriptsDir, 'build-content-timestamps.mjs'));
      const fixture = await import(`${join(scriptsDir, 'build-content-timestamps.mjs')}?test=${Date.now()}`);
      const stale = () => fixture.staleContentTimestamps(JSON.parse(readFileSync(manifestPath, 'utf8')));

      git('2026-01-01T00:00:00Z', 'init', '-q');
      // The squash commit: content plus a manifest holding the branch-side date.
      writeFileSync(join(docsDir, 'a.mdx'), 'one\n');
      writeFileSync(manifestPath, `${JSON.stringify({ 'docs:a': '2026-01-01T00:00:00.000Z' })}\n`);
      git('2026-01-02T00:00:00Z', 'add', '-A');
      git('2026-01-02T00:00:00Z', 'commit', '-qm', 'squash');
      assert.notDeepEqual(fixture.createContentTimestampManifest(), JSON.parse(readFileSync(manifestPath, 'utf8')));
      assert.deepEqual(stale(), []);

      // Content changes alone: the manifest is stale.
      writeFileSync(join(docsDir, 'a.mdx'), 'two\n');
      git('2026-01-03T00:00:00Z', 'commit', '-qam', 'content only');
      assert.deepEqual(stale(), ['docs:a']);

      // The regenerated manifest lands in its own commit: the exact check passes.
      fixture.refreshContentTimestamps();
      git('2026-01-04T00:00:00Z', 'commit', '-qam', 'regenerate');
      assert.deepEqual(stale(), []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
