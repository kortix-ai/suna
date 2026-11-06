import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  // the same tree. Runs in a full-history fixture repo, never the checkout:
  // CI checks out shallow, and the committed manifest stays untouched.
  it('--strict writes the same manifest bytes as the build-time refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'content-timestamps-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      const write = (rel, content) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), content);
      };
      git('init', '-q');
      git('config', 'user.name', 'Synthetic');
      git('config', 'user.email', 'agent@kortix.ai');
      git('config', 'core.hooksPath', '/dev/null');
      write('apps/web/scripts/build-content-timestamps.mjs', await readFile(scriptUrl, 'utf8'));
      write('apps/web/content/docs/getting-started.mdx', '# Getting started\n');
      write('apps/web/content/docs/guides/agents.mdx', '# Agents\n');
      write('apps/web/src/app/[locale]/(public)/(marketing)/pricing/page.tsx', 'export default null;\n');
      git('add', '.');
      git('commit', '-qm', 'fixture');

      const fixtureScript = join(dir, 'apps/web/scripts/build-content-timestamps.mjs');
      const fixtureManifest = join(dir, 'apps/web/src/lib/seo/content-timestamps.json');
      execFileSync(process.execPath, [fixtureScript, '--strict'], { cwd: dir, stdio: 'pipe' });
      const strictBytes = readFileSync(fixtureManifest, 'utf8');

      rmSync(dirname(fixtureManifest), { recursive: true });
      const fixtureModule = await import(pathToFileURL(fixtureScript).href);
      const refreshed = fixtureModule.refreshContentTimestamps();
      const refreshBytes = readFileSync(fixtureManifest, 'utf8');

      assert.equal(Object.keys(refreshed).length, 3);
      assert.equal(refreshBytes, `${JSON.stringify(refreshed, null, 2)}\n`);
      assert.equal(strictBytes, refreshBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
