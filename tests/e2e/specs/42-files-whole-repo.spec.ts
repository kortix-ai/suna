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
 * under `z/`: the root must list `z`, and a filename search must find
 * `z/last.txt` through the server.
 *
 * Local only: the files are pushed straight into the project's bare repository.
 */
test.describe('42 — Files lists the whole repository', () => {
  test('the root lists a folder past 1,000 files, and search finds a file in it', async ({ page }) => {
    test.skip(!databaseUrl || isDeployedTarget(), 'local stack only: pushes into a local bare repository');
    test.setTimeout(120_000);

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
      execFileSync('git', ['-C', work, 'add', '-A']);
      execFileSync('git', ['-C', work, 'commit', '-qm', '1,201 files']);
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
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === `/v1/projects/${projectId}/files`) listings.push(url.search);
        if (url.pathname === `/v1/projects/${projectId}/files/search`) searches.push(url.search);
      });

      await installBrowserSessionDirect(page, session, `/projects/${projectId}/files`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      // The root reads one folder level and shows the folder past file 1,000.
      await expect(page.getByText('z', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('README.md', { exact: true }).first()).toBeVisible();
      expect(listings.some((search) => new URLSearchParams(search).get('depth') === '1')).toBe(true);

      // View options → Find a file opens search; the query goes to the server.
      await page.getByRole('button', { name: 'View options' }).click();
      await page.getByRole('menuitem', { name: /Find a file/ }).click();
      const input = page.getByPlaceholder('Search files...');
      await expect(input).toBeVisible();
      await input.fill('last');
      const result = page.getByRole('button').filter({ hasText: 'z/last.txt' });
      await expect(result).toBeVisible({ timeout: 15_000 });
      expect(searches.some((search) => new URLSearchParams(search).get('q') === 'last')).toBe(true);
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
      await repository?.dispose();
      await deleteAuthUser(user.id, authOptions).catch(() => undefined);
    }
  });
});
