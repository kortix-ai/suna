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

  // Rule and reason: see the generator header. Each case runs on a temporary git repository.
  async function fixtureRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'content-timestamps-'));
    const scriptsDir = join(repo, 'apps/web/scripts');
    const docsDir = join(repo, 'apps/web/content/docs');
    const manifestPath = join(repo, 'apps/web/src/lib/seo/content-timestamps.json');
    for (const dir of [scriptsDir, docsDir, join(repo, 'apps/web/src/lib/seo')]) mkdirSync(dir, { recursive: true });
    copyFileSync(scriptUrl, join(scriptsDir, 'build-content-timestamps.mjs'));
    const fixture = await import(`${join(scriptsDir, 'build-content-timestamps.mjs')}?test=${repo}`);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    return {
      fixture,
      repo,
      stale: () => fixture.staleContentTimestamps(JSON.parse(readFileSync(manifestPath, 'utf8'))),
      // One commit: the docs files and manifest values given, stamped with `date`.
      commit(date, docs, manifest) {
        for (const [name, text] of Object.entries(docs)) writeFileSync(join(docsDir, name), text);
        if (manifest) writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
        const env = { ...process.env, GIT_COMMITTER_DATE: date };
        const args = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
        execFileSync('git', [...args, 'add', '-A'], { cwd: repo, env });
        execFileSync('git', [...args, 'commit', '-qm', 'c'], { cwd: repo, env });
      },
    };
  }

  it('tolerates the squash commit that carries the manifest, not content changed without it', { timeout: 30_000 }, async () => {
    const { fixture, repo, stale, commit } = await fixtureRepo();
    try {
      commit('2026-01-02T00:00:00Z', { 'a.mdx': 'one\n' }, { 'docs:a': '2026-01-01T00:00:00.000Z' });
      assert.notDeepEqual(fixture.createContentTimestampManifest(), { 'docs:a': '2026-01-01T00:00:00.000Z' });
      assert.deepEqual(stale(), []);

      // Content changes alone, with the squash commit's committer date: still stale.
      commit('2026-01-02T00:00:00Z', { 'a.mdx': 'two\n' });
      assert.deepEqual(stale(), ['docs:a']);

      // The regenerated manifest lands in its own commit: the exact check passes.
      fixture.refreshContentTimestamps();
      commit('2026-01-04T00:00:00Z', {});
      assert.deepEqual(stale(), []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('tolerates two pull requests that each regenerated the manifest and squashed in sequence', { timeout: 30_000 }, async () => {
    const { repo, stale, commit } = await fixtureRepo();
    try {
      // PR A changes a.mdx; PR B branched before A, regenerated the manifest on its side, and squashes after A.
      commit('2026-01-02T00:00:00Z', { 'a.mdx': 'A\n' }, { 'docs:a': '2026-01-01T00:00:00.000Z' });
      commit('2026-01-03T00:00:00Z', { 'b.mdx': 'B\n' }, { 'docs:a': '2026-01-01T00:00:00.000Z', 'docs:b': '2026-01-01T00:00:00.000Z' });
      assert.deepEqual(stale(), []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
