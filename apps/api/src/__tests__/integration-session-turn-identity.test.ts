/**
 * Integration test (real local DB): bindSessionTurnIdentity — the session token
 * acts as the person who started the current turn.
 *
 * One sandbox holds one Kortix credential for its whole life. When a second
 * member prompts a shared session, every call the agent makes in that turn
 * (authorization, LLM usage, git audit, personal resources) must act as that
 * member, not as whoever provisioned the sandbox.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { accountMemberships, accountTokens, accounts, projectSessions, projects } from '@kortix/db';
import { db } from '../lib/db';
import {
  bindSessionTurnIdentity,
  channelPrompterForOnBehalfOf,
  clearSessionOnBehalfOfForPrompt,
  ON_BEHALF_OF_CLEARED_KEY,
} from '../projects/lib/on-behalf-of';

const ACCOUNT = crypto.randomUUID();
const OTHER_ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const LAUNCHER = crypto.randomUUID();
const TAKER = crypto.randomUUID();
const SERVICE_ACCOUNT = crypto.randomUUID(); // not in auth.users, not a member

let n = 0;
async function seedSession(): Promise<string> {
  const sessionId = `turn-identity-${crypto.randomUUID()}`;
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `kortix/${sessionId}`,
  });
  return sessionId;
}

async function seedToken(
  sessionId: string,
  opts: { accountId?: string; revoked?: boolean } = {},
): Promise<string> {
  const tokenId = crypto.randomUUID();
  n += 1;
  await db.insert(accountTokens).values({
    tokenId,
    accountId: opts.accountId ?? ACCOUNT,
    userId: LAUNCHER,
    onBehalfOfUserId: LAUNCHER,
    name: `turn-${n}`,
    publicKey: `pk_turn_${n}_${tokenId.slice(0, 8)}`,
    secretKeyHash: `hash_turn_${n}_${tokenId.slice(0, 8)}`,
    projectId: opts.accountId ? null : PROJECT,
    sessionId,
    ...(opts.revoked ? { status: 'revoked' as const, revokedAt: new Date() } : {}),
  });
  return tokenId;
}

async function identityOf(tokenId: string) {
  const [row] = await db
    .select({ userId: accountTokens.userId, onBehalfOf: accountTokens.onBehalfOfUserId })
    .from(accountTokens)
    .where(eq(accountTokens.tokenId, tokenId));
  return row;
}

async function clearedStampOf(sessionId: string): Promise<unknown> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId));
  return (row?.metadata as Record<string, unknown> | null)?.[ON_BEHALF_OF_CLEARED_KEY];
}

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email) values
      (${LAUNCHER}::uuid, ${`launcher-${LAUNCHER}@example.test`}),
      (${TAKER}::uuid, ${`taker-${TAKER}@example.test`})
  `);
  await db.insert(accounts).values([
    { accountId: ACCOUNT, name: 'turn-identity' },
    { accountId: OTHER_ACCOUNT, name: 'turn-identity-other' },
  ]);
  await db.insert(accountMemberships).values([
    { userId: LAUNCHER, accountId: ACCOUNT },
    { userId: TAKER, accountId: ACCOUNT },
  ]);
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'turn-identity',
    repoUrl: 'https://example.com/turn-identity.git',
  });
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades tokens, sessions, members
  await db.delete(accounts).where(eq(accounts.accountId, OTHER_ACCOUNT));
  await db.execute(sql`delete from auth.users where id in (${LAUNCHER}::uuid, ${TAKER}::uuid)`);
});

describe('bindSessionTurnIdentity', () => {
  test('a second member takes over: every live token of the session acts as them', async () => {
    const sessionId = await seedSession();
    const first = await seedToken(sessionId);
    const afterRestart = await seedToken(sessionId);

    expect(await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: TAKER })).toBe(true);

    expect(await identityOf(first)).toEqual({ userId: TAKER, onBehalfOf: TAKER });
    expect(await identityOf(afterRestart)).toEqual({ userId: TAKER, onBehalfOf: TAKER });
  });

  test('the launcher prompts again: the token acts as the launcher again', async () => {
    const sessionId = await seedSession();
    const token = await seedToken(sessionId);
    await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: TAKER });

    expect(await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: LAUNCHER })).toBe(true);
    expect(await identityOf(token)).toEqual({ userId: LAUNCHER, onBehalfOf: LAUNCHER });
  });

  test('the same member prompting again writes nothing', async () => {
    const sessionId = await seedSession();
    const token = await seedToken(sessionId);

    expect(await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: LAUNCHER })).toBe(false);
    expect(await identityOf(token)).toEqual({ userId: LAUNCHER, onBehalfOf: LAUNCHER });
  });

  test('a prompter who is not a member keeps user_id, clears on_behalf_of, and stamps the session', async () => {
    const sessionId = await seedSession();
    const token = await seedToken(sessionId);

    expect(
      await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: SERVICE_ACCOUNT }),
    ).toBe(true);

    expect(await identityOf(token)).toEqual({ userId: LAUNCHER, onBehalfOf: null });
    expect(typeof (await clearedStampOf(sessionId))).toBe('string');
    // Already cleared: a second non-member turn writes nothing.
    expect(
      await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: SERVICE_ACCOUNT }),
    ).toBe(false);
  });

  test('a member turn after a clear restores on_behalf_of and removes the stamp', async () => {
    const sessionId = await seedSession();
    const token = await seedToken(sessionId);
    await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: SERVICE_ACCOUNT });

    expect(await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: TAKER })).toBe(true);

    expect(await identityOf(token)).toEqual({ userId: TAKER, onBehalfOf: TAKER });
    expect(await clearedStampOf(sessionId)).toBeUndefined();
  });

  test('revoked tokens, other sessions and other accounts are not touched', async () => {
    const sessionId = await seedSession();
    const neighbourSession = await seedSession();
    const revoked = await seedToken(sessionId, { revoked: true });
    const neighbour = await seedToken(neighbourSession);
    const foreign = await seedToken(sessionId, { accountId: OTHER_ACCOUNT });

    await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: TAKER });

    for (const tokenId of [revoked, neighbour, foreign]) {
      expect(await identityOf(tokenId)).toEqual({ userId: LAUNCHER, onBehalfOf: LAUNCHER });
    }
  });

  test('a member of ANOTHER account is not a member here: user_id is kept', async () => {
    const outsider = crypto.randomUUID();
    await db.execute(sql`insert into auth.users (id, email) values (${outsider}::uuid, ${`outsider-${outsider}@example.test`})`);
    await db.insert(accountMemberships).values({ userId: outsider, accountId: OTHER_ACCOUNT });
    try {
      const sessionId = await seedSession();
      const token = await seedToken(sessionId);

      await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: outsider });

      expect(await identityOf(token)).toEqual({ userId: LAUNCHER, onBehalfOf: null });
    } finally {
      await db
        .delete(accountMemberships)
        .where(and(eq(accountMemberships.userId, outsider), eq(accountMemberships.accountId, OTHER_ACCOUNT)));
      await db.execute(sql`delete from auth.users where id = ${outsider}::uuid`);
    }
  });
});

describe('automated turns', () => {
  test('a trigger fire clears on_behalf_of at delivery, keeps user_id, and stamps the session', async () => {
    const sessionId = await seedSession();
    const token = await seedToken(sessionId);
    await bindSessionTurnIdentity({ accountId: ACCOUNT, sessionId, prompterUserId: TAKER });

    expect(
      channelPrompterForOnBehalfOf({
        source: 'trigger:cron',
        userId: null,
        slackRequiresUserIdentity: true,
        teamsRequiresUserIdentity: true,
      }),
    ).toBeNull();
    // continueSession's path for a `null` prompter.
    expect(await clearSessionOnBehalfOfForPrompt({ accountId: ACCOUNT, sessionId, prompterUserId: null })).toBe(true);

    expect(await identityOf(token)).toEqual({ userId: TAKER, onBehalfOf: null });
    expect(typeof (await clearedStampOf(sessionId))).toBe('string');
  });
});
