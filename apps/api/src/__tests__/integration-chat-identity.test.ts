/**
 * Integration test (real local PostgreSQL): the chat identity link that every
 * Slack and Teams action runs as. Real: rows, IAM roles, the MFA gate, the
 * link and sign-in-link writes. Nothing is faked.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountMembers, accounts, chatEventDedup, chatUserIdentities, projectMembers } from '@kortix/db';
import { eq, like } from 'drizzle-orm';
import {
  chatUser,
  completeChatLogin,
  linkChatIdentity,
  lookupChatIdentity,
  resolveProjectChatActor,
  revokeChatIdentity,
} from '../channels/core/identity';
import { PROJECT_ACTIONS } from '../iam/actions';
import { invalidateIamCacheForAccount } from '../iam/cache-invalidation';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const TENANT = `tenant-identity-${crypto.randomUUID()}`;
const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
let project: SeededProject;

const login = () => ({ nonce: crypto.randomUUID(), exp: Date.now() + 60_000 });

async function requireMfa(on: boolean) {
  await db.update(accounts).set({ mfaRequired: on }).where(eq(accounts.accountId, project.account_id));
  await invalidateIamCacheForAccount(project.account_id);
}

beforeAll(async () => {
  project = await seedProject('chat-identity');
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
    { userId: MEMBER, accountId: project.account_id, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, {
    accountId: project.account_id,
    projectId: project.project_id,
    userId: MEMBER,
    projectRole: 'member',
  });
});

afterAll(async () => {
  await requireMfa(false);
  await db.delete(chatUserIdentities).where(eq(chatUserIdentities.workspaceId, TENANT));
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, 'login:teams:%'));
  await removeSeeded([project]);
});

test('a project member runs sessions from chat, and only a manager may change the project', async () => {
  const person = chatUser('teams', TENANT, 'aad-member');
  expect(await linkChatIdentity(person, MEMBER)).toEqual({ ok: true });

  expect(await resolveProjectChatActor(person, project.project_id)).toEqual({ userId: MEMBER });
  expect(await resolveProjectChatActor(person, project.project_id, PROJECT_ACTIONS.PROJECT_SESSION_STOP)).toEqual({
    userId: MEMBER,
  });
  expect(await resolveProjectChatActor(person, project.project_id, PROJECT_ACTIONS.PROJECT_WRITE)).toEqual({
    reason: 'not_member',
  });
  expect(await resolveProjectChatActor(person, project.project_id, PROJECT_ACTIONS.PROJECT_REVIEW_ACT)).toEqual({
    reason: 'not_member',
  });
});

test('a live link never moves to another Kortix user; a revoked one can', async () => {
  const person = chatUser('teams', TENANT, 'aad-takeover');
  expect(await linkChatIdentity(person, OWNER)).toEqual({ ok: true });
  expect(await linkChatIdentity(person, OUTSIDER)).toEqual({ ok: false, reason: 'linked_to_other' });
  expect((await lookupChatIdentity(person))?.userId).toBe(OWNER);

  // The same person linking again refreshes the link.
  expect(await linkChatIdentity(person, OWNER)).toEqual({ ok: true });

  expect(await revokeChatIdentity(person)).toBe(true);
  expect(await linkChatIdentity(person, OUTSIDER)).toEqual({ ok: true });
  expect((await lookupChatIdentity(person))?.userId).toBe(OUTSIDER);
});

test('a sign-in link works once; the same person reloading it changes nothing', async () => {
  const person = chatUser('teams', TENANT, 'aad-once');
  const link = login();
  const base = { user: person, login: link, accountIds: [project.account_id], mfaAal: 'aal1', tokenId: null };

  expect(await completeChatLogin({ ...base, userId: MEMBER })).toEqual({ ok: true, hasAccess: true, fresh: true });
  expect(await completeChatLogin({ ...base, userId: MEMBER })).toEqual({ ok: true, hasAccess: true, fresh: false });
  expect(await completeChatLogin({ ...base, userId: OUTSIDER })).toEqual({ ok: false, reason: 'used' });
  expect((await lookupChatIdentity(person))?.userId).toBe(MEMBER);
});

test('a new sign-in link cannot take over a live link', async () => {
  const person = chatUser('teams', TENANT, 'aad-leaked');
  await linkChatIdentity(person, MEMBER);
  const outcome = await completeChatLogin({
    user: person,
    userId: OUTSIDER,
    login: login(),
    accountIds: [project.account_id],
    mfaAal: 'aal1',
    tokenId: null,
  });
  expect(outcome).toEqual({ ok: false, reason: 'linked_to_other' });
  expect((await lookupChatIdentity(person))?.userId).toBe(MEMBER);
});

test('an MFA account: the link needs a second factor, and chat runs on the one it was made with', async () => {
  await requireMfa(true);
  try {
    const person = chatUser('teams', TENANT, 'aad-mfa');
    const link = login();
    const base = { user: person, userId: MEMBER, login: link, accountIds: [project.account_id], tokenId: null };

    // Refused before the link is spent, so the same link works after MFA.
    expect(await completeChatLogin({ ...base, mfaAal: 'aal1' })).toEqual({ ok: false, reason: 'mfa_required' });
    expect(await lookupChatIdentity(person)).toBeNull();
    expect(await completeChatLogin({ ...base, mfaAal: 'aal2' })).toEqual({ ok: true, hasAccess: true, fresh: true });
    expect(await lookupChatIdentity(person)).toEqual({ userId: MEMBER, mfaVerified: true });
    expect(await resolveProjectChatActor(person, project.project_id)).toEqual({ userId: MEMBER });

    // A refresh without MFA (a Slack reinstall) keeps the live link's stamp.
    await linkChatIdentity(person, MEMBER);
    expect(await lookupChatIdentity(person)).toEqual({ userId: MEMBER, mfaVerified: true });

    // A link made without MFA asks the person to connect again.
    await revokeChatIdentity(person);
    await linkChatIdentity(person, MEMBER);
    expect(await lookupChatIdentity(person)).toEqual({ userId: MEMBER, mfaVerified: false });
    expect(await resolveProjectChatActor(person, project.project_id)).toEqual({ reason: 'unlinked' });
  } finally {
    await requireMfa(false);
  }
});

test('an account without MFA does not ask for it', async () => {
  const person = chatUser('teams', TENANT, 'aad-no-mfa');
  await linkChatIdentity(person, MEMBER);
  expect(await lookupChatIdentity(person)).toEqual({ userId: MEMBER, mfaVerified: false });
  expect(await resolveProjectChatActor(person, project.project_id)).toEqual({ userId: MEMBER });
});
