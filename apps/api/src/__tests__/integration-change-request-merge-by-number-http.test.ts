/**
 * Route-level regression for KRTX-2763: a caller passed the CR's DISPLAY
 * NUMBER ("233") where a cr_id UUID was expected. The shared lookup
 * getCrById used to hand Postgres a non-UUID and every CR route 500-ed with
 * 22P02 "invalid input syntax for type uuid". The lookup now resolves a
 * number (and "#number") through the (project_id, number) unique index.
 *
 * This suite exercises the REAL HTTP routes, because the lookup alone was
 * not the whole bug: after a successful lookup, five follow-up writes bound
 * the RAW path param into `where cr_id = …` — so a matching number resolved,
 * then the write 22P02-ed AFTER its side effect (the merge route had already
 * landed the merge on the base branch and the recording update still
 * failed). Every route here drives a numeric id through the full handler:
 * merge (the prod case), close, reopen and request-changes, and an unknown
 * number must be a clean 404.
 *
 * Real-Postgres + real-git tenant contract, mirroring
 * integration-project-read-leaf-gates-http.test.ts (local bare upstream,
 * minted account tokens, the real app from ../index).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountMembers, accounts, changeRequests, projectMembers, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { PROJECT_ACTIONS } from '../iam';
import { insertIntoView } from './helpers/compat-views';
import { createLocalGitUpstream, type LocalGitUpstream } from './helpers/local-git-upstream';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();

const minted: string[] = [];
let upstream: LocalGitUpstream;
/** Temp dirs of the branch seeds this suite pushes into the upstream. */
const seededDirs: string[] = [];

function pushBranch(repoUrl: string, name: string, file: string): void {
  const work = mkdtempSync(join(tmpdir(), `kortix-cr-merge-by-number-`));
  seededDirs.push(work);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Kortix Test', '-c', 'user.email=test@kortix.invalid', ...args], {
      cwd,
      stdio: 'pipe',
    });
  // Branch FROM the upstream's main (the CR's base): an unrelated history
  // would make mergeBranches refuse the merge and the route 409.
  git(work, 'clone', '-q', '--branch', 'main', repoUrl, '.');
  writeFileSync(join(work, file), `seed ${name}\n`);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', `seed ${name}`);
  git(work, 'push', '-q', 'origin', `HEAD:refs/heads/${name}`);
}

const post = (path: string, secret: string, body: unknown = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  upstream = createLocalGitUpstream('cr-merge-by-number');
  // The merge route merges the CR's head branch into the base branch for real.
  pushBranch(upstream.repoUrl, 'cr-233', 'feature-233.txt');
  pushBranch(upstream.repoUrl, 'cr-234', 'feature-234.txt');

  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'cr-merge-by-number-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'cr-merge-by-number-test-project',
    repoUrl: upstream.repoUrl,
  });
  await insertIntoView(db, accountMembers, [
    { userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
  ]);
  // CR #233: the prod case (the merge route got the bare number). CR #234:
  // the close/reopen/request-changes cases.
  await db.insert(changeRequests).values([
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: 233,
      title: 'The one with the number',
      baseRef: 'main',
      headRef: 'cr-233',
      status: 'open',
      createdBy: MANAGER,
    },
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: 234,
      title: 'The lifecycle one',
      baseRef: 'main',
      headRef: 'cr-234',
      status: 'open',
      createdBy: MANAGER,
    },
  ]);
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  upstream.remove();
  for (const dir of seededDirs) rmSync(dir, { recursive: true, force: true });
});

async function managerToken(): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId: MANAGER,
    projectId: PROJECT,
    name: 'cr-merge-by-number-test',
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

describe('change-request routes accept the display number a caller can pass', () => {
  test('the prod case: POST …/change-requests/233/merge lands the merge and records it', async () => {
    const secret = await managerToken();
    const res = await post(`/v1/projects/${PROJECT}/change-requests/233/merge`, secret);
    expect(res.status, await res.text()).toBe(200);
    const [row] = await db
      .select({ status: changeRequests.status, mergeCommitSha: changeRequests.mergeCommitSha })
      .from(changeRequests)
      .where(eq(changeRequests.number, 233));
    // The recording update after the merge must have succeeded too — a raw
    // `where cr_id = '233'` here 22P02-ed AFTER the merge had already landed.
    expect(row!.status).toBe('merged');
    expect(row!.mergeCommitSha).toBeTruthy();
  });

  test('an unknown number is a clean 404, not a uuid-cast 500', async () => {
    const secret = await managerToken();
    const res = await post(`/v1/projects/${PROJECT}/change-requests/9999/merge`, secret);
    expect(res.status).toBe(404);
  });

  test('a number above the int4 range is a clean 404, not a 22003 500', async () => {
    const secret = await managerToken();
    const res = await post(
      `/v1/projects/${PROJECT}/change-requests/99999999999999999999/merge`,
      secret,
    );
    expect(res.status).toBe(404);
  });

  test('close and reopen by number complete their own writes', async () => {
    const secret = await managerToken();
    const close = await post(`/v1/projects/${PROJECT}/change-requests/234/close`, secret);
    expect(close.status).toBe(200);
    const [closed] = await db
      .select({ status: changeRequests.status })
      .from(changeRequests)
      .where(eq(changeRequests.number, 234));
    expect(closed!.status).toBe('closed');

    const reopen = await post(`/v1/projects/${PROJECT}/change-requests/234/reopen`, secret);
    expect(reopen.status).toBe(200);
    const [reopened] = await db
      .select({ status: changeRequests.status })
      .from(changeRequests)
      .where(eq(changeRequests.number, 234));
    expect(reopened!.status).toBe('open');
  });

  test('request-changes by number persists the feedback note', async () => {
    const secret = await managerToken();
    const res = await post(`/v1/projects/${PROJECT}/change-requests/234/request-changes`, secret, {
      feedback: 'please rename the variable',
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ metadata: changeRequests.metadata })
      .from(changeRequests)
      .where(eq(changeRequests.number, 234));
    const notes = (row!.metadata as { requested_changes?: unknown[] } | null)?.requested_changes;
    expect(Array.isArray(notes)).toBe(true);
    expect(notes).toHaveLength(1);
  });

  test('PATCH (edit title) by number binds the resolved row, not the raw param', async () => {
    const secret = await managerToken();
    const res = await app.request(`/v1/projects/${PROJECT}/change-requests/234`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed by number' }),
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ title: changeRequests.title })
      .from(changeRequests)
      .where(eq(changeRequests.number, 234));
    expect(row!.title).toBe('renamed by number');
  });
});
