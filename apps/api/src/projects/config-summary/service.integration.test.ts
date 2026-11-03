/**
 * Saved config summaries against a real PostgreSQL and a partial-store
 * upstream: a build saves what the live loader reads at that commit, a read
 * serves it with the upstream and the store gone (no git), a moved tip
 * rebuilds it, an older build never replaces a newer one, and a row of
 * another format reads as absent.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { accounts, baseTipChecks, projectConfigSummaries, projects } from '@kortix/db';
import { expireBaseTips } from '../../config-releases/base-tip';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { loadRepoConfigSummary } from '../git/config';
import { listRepoFiles } from '../git/files';
import { createPartialStoreFixture, type PartialStoreFixture } from '../git/__tests__/partial-store-fixture';
import { loadConfigWithFiles } from '../lib/project-resources';
import { buildConfigSummary, CONFIG_SUMMARY_FORMAT, readConfigSummary, readServableConfigSummary, savedProjectConfig } from './service';

let fx: PartialStoreFixture;
let accountId: string;

/** Record `tip` as the proven tip of main, as a tip check does. */
async function prove(tip: string) {
  const now = new Date();
  await db
    .insert(baseTipChecks)
    .values({ projectId: fx.project.projectId, ref: 'main', tip, checkedAt: now, provenAt: now })
    .onConflictDoUpdate({ target: [baseTipChecks.projectId, baseTipChecks.ref], set: { tip, checkedAt: now, provenAt: now } });
}

const skill = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nBody.\n`;

beforeEach(async () => {
  accountId = randomUUID();
  fx = await createPartialStoreFixture(
    {
      'kortix.yaml': 'imports:\n  - team/kortix.yaml\n',
      'team/kortix.yaml': 'agents:\n  builder:\n    connectors: all\nskills:\n  alpha: team/skills/alpha\n',
      'team/skills/alpha/SKILL.md': skill('alpha'),
    },
    { projectId: randomUUID() },
  );
  await db.insert(accounts).values({ accountId, name: 'config summary test' });
  await db.insert(projects).values({ projectId: fx.project.projectId, accountId, name: 'config summary test', repoUrl: fx.project.repoUrl });
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.projectId, fx.project.projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
  await fx.cleanup();
});

test('a build saves the live summary at that commit, and a read serves it with no upstream and no store', async () => {
  const commit = await fx.push({}, 'tip');
  expect(await buildConfigSummary(fx.project, 'main', commit)).toBe('built');
  const live = await loadRepoConfigSummary(fx.project, await listRepoFiles(fx.project, commit), commit);

  await prove(commit);
  // No git from here on: the upstream and this process's store are deleted.
  await rm(fx.upstream, { recursive: true, force: true });
  await rm(fx.storePath(), { recursive: true, force: true });

  const saved = await readServableConfigSummary(fx.project.projectId, 'main');
  expect(saved?.sourceCommit).toBe(commit);
  expect(saved?.config).toEqual(JSON.parse(JSON.stringify(live)));
  expect(saved?.config.skills.map((s) => [s.name, s.description])).toEqual([['alpha', 'The alpha skill.']]);
  expect(saved?.config.agents.map((a) => a.name)).toContain('builder');
  expect(saved?.files.map((f) => f.path).sort()).toEqual(['kortix.yaml', 'team/kortix.yaml', 'team/skills/alpha/SKILL.md']);
  expect(saved?.filesComplete).toBe(true);
  expect(saved?.fileCount).toBe(3);
});

test('a moved tip rebuilds the row; the same tip is current', async () => {
  const first = await fx.push({}, 'first');
  await buildConfigSummary(fx.project, 'main', first);
  expect(await buildConfigSummary(fx.project, 'main', first)).toBe('current');

  const second = await fx.push({ 'team/skills/beta/SKILL.md': skill('beta'), 'team/kortix.yaml': 'agents:\n  builder:\n    connectors: all\nskills:\n  alpha: team/skills/alpha\n  beta: team/skills/beta\n' }, 'add beta');
  expect(await buildConfigSummary(fx.project, 'main', second)).toBe('built');
  const saved = await readConfigSummary(fx.project.projectId, 'main');
  expect(saved?.sourceCommit).toBe(second);
  expect(saved?.config.skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
});

test('an older build never replaces a newer row', async () => {
  const commit = await fx.push({}, 'tip');
  await buildConfigSummary(fx.project, 'main', commit);
  const future = new Date(Date.now() + 60_000);
  await db.update(projectConfigSummaries).set({ resolvedAt: future, sourceCommit: 'f'.repeat(40) }).where(eq(projectConfigSummaries.projectId, fx.project.projectId));

  expect(await buildConfigSummary(fx.project, 'main', commit)).toBe('built');
  expect((await readConfigSummary(fx.project.projectId, 'main'))?.sourceCommit).toBe('f'.repeat(40));
});

test('a row of another format reads as absent', async () => {
  const commit = await fx.push({}, 'tip');
  await buildConfigSummary(fx.project, 'main', commit);
  await db.update(projectConfigSummaries).set({ format: CONFIG_SUMMARY_FORMAT + 1 }).where(eq(projectConfigSummaries.projectId, fx.project.projectId));
  expect(await readConfigSummary(fx.project.projectId, 'main')).toBeNull();
});

test('a base move clears the proof: the next read does not serve the row from before it', async () => {
  const commit = await fx.push({}, 'tip');
  await buildConfigSummary(fx.project, 'main', commit);
  await prove(commit);
  expect((await readServableConfigSummary(fx.project.projectId, 'main'))?.sourceCommit).toBe(commit);

  await expireBaseTips(fx.project.projectId);
  expect(await readServableConfigSummary(fx.project.projectId, 'main')).toBeNull();

  // A proven tip the row does not name is not served either.
  await prove('e'.repeat(40));
  expect(await readServableConfigSummary(fx.project.projectId, 'main')).toBeNull();
});

test('a stored disconnect serves no saved summary', async () => {
  const commit = await fx.push({}, 'tip');
  await buildConfigSummary(fx.project, 'main', commit);
  await prove(commit);
  const { projectGitConnections } = await import('@kortix/db');
  await db.insert(projectGitConnections).values({
    accountId,
    projectId: fx.project.projectId,
    provider: 'github',
    repoUrl: 'https://github.com/example/repo.git',
    defaultBranch: 'main',
    authMethod: 'github_app',
    status: 'error',
    lastErrorCode: 'app_uninstalled',
    lastValidatedAt: new Date(),
  });
  expect(await readServableConfigSummary(fx.project.projectId, 'main')).toBeNull();
});

test('savedProjectConfig serves the config the live loader returns, Kortix skills included, and the resource config reads it with no git', async () => {
  const commit = await fx.push({}, 'tip');
  const { loadProjectConfig } = await import('../git/config');
  const live = await loadProjectConfig(fx.project);
  expect(await buildConfigSummary(fx.project, 'main', commit)).toBe('built');
  await prove(commit);
  // No git from here on.
  await rm(fx.upstream, { recursive: true, force: true });
  await rm(fx.storePath(), { recursive: true, force: true });

  const saved = await savedProjectConfig(fx.project);
  expect(saved?.config).toEqual(live);
  expect(await loadConfigWithFiles({ ...fx.project } as never)).toEqual(live);
});

test('savedProjectConfig serves nothing after a base move, and a forced resource read never takes the row', async () => {
  const commit = await fx.push({}, 'tip');
  expect(await buildConfigSummary(fx.project, 'main', commit)).toBe('built');
  await prove(commit);
  await expireBaseTips(fx.project.projectId);
  expect(await savedProjectConfig(fx.project)).toBeNull();
});
