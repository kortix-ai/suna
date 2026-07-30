/**
 * Real-DB proof for Task 3's r2.ts icon glue.
 *
 * r2.ts adds, at each of its three project-creation call sites (PAT-linked
 * import, GitHub-App-linked import, create-repo):
 *
 *   const icon = normalizeProjectIcon(body.icon);
 *   const row = await register{GitHub,Pat}LinkedProject({
 *     ...,
 *     ...(icon ? { projectMetadata: { icon } } : {}),
 *   });
 *
 * `registerLinkedProject` (this file's neighbor, project-registration.ts)
 * already spreads `projectMetadata` into the inserted row's metadata — Task 2
 * added that acceptance, no change needed here. This test proves the exact
 * expression above, unmodified, round-trips through the REAL
 * `registerGitHubLinkedProject` / `registerPatLinkedProject` and a real local
 * Postgres: a valid icon lands at `projects.metadata.icon`; an invalid or
 * absent one leaves the `icon` key out of metadata entirely (never
 * `metadata.icon: null` — see project-icon.ts's contract).
 *
 * `repo` / `installation` are plain data objects here, not fetched from
 * GitHub, so this needs no GitHub network access or credentials — the actual
 * r1.ts /provision path (managed git via code.storage) was verified over real
 * HTTP instead (see task-3-report.md); r2.ts's three routes need a real
 * GitHub App installation / PAT to drive end to end, which this environment
 * intentionally avoids exercising against a live GitHub org for an
 * automated task. This test is the safe substitute: it calls the same
 * production registration function real routes call, against a real DB.
 *
 * Gated on TEST_DATABASE_URL + explicit confirmation + non-prod — same
 * harness contract as trigger-execution-store.integration.test.ts and
 * e2e-stuck-session-reconcile.test.ts. Skipped otherwise.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, accounts, createDb, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import type { GitHubRepo } from '../github';
import { normalizeProjectIcon } from './project-icon';
import { registerGitHubLinkedProject, registerPatLinkedProject } from './project-registration';

const TEST_DB_CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === TEST_DB_CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-000000009901';
const USER_ID = '00000000-0000-4000-a000-000000009902';

let testDb: Database | null = null;
function db(): Database {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  if (!testDb) testDb = createDb(process.env.TEST_DATABASE_URL, { max: 1 });
  return testDb;
}

async function cleanup() {
  const d = db();
  await d.delete(projects).where(eq(projects.accountId, ACCOUNT_ID));
  await d.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

function fakeRepo(name: string): GitHubRepo {
  return {
    id: Math.floor(Math.random() * 1_000_000_000),
    name,
    full_name: `acme/${name}`,
    private: true,
    html_url: `https://github.com/acme/${name}`,
    clone_url: `https://github.com/acme/${name}.git`,
    ssh_url: `git@github.com:acme/${name}.git`,
    default_branch: 'main',
    description: null,
  };
}

// Plain data satisfying `typeof accountGithubInstallations.$inferSelect` —
// registerLinkedProject only reads `.installationId` / `.permissions` off it,
// never fetches or persists this row itself, so it needs no DB row of its own.
const fakeInstallation = {
  installationRowId: '00000000-0000-4000-a000-000000009903',
  accountId: ACCOUNT_ID,
  installationId: '123456',
  ownerLogin: 'acme',
  ownerType: 'Organization',
  repositorySelection: 'selected',
  permissions: {},
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

describeWithDb(
  'r2.ts icon glue — registerGitHubLinkedProject / registerPatLinkedProject (real DB)',
  () => {
    beforeEach(async () => {
      await cleanup();
      await db().insert(accounts).values({ accountId: ACCOUNT_ID, name: 'r2 icon glue test' });
    });
    afterEach(cleanup);

    test('registerGitHubLinkedProject: a valid emoji in body.icon persists to metadata.icon', async () => {
      const body = { icon: '🚀' };
      const icon = normalizeProjectIcon(body.icon); // exact r2.ts call site
      expect(icon).toBe('🚀');

      const row = await registerGitHubLinkedProject({
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        repo: fakeRepo('icon-ok'),
        installation: fakeInstallation,
        name: 'icon-ok',
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
        ...(icon ? { projectMetadata: { icon } } : {}), // exact r2.ts spread
      });

      expect((row.metadata as Record<string, unknown>).icon).toBe('🚀');
      const [persisted] = await db()
        .select()
        .from(projects)
        .where(eq(projects.projectId, row.projectId))
        .limit(1);
      expect((persisted?.metadata as Record<string, unknown> | null)?.icon).toBe('🚀');
      // Sibling namespaces registerLinkedProject always writes stay intact —
      // projectMetadata must be a spread-in, not a replacement of the object.
      expect((persisted?.metadata as { git?: unknown } | null)?.git).toBeTruthy();
    });

    test('registerGitHubLinkedProject: a malformed icon (over the byte cap) never reaches metadata — no `icon` key at all', async () => {
      const body = { icon: 'x'.repeat(5000) };
      const icon = normalizeProjectIcon(body.icon);
      expect(icon).toBeNull();

      const row = await registerGitHubLinkedProject({
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        repo: fakeRepo('icon-bad'),
        installation: fakeInstallation,
        name: 'icon-bad',
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
        ...(icon ? { projectMetadata: { icon } } : {}),
      });

      const meta = row.metadata as Record<string, unknown>;
      expect('icon' in meta).toBe(false); // never `metadata.icon: null`
    });

    test('registerGitHubLinkedProject: no icon in the request body at all — metadata carries no icon key', async () => {
      const body: { icon?: unknown } = {};
      const icon = normalizeProjectIcon(body.icon);
      expect(icon).toBeNull();

      const row = await registerGitHubLinkedProject({
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        repo: fakeRepo('icon-absent'),
        installation: fakeInstallation,
        name: 'icon-absent',
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
        ...(icon ? { projectMetadata: { icon } } : {}),
      });

      expect('icon' in (row.metadata as Record<string, unknown>)).toBe(false);
    });

    test('registerPatLinkedProject (link-repository PAT path): a valid flag emoji persists to metadata.icon', async () => {
      const body = { icon: '🇺🇸' };
      const icon = normalizeProjectIcon(body.icon);
      expect(icon).toBe('🇺🇸');

      const row = await registerPatLinkedProject({
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        repo: fakeRepo('icon-pat-ok'),
        token: 'fake-pat-token-never-used-for-network-io',
        name: 'icon-pat-ok',
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
        ...(icon ? { projectMetadata: { icon } } : {}),
      });

      const [persisted] = await db()
        .select()
        .from(projects)
        .where(eq(projects.projectId, row.projectId))
        .limit(1);
      expect((persisted?.metadata as Record<string, unknown> | null)?.icon).toBe('🇺🇸');
    });

    test('registerPatLinkedProject: a malformed icon never reaches metadata', async () => {
      const body = { icon: '🚀🚀' }; // two graphemes — rejected
      const icon = normalizeProjectIcon(body.icon);
      expect(icon).toBeNull();

      const row = await registerPatLinkedProject({
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        repo: fakeRepo('icon-pat-bad'),
        token: 'fake-pat-token-never-used-for-network-io',
        name: 'icon-pat-bad',
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
        ...(icon ? { projectMetadata: { icon } } : {}),
      });

      expect('icon' in (row.metadata as Record<string, unknown>)).toBe(false);
    });
  },
);
