import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createLocalGitRepository, type LocalGitRepository } from '../../src/fixtures/local-git';

import { createApiJsonClient } from '../helpers/http';
import { isDeployedTarget } from '../helpers/manifest-project';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = 'E2eFilesWholeRepo123!';
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

/**
 * KRTX-1723: the Files page built its tree from a recursive list cut at 1,000
 * files, so a folder that sorted after file 1,000 was missing, and the page had
 * no search. The repository here holds 1,200 files under `a/` and one file
 * under `z/`: the root must list `z`; `a` shows 500 entries and "Load more
 * items" until all 1,200 are on screen, with sorting off until then; a
 * filename search must find `z/last.txt` through the server, a content search
 * must find its line, and a match on line 350 of `z/long.txt` must open the
 * file scrolled to that line, marked.
 *
 * Local only: the files are pushed straight into the project's bare repository.
 */
test.describe('42 — Files lists the whole repository', { tag: '@local-only' }, () => {
  test('the root lists a folder past 1,000 files, a big folder loads in pages, and search finds a file and a line', async ({ page }) => {
    test.skip(!databaseUrl || isDeployedTarget(), 'local stack only: pushes into a local bare repository');
    // A cold Next.js compile of the Files route, three pages of `a/`, then
    // filename and content search.
    test.setTimeout(240_000);

    const runId = Date.now().toString(36);
    const email = `e2e-files-whole-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let repository: LocalGitRepository | null = null;
    let projectId: string | null = null;

    try {
      const accounts = await api<{ account_id: string; personal_account?: boolean }[]>(
        session.access_token,
        'GET',
        '/accounts',
      );
      const accountId = (accounts.find((a) => a.personal_account) ?? accounts[0])?.account_id;
      if (!accountId) throw new Error('the seeded user owns no account');

      repository = await createLocalGitRepository(`Files whole repo ${runId}`);
      const work = join(repository.root, 'work');
      mkdirSync(join(work, 'a'));
      mkdirSync(join(work, 'z'));
      for (let i = 0; i < 1200; i++) writeFileSync(join(work, 'a', `f${String(i).padStart(4, '0')}.txt`), `${i}\n`);
      writeFileSync(join(work, 'z', 'last.txt'), 'last\n');
      // 400 lines with one match on line 350: opening it must scroll there.
      writeFileSync(
        join(work, 'z', 'long.txt'),
        `${Array.from({ length: 400 }, (_, i) => (i === 349 ? 'needle-350' : `row ${i + 1}`)).join('\n')}\n`,
      );
      execFileSync('git', ['-C', work, 'add', '-A']);
      execFileSync('git', ['-C', work, 'commit', '-qm', '1,202 files']);
      execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'main']);
      projectId = (
        await createDatabaseProject(env, {
          accountId,
          userId: user.id,
          name: `Files whole repo ${runId}`,
          repoUrl: repository.repoUrl,
        })
      ).id;

      const listings: string[] = [];
      const searches: string[] = [];
      const previews: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === `/v1/projects/${projectId}/files`) listings.push(url.search);
        if (url.pathname === `/v1/projects/${projectId}/files/search`) searches.push(url.search);
        if (url.pathname === `/v1/projects/${projectId}/files/raw`) previews.push(url.search);
      });

      await installBrowserSessionDirect(page, session, `/projects/${projectId}/files`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      // The root reads one folder level and shows the folder past file 1,000.
      await expect(page.getByText('z', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('README.md', { exact: true }).first()).toBeVisible();
      expect(listings.some((search) => new URLSearchParams(search).get('depth') === '1')).toBe(true);

      // `a` holds 1,200 files: the first page shows 500 of them and "Load more items".
      const folderA = () => listings.map((search) => new URLSearchParams(search)).filter((q) => q.get('path') === 'a');
      await page.getByText('a', { exact: true }).first().click();
      await expect(page.getByText('f0000.txt', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('f0499.txt', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('f0500.txt', { exact: true })).toHaveCount(0);
      const loadMore = page.getByRole('button', { name: 'Load more items' });
      await expect(loadMore).toBeVisible();
      // Only the cards near the viewport fetch a preview, not all 500 on the page.
      expect(previews.length).toBeLessThan(100);
      expect(folderA().some((q) => q.get('limit') === '500' && !q.has('cursor'))).toBe(true);
      // A partial folder keeps the server's name order: sorting waits for the last page.
      await expect(page.getByText('Showing 500 items. Sorting applies once every item is loaded.')).toBeVisible();
      const sortBy = async () => {
        await page.getByRole('button', { name: 'View options' }).click();
        const item = page.getByRole('menuitem', { name: /^Sort by/ });
        await expect(item).toBeVisible();
        return item;
      };
      await expect(await sortBy()).toBeDisabled();
      await page.keyboard.press('Escape');

      // Each click reads the next page by cursor: 500, then 200, then no button.
      await loadMore.click();
      await expect(page.getByText('f0999.txt', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('f1000.txt', { exact: true })).toHaveCount(0);
      await loadMore.click();
      await expect(page.getByText('f1199.txt', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
      await expect(loadMore).toHaveCount(0);
      await expect(await sortBy()).toBeEnabled();
      await page.keyboard.press('Escape');
      const pages = folderA().filter((q) => q.has('cursor'));
      expect(pages.length).toBeGreaterThanOrEqual(2);
      expect(pages.every((q) => q.get('limit') === '500')).toBe(true);

      // View options → Find a file opens search; the query goes to the server.
      await page.getByRole('button', { name: 'View options' }).click();
      await page.getByRole('menuitem', { name: /Find a file/ }).click();
      const input = page.getByPlaceholder('Search files...');
      await expect(input).toBeVisible();
      await input.fill('last');
      const result = page.getByRole('button').filter({ hasText: 'z/last.txt' });
      await expect(result).toBeVisible({ timeout: 15_000 });
      expect(searches.some((search) => new URLSearchParams(search).get('q') === 'last')).toBe(true);

      // Search contents: the same query finds the line in the file, with its number.
      await page.getByRole('switch', { name: 'Search contents' }).click();
      await expect(result).toContainText('z/last.txt1last', { timeout: 15_000 });
      expect(
        searches.some((search) => {
          const q = new URLSearchParams(search);
          return q.get('q') === 'last' && q.get('content') === '1';
        }),
      ).toBe(true);

      // A match on line 350 of 400 opens the file scrolled to that line, marked.
      const contentInput = page.getByPlaceholder('Search file contents...');
      await expect(contentInput).toBeVisible();
      await contentInput.fill('needle-350');
      const deep = page.getByRole('button').filter({ hasText: 'z/long.txt' });
      await expect(deep).toContainText('z/long.txt350needle-350', { timeout: 15_000 });
      await deep.click();
      const target = page.locator('.cm-line').filter({ hasText: 'needle-350' });
      await expect(target).toBeInViewport({ timeout: 15_000 });
      await expect(target).toHaveClass(/cm-target-line/);
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
      await repository?.dispose();
      await deleteAuthUser(user.id, authOptions).catch(() => undefined);
    }
  });
});
