/**
 * Integration test (real PostgreSQL): kortix.yaml owns the App fields it
 * declares. A sync applies them to the App rows (and nothing else); a write
 * commits them to the file first and refuses an invalid value before any
 * commit. The git commit is stubbed; every query is real.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { appLinks, apps } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from '../__tests__/helpers/integration-fixtures';

let manifest: { raw: Record<string, unknown> } = { raw: {} };
const commits: string[] = [];
mock.module('../connectors/manifest-mutation', () => ({
  mutateManifestWithRetry: async (_project: unknown, _op: string, mutate: (m: typeof manifest) => { ok: boolean; commitMessage?: string | null; error?: string; status?: number }) => {
    const draft = { raw: structuredClone(manifest.raw) };
    const change = mutate(draft);
    if (!change.ok) return change;
    if (change.commitMessage) { manifest = draft; commits.push(change.commitMessage); }
    return { ok: true };
  },
}));
mock.module('../projects/surface', () => ({ withProjectGitAuth: async (row: unknown) => row }));
const { commitAppFields, syncDeclaredApps } = await import('./app-manifest');

let project: SeededProject;
const OWNER = crypto.randomUUID();
const row = (slug: string, extra: Partial<typeof apps.$inferInsert> = {}) => ({
  accountId: project.account_id, projectId: project.project_id, slug, name: slug,
  routeKey: crypto.randomUUID().replace(/-/g, '').slice(0, 16), createdBy: OWNER, ...extra,
});
const read = async (slug: string) => (await db.select().from(apps).where(eq(apps.slug, slug))).find((r) => r.projectId === project.project_id)!;

beforeAll(async () => {
  project = await seedProject('app-manifest');
  await db.insert(apps).values([row('web'), row('db', { labels: ['old'] }), row('plain', { alwaysOn: true })]);
});

afterAll(async () => {
  await removeSeeded([project]);
});

test('a sync applies every declared field, resolves uses by slug, leaves undeclared Apps and fields alone, and is idempotent', async () => {
  const declared = {
    web: { path: 'apps/web', resources: { cpu: 2, memory_gb: 4 }, always_on: true, idle_timeout_seconds: 900, display: { listed: true }, uses: ['db'] },
    db: { labels: ['backend'] },
    ghost: { display: { listed: true } },
    plain: { path: 'apps/plain' },
  };
  const first = await syncDeclaredApps(project.project_id, declared);
  expect(first).toEqual({ updated: ['web', 'db'], errors: [] });
  const web = await read('web');
  expect({ cpu: web.cpuCores, memory: web.memoryGb, disk: web.diskGb, alwaysOn: web.alwaysOn, idle: web.idleTimeoutSeconds, display: web.display })
    .toEqual({ cpu: 2, memory: 4, disk: 10, alwaysOn: true, idle: 900, display: { listed: true } });
  expect((await read('db')).labels).toEqual(['backend']);
  expect((await read('plain')).alwaysOn).toBe(true);
  const links = await db.select().from(appLinks).where(eq(appLinks.appId, web.appId));
  expect(links.map((l) => l.usesAppId)).toEqual([(await read('db')).appId]);
  expect(await syncDeclaredApps(project.project_id, declared)).toEqual({ updated: [], errors: [] });
});

test('uses naming an unknown App is reported and keeps the links', async () => {
  const result = await syncDeclaredApps(project.project_id, { web: { uses: ['nope'] } });
  expect(result.errors).toEqual([{ slug: 'web', error: 'apps.web.uses names no App of this project: nope' }]);
  expect((await db.select().from(appLinks).where(eq(appLinks.appId, (await read('web')).appId)))).toHaveLength(1);
});

test('a write commits the fields into apps.<slug>, adding the block when needed; an invalid value commits nothing', async () => {
  manifest = { raw: { apps: { web: { path: 'apps/web', resources: { disk_gb: 20 } } } } };
  expect(await commitAppFields(project.project_id, 'web', { cpu: 2, display: { listed: false } })).toEqual({ ok: true });
  expect(await commitAppFields(project.project_id, 'docs', { display: { listed: true } })).toEqual({ ok: true });
  expect(manifest.raw.apps).toEqual({
    web: { path: 'apps/web', resources: { disk_gb: 20, cpu: 2 }, display: { listed: false } },
    docs: { display: { listed: true } },
  });
  expect(commits).toEqual(['chore: update App web', 'chore: update App docs']);
  // The same value again: no commit.
  expect(await commitAppFields(project.project_id, 'web', { cpu: 2 })).toEqual({ ok: true });
  expect(commits).toHaveLength(2);
  // A parent with no block gets an empty one, so the file stays valid.
  expect(await commitAppFields(project.project_id, 'docs', { display: { parent: 'db' } })).toEqual({ ok: true });
  expect((manifest.raw.apps as Record<string, unknown>).db).toEqual({});
  const refused = await commitAppFields(project.project_id, 'web', { cpu: 999 });
  expect(refused.ok).toBe(false);
  expect(commits).toHaveLength(3);
});
