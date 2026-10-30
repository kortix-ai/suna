/**
 * KRTX-2543: a skill created with the Skills form never surfaced on a
 * kortix_version 3 project. v3 lists a skill only when `kortix.yaml`
 * registers it (`skills.<name>: <folder>`), and the create route committed
 * the SKILL.md alone. In-process app, real DB, real git upstream.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { createLocalGitUpstream, type LocalGitUpstream } from './helpers/local-git-upstream';

const V3_MANIFEST = `kortix_version: 3
default_agent: support
agents:
  support:
    description: Answers tickets.
    mode: primary
    skills: all
`;

const V2_MANIFEST = `kortix_version: 2
default_agent: kortix
agents:
  kortix:
    file: agents/kortix.md
    skills: all
`;

interface Seeded {
  accountId: string;
  projectId: string;
  upstream: LocalGitUpstream;
  secret: string;
}
const seeded: Seeded[] = [];

async function seed(manifest: string): Promise<Seeded> {
  const accountId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const upstream = createLocalGitUpstream('skill-create-registry', { 'kortix.yaml': manifest });
  await db.insert(accounts).values({ accountId, name: 'skill-create-registry-test' });
  await db.insert(projects).values({ projectId, accountId, name: 'skill-create-registry-test-project', repoUrl: upstream.repoUrl });
  await insertIntoView(db, accountMembers, [{ userId, accountId, accountRole: 'owner', isSuperAdmin: false }]);
  await insertIntoView(db, projectMembers, [{ accountId, projectId, userId, projectRole: 'manager' }]);
  const secret = (
    await createAccountToken({ accountId, userId, projectId, name: 'skill-create-registry-test', agentGrant: null as any })
  ).secretKey;
  const entry = { accountId, projectId, upstream, secret };
  seeded.push(entry);
  return entry;
}

afterAll(async () => {
  for (const entry of seeded) {
    await db.execute(sql`delete from kortix.account_tokens where account_id = ${entry.accountId}`);
    await db.delete(projects).where(eq(projects.accountId, entry.accountId));
    await db.delete(accounts).where(eq(accounts.accountId, entry.accountId));
    entry.upstream.remove();
  }
});

const show = (entry: Seeded, path: string) =>
  execFileSync('git', ['--git-dir', entry.upstream.repoUrl, 'show', `main:${path}`], { encoding: 'utf8' });

async function create(entry: Seeded, name: string) {
  return app.request(`/v1/projects/${entry.projectId}/skills`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${entry.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: 'Load when drafting release notes.' }),
  });
}

async function listedSkillPaths(entry: Seeded): Promise<string[]> {
  const res = await app.request(`/v1/projects/${entry.projectId}/detail`, {
    headers: { Authorization: `Bearer ${entry.secret}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { config: { skills: Array<{ path: string }> } };
  return body.config.skills.map((skill) => skill.path);
}

describe('POST /v1/projects/:projectId/skills', () => {
  test('kortix_version 3: registers the skill in kortix.yaml in the same commit, and the project lists it', async () => {
    const entry = await seed(V3_MANIFEST);
    const res = await create(entry, 'Release notes');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: 'release-notes', path: 'skills/release-notes/SKILL.md' });

    expect(show(entry, 'kortix.yaml')).toContain('release-notes: skills/release-notes');
    // One commit carries both files.
    const files = execFileSync('git', ['--git-dir', entry.upstream.repoUrl, 'show', '--name-only', '--format=', 'main'], { encoding: 'utf8' });
    expect(files.split('\n').filter(Boolean).sort()).toEqual(['kortix.yaml', 'skills/release-notes/SKILL.md']);

    expect(await listedSkillPaths(entry)).toContain('skills/release-notes/SKILL.md');
  });

  test('kortix_version 3: a second create of the same name answers 409 and changes nothing', async () => {
    const entry = seeded[0]!;
    const before = execFileSync('git', ['--git-dir', entry.upstream.repoUrl, 'rev-parse', 'main'], { encoding: 'utf8' });
    const res = await create(entry, 'Release notes');
    expect(res.status).toBe(409);
    expect(execFileSync('git', ['--git-dir', entry.upstream.repoUrl, 'rev-parse', 'main'], { encoding: 'utf8' })).toBe(before);
  });

  test('kortix_version 2: commits the SKILL.md alone, kortix.yaml unchanged, and the project lists it', async () => {
    const entry = await seed(V2_MANIFEST);
    const res = await create(entry, 'Release notes');
    expect(res.status).toBe(201);
    expect(show(entry, 'kortix.yaml')).toBe(V2_MANIFEST);
    expect(show(entry, 'skills/release-notes/SKILL.md')).toContain('name: Release notes');
    expect(await listedSkillPaths(entry)).toContain('skills/release-notes/SKILL.md');
  });
});
