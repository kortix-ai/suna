import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { createLocalGitUpstream, type LocalGitUpstream } from './helpers/local-git-upstream';

// GET /:projectId/detail must stay loadable by a plain `member` even though
// member lacks project.file.read: the fix filters the file list OUT of the
// response rather than 403-ing the whole bundle (a hard assert would lock every
// member out of the workspace shell). This proves the coarse floor stayed
// project.read and the file section is blanked, not gated.
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
/** A second project whose repository declares an agent in kortix.yaml. */
const DECLARED = crypto.randomUUID();

const minted: string[] = [];
let upstream: LocalGitUpstream;
let declaredUpstream: LocalGitUpstream;

beforeAll(async () => {
  upstream = createLocalGitUpstream('detail-capability');
  declaredUpstream = createLocalGitUpstream('detail-declared', {
    'kortix.yaml': 'agents:\n  writer:\n    description: Writes the release notes.\n    prompt: You write.\n',
  });
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'detail-cap-test' });
  await db.insert(projects).values({
    splitPending: true,
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'detail-cap-test-project',
    repoUrl: upstream.repoUrl,
  });
  await db.insert(projects).values({
    splitPending: true,
    projectId: DECLARED,
    accountId: ACCOUNT,
    name: 'detail-declared-project',
    repoUrl: declaredUpstream.repoUrl,
  });
  await insertIntoView(db, accountMembers, [
    { userId: MEMBER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MEMBER, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: DECLARED, userId: MANAGER, projectRole: 'manager' },
  ]);
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  upstream.remove();
  declaredUpstream.remove();
});

async function mint(userId: string, projectId = PROJECT): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    projectId,
    name: 'detail-cap-test',
    agentGrant: null as any,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

function getDetail(secret: string, projectId = PROJECT) {
  return app.request(`/v1/projects/${projectId}/detail`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
}

describe('HTTP — GET /detail stays loadable for a member (file list filtered, not 403)', () => {
  test('plain MEMBER (no file.read) → NOT 403 (workspace shell still loads)', async () => {
    const secret = await mint(MEMBER);
    const res = await getDetail(secret);
    // The whole point: member must not be denied the bundle. The old naive fix
    // (assertProjectCapability(file.read)) would 403 here.
    expect(res.status).not.toBe(403);
  });

  test('plain MEMBER → the file list is blanked (no file paths leak via /detail)', async () => {
    const secret = await mint(MEMBER);
    const res = await getDetail(secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toEqual([]);
    expect(body.file_count).toBe(0);
    // The config bundle is still present (member holds the config read leaves).
    expect(body.config).toBeDefined();
  });

  test('MANAGER (has file.read) → NOT 403', async () => {
    const secret = await mint(MANAGER);
    const res = await getDetail(secret);
    expect(res.status).not.toBe(403);
    // The upstream holds README.md: the member's empty list above is the filter,
    // not an empty repository.
    const body = await res.json();
    expect(body.files.map((file: { path: string }) => file.path)).toEqual(['README.md']);
    expect(body.file_count).toBe(1);
  });
});

// The detail answers every project page. It carried the whole parsed
// kortix.yaml as `config.manifest` (84 KB of a 208 KB body on a large project,
// 2026-11-04), and no client read it: the summary its readers use (agents,
// skills, the raw text for the agent editor) stays, the parsed copy does not.
describe('HTTP — GET /detail sends the config summary, not the parsed manifest', () => {
  test('MANAGER → agents and manifest_raw from kortix.yaml, no `manifest` key', async () => {
    const secret = await mint(MANAGER, DECLARED);
    const res = await getDetail(secret, DECLARED);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.agents.map((agent: { name: string }) => agent.name)).toContain('writer');
    expect(body.config.manifest_raw).toContain('Writes the release notes.');
    expect(Object.keys(body.config)).not.toContain('manifest');
  });
});
