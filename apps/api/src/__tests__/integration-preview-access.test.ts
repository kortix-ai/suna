/**
 * Integration test (real local PostgreSQL): who may reach a sandbox through
 * the preview proxy, and which public share links resolve.
 *
 * `shared/preview-ownership.ts` and `shared/session-public-shares.ts` decide
 * both. Every route-level suite replaces them with a stub, so this file is the
 * one place their real rules run: against real accounts, memberships,
 * platform roles, sessions, sandboxes and share rows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  platformUserRoles,
  projectSessions,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  canAccessPreviewSandbox,
  canAccessSandboxSession,
  clearPreviewOwnershipCache,
} from '../shared/preview-ownership';
import { createPublicShare, resolvePublicShare } from '../shared/session-public-shares';
import { insertIntoView } from './helpers/compat-views';

const run = crypto.randomUUID().slice(0, 8);

/** The account that owns the sandbox, and a second, unrelated account. */
const OWNER_ACCOUNT = crypto.randomUUID();
const OTHER_ACCOUNT = crypto.randomUUID();
/** A platform admin's own account. */
const ADMIN_ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();

const MEMBER = crypto.randomUUID();
const SECOND_MEMBER = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
const PLATFORM_ADMIN = crypto.randomUUID();

const SESSION = crypto.randomUUID();
const EXTERNAL_ID = `sbx_preview_access_${run}`;
/** A session whose sandbox was never provisioned: its share cannot be served yet. */
const UNSTARTED_SESSION = crypto.randomUUID();
/** A session a backend wrapper created for one of its end-users. */
const BACKEND_SESSION = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId: OWNER_ACCOUNT, name: 'preview-access-owner' },
    { accountId: OTHER_ACCOUNT, name: 'preview-access-other' },
    { accountId: ADMIN_ACCOUNT, name: 'preview-access-admin' },
  ]);
  await insertIntoView(db, accountMembers, [
    { userId: MEMBER, accountId: OWNER_ACCOUNT, accountRole: 'member' },
    { userId: SECOND_MEMBER, accountId: OWNER_ACCOUNT, accountRole: 'member' },
    { userId: OUTSIDER, accountId: OTHER_ACCOUNT, accountRole: 'owner' },
    { userId: PLATFORM_ADMIN, accountId: ADMIN_ACCOUNT, accountRole: 'owner' },
  ]);
  await db.insert(platformUserRoles).values({ accountId: ADMIN_ACCOUNT, role: 'admin' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: OWNER_ACCOUNT,
    name: 'preview-access',
    repoUrl: 'https://example.test/preview-access.git',
  });
  await db.insert(projectSessions).values([
    {
      sessionId: SESSION,
      accountId: OWNER_ACCOUNT,
      projectId: PROJECT,
      branchName: `session/${SESSION}`,
      createdBy: MEMBER,
      visibility: 'private',
      status: 'running',
    },
    {
      sessionId: UNSTARTED_SESSION,
      accountId: OWNER_ACCOUNT,
      projectId: PROJECT,
      branchName: `session/${UNSTARTED_SESSION}`,
      createdBy: MEMBER,
      status: 'provisioning',
    },
    {
      sessionId: BACKEND_SESSION,
      accountId: OWNER_ACCOUNT,
      projectId: PROJECT,
      branchName: `session/${BACKEND_SESSION}`,
      createdBy: MEMBER,
      origin: 'backend',
      status: 'running',
    },
  ]);
  await db.insert(sessionSandboxes).values({
    sandboxId: SESSION,
    sessionId: SESSION,
    accountId: OWNER_ACCOUNT,
    projectId: PROJECT,
    externalId: EXTERNAL_ID,
    status: 'active',
  });
  clearPreviewOwnershipCache();
});

afterAll(async () => {
  await db.execute(sql`
    delete from kortix.project_session_public_shares where project_id = ${PROJECT}::uuid`);
  await db.execute(sql`
    update kortix.project_sessions
       set metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"cleanup"}'::jsonb
     where project_id = ${PROJECT}::uuid`);
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.projectId, PROJECT));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(platformUserRoles).where(eq(platformUserRoles.accountId, ADMIN_ACCOUNT));
  for (const accountId of [OWNER_ACCOUNT, OTHER_ACCOUNT, ADMIN_ACCOUNT]) {
    await db.delete(accounts).where(eq(accounts.accountId, accountId));
  }
});

describe('canAccessPreviewSandbox', () => {
  // A signed-in person reaches a sandbox of an account they belong to, or any
  // sandbox as a platform admin. An unknown sandbox is refused, except to a
  // platform admin (staff debugging a box by name).
  test.each([
    { who: 'a member of the owning account', userId: MEMBER, sandbox: EXTERNAL_ID, allowed: true },
    { who: 'a member of another account', userId: OUTSIDER, sandbox: EXTERNAL_ID, allowed: false },
    {
      who: 'a platform admin of another account',
      userId: PLATFORM_ADMIN,
      sandbox: EXTERNAL_ID,
      allowed: true,
    },
    {
      who: 'a member, on a sandbox nobody knows',
      userId: MEMBER,
      sandbox: `sbx_unknown_${run}`,
      allowed: false,
    },
    {
      who: 'a platform admin, on a sandbox nobody knows',
      userId: PLATFORM_ADMIN,
      sandbox: `sbx_unknown_${run}`,
      allowed: true,
    },
  ])('$who: $allowed', async ({ userId, sandbox, allowed }) => {
    expect(await canAccessPreviewSandbox({ previewSandboxId: sandbox, userId })).toBe(allowed);
  });

  // An account API key carries an account, not a user. It reaches exactly the
  // sandboxes of that account: there is no platform-admin bypass on this path.
  test.each([
    { whose: 'the owning account', accountId: OWNER_ACCOUNT, allowed: true },
    { whose: 'another account', accountId: OTHER_ACCOUNT, allowed: false },
    { whose: "a platform admin's account", accountId: ADMIN_ACCOUNT, allowed: false },
  ])('an account key of $whose: $allowed', async ({ accountId, allowed }) => {
    expect(await canAccessPreviewSandbox({ previewSandboxId: EXTERNAL_ID, accountId })).toBe(
      allowed,
    );
  });

  test('a caller with neither a user nor an account is refused', async () => {
    expect(await canAccessPreviewSandbox({ previewSandboxId: EXTERNAL_ID })).toBe(false);
  });
});

describe('canAccessSandboxSession', () => {
  const access = (sessionId: string, userId: string, callerSessionId: string | null) =>
    canAccessSandboxSession({
      sessionId,
      projectId: PROJECT,
      accountId: OWNER_ACCOUNT,
      userId,
      callerSessionId,
      boundCredentialSessionId: callerSessionId,
    });

  test('the creator of a private session reaches it', async () => {
    expect(await access(SESSION, MEMBER, null)).toBe(true);
  });

  test('another member of the account does not reach a private session', async () => {
    expect(await access(SESSION, SECOND_MEMBER, null)).toBe(false);
  });

  // Every session a backend wrapper creates shares one `created_by`, so the
  // token's own session binding is what separates the wrapper's end-users.
  test('a token bound to a backend session reaches it; a token bound to another does not', async () => {
    expect(await access(BACKEND_SESSION, MEMBER, BACKEND_SESSION)).toBe(true);
    expect(await access(BACKEND_SESSION, MEMBER, crypto.randomUUID())).toBe(false);
  });
});

describe('resolvePublicShare', () => {
  async function shareFor(sessionId: string, input: Parameters<typeof createPublicShare>[0] = {}) {
    const created = await createPublicShare(
      { preview: { port: 3000 }, ...input },
      { sessionId, projectId: PROJECT, accountId: OWNER_ACCOUNT, userId: MEMBER },
    );
    if (!created.ok) throw new Error(`share not created: ${created.error}`);
    return created.share;
  }

  test('a live link resolves to its own share row', async () => {
    const share = await shareFor(SESSION);
    const resolved = await resolvePublicShare(share.public_token);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.row.shareId).toBe(share.share_id);
      expect(resolved.row.externalId).toBe(EXTERNAL_ID);
      expect(resolved.row.port).toBe(3000);
    }
  });

  test('an unknown token is not found', async () => {
    expect(await resolvePublicShare(`kps_${crypto.randomUUID().replaceAll('-', '')}`)).toMatchObject(
      { ok: false, status: 404 },
    );
  });

  test('a revoked link is gone, and so is an expired one', async () => {
    const revoked = await shareFor(SESSION);
    await db.execute(sql`
      update kortix.project_session_public_shares set revoked_at = now()
       where share_id = ${revoked.share_id}::uuid`);
    expect(await resolvePublicShare(revoked.public_token)).toMatchObject({
      ok: false,
      status: 410,
      error: 'Share link revoked',
    });

    const expired = await shareFor(SESSION, { expires_at: '2020-01-01T00:00:00.000Z' });
    expect(await resolvePublicShare(expired.public_token)).toMatchObject({
      ok: false,
      status: 410,
      error: 'Share link expired',
    });
  });

  // A valid link to a session whose box does not exist yet is not "not found":
  // the link is real, its sandbox is just not up.
  test('a link to a session with no sandbox yet is not ready, not missing', async () => {
    const share = await shareFor(UNSTARTED_SESSION);
    expect(await resolvePublicShare(share.public_token)).toMatchObject({
      ok: false,
      status: 503,
    });
  });
});
