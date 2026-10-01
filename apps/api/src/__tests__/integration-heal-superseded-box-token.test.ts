/**
 * Integration test (real local PostgreSQL): a box's own revoked session token
 * is made valid again on `/start`, but only when every guard holds.
 *
 * The box holds the token it was created with (the provider re-applies it on
 * every start). A migration rotation or a bulk revoke killed that token while
 * the box kept it, so the daemon's first claim got 401 forever. The heal
 * reactivates exactly the token equal to the session's recorded box key.
 *
 * `openSession` is replaced so the test sees only what `startSession` does
 * before it opens the runtime. The heal itself runs against real rows.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accountMembers } from '@kortix/db';
import { sql } from 'drizzle-orm';
import * as realShared from '../projects/routes/shared';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

mock.module('../projects/routes/shared', () => ({
  ...realShared,
  openSession: async () => ({ stage: 'starting', sandbox: null, opencode_session_id: null, retriable: true }),
}));

const { healSupersededSessionToken } = await import('../projects/lib/heal-session-token');
const { startSession } = await import('../projects/session-lifecycle/start-session');

type Row = Record<string, unknown>;
const rows = (result: unknown) => ((result as { rows?: Row[] }).rows ?? result) as Row[];

const MIGRATION_REVOKE = '2026-09-18T17:57:00Z';
const OWNER = crypto.randomUUID();
const BANNED = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
let project: SeededProject;
const sessions: string[] = [];

interface Fixture {
  sessionId: string;
  /** Secret the box holds; the row records it as `config.serviceKey`. */
  secret: string;
  tokenId: string;
}

/** A session whose box key is a session token revoked by the migration. */
async function fixture(opts: { userId?: string; revokedAt?: string; recordKey?: boolean; tombstone?: boolean } = {}): Promise<Fixture> {
  const sessionId = crypto.randomUUID();
  const userId = opts.userId ?? OWNER;
  await db.execute(sql`
    insert into kortix.project_sessions (session_id, account_id, project_id, branch_name, agent_name, status, created_by, metadata)
    values (${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid, ${sessionId}, 'default', 'stopped', ${userId}::uuid,
            ${JSON.stringify(opts.tombstone ? { deletedAt: '2026-09-30T00:00:00Z' } : {})}::jsonb)`);
  const token = await createAccountToken({
    accountId: project.account_id,
    userId,
    projectId: project.project_id,
    name: `Session ${sessionId.slice(0, 8)}`,
    sessionId,
    agentGrant: null,
  } as never);
  await db.execute(sql`
    insert into kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, external_id, provider, status, config)
    values (${sessionId}::uuid, ${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
            ${`sbx_heal_${sessionId.slice(0, 8)}`}, 'daytona', 'stopped',
            ${JSON.stringify({ serviceKey: opts.recordKey === false ? 'kortix_pat_some_other_key_value_0000' : token.secretKey })}::jsonb)`);
  await db.execute(sql`
    update kortix.account_tokens set status = 'revoked', revoked_at = ${opts.revokedAt ?? MIGRATION_REVOKE}::timestamptz
     where token_id = ${token.tokenId}::uuid`);
  sessions.push(sessionId);
  return { sessionId, secret: token.secretKey, tokenId: token.tokenId };
}

async function live(tokenId: string): Promise<boolean> {
  const [row] = rows(await db.execute(sql`select status, revoked_at from kortix.account_tokens where token_id = ${tokenId}::uuid`));
  return row!.status === 'active' && row!.revoked_at === null;
}

beforeAll(async () => {
  project = await seedProject('heal-box-token-test');
  await db.execute(sql`
    insert into auth.users (id, email, banned_until) values
      (${OWNER}::uuid, ${`heal-owner-${OWNER}@example.com`}, null),
      (${BANNED}::uuid, ${`heal-banned-${BANNED}@example.com`}, now() + interval '1 day'),
      (${OUTSIDER}::uuid, ${`heal-outsider-${OUTSIDER}@example.com`}, null)
    on conflict do nothing`);
  await insertIntoView(db, accountMembers, [
    { accountId: project.account_id, userId: OWNER, accountRole: 'owner' },
    { accountId: project.account_id, userId: BANNED, accountRole: 'member' },
  ]);
});

afterAll(async () => {
  for (const id of sessions) {
    await db.execute(sql`update kortix.project_sessions set metadata = metadata || '{"deletedAt":"cleanup"}'::jsonb where session_id = ${id}`);
    await db.execute(sql`delete from kortix.session_sandboxes where sandbox_id = ${id}::uuid`);
    await db.execute(sql`delete from kortix.account_tokens where session_id = ${id}`);
    await db.execute(sql`delete from kortix.project_sessions where session_id = ${id}`);
  }
  await deleteFromView(db, accountMembers, sql`account_id = ${project.account_id}::uuid`);
  await removeSeeded([project]);
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${BANNED}::uuid, ${OUTSIDER}::uuid)`);
});

describe('healSupersededSessionToken', () => {
  test('reactivates the revoked token that is the box identity key', async () => {
    const f = await fixture();
    expect(await live(f.tokenId)).toBe(false);
    expect(await healSupersededSessionToken(f.sessionId)).toBe(f.tokenId);
    expect(await live(f.tokenId)).toBe(true);
  });

  test('is idempotent: a second call finds nothing to heal', async () => {
    const f = await fixture();
    await healSupersededSessionToken(f.sessionId);
    expect(await healSupersededSessionToken(f.sessionId)).toBeNull();
  });

  test('refuses a deleted (tombstoned) session', async () => {
    const f = await fixture({ tombstone: true });
    expect(await healSupersededSessionToken(f.sessionId)).toBeNull();
    expect(await live(f.tokenId)).toBe(false);
  });

  test('refuses a token that is not the recorded box key', async () => {
    const f = await fixture({ recordKey: false });
    expect(await healSupersededSessionToken(f.sessionId)).toBeNull();
    expect(await live(f.tokenId)).toBe(false);
  });

  test('refuses a token that belongs to another session', async () => {
    const a = await fixture();
    const b = await fixture();
    // Session B records session A's secret as its box key.
    await db.execute(sql`
      update kortix.session_sandboxes set config = ${JSON.stringify({ serviceKey: a.secret })}::jsonb
       where sandbox_id = ${b.sessionId}::uuid`);
    expect(await healSupersededSessionToken(b.sessionId)).toBeNull();
    expect(await live(a.tokenId)).toBe(false);
  });

  test('refuses a revoke made on or after the ship cutoff (a deliberate revoke)', async () => {
    const f = await fixture({ revokedAt: new Date().toISOString() });
    expect(await healSupersededSessionToken(f.sessionId)).toBeNull();
    expect(await live(f.tokenId)).toBe(false);
  });

  test('refuses a user that no longer exists', async () => {
    const f = await fixture({ userId: crypto.randomUUID() });
    expect(await healSupersededSessionToken(f.sessionId)).toBeNull();
    expect(await live(f.tokenId)).toBe(false);
  });

  test('refuses a banned user', async () => {
    const f = await fixture({ userId: BANNED });
    expect(await healSupersededSessionToken(f.sessionId)).toBeNull();
    expect(await live(f.tokenId)).toBe(false);
  });

  test('refuses a user who is no longer a member of the account', async () => {
    const f = await fixture({ userId: OUTSIDER });
    expect(await healSupersededSessionToken(f.sessionId)).toBeNull();
    expect(await live(f.tokenId)).toBe(false);
  });

  test('refuses a session without a recorded box key', async () => {
    const f = await fixture();
    await db.execute(sql`update kortix.session_sandboxes set config = '{}'::jsonb where sandbox_id = ${f.sessionId}::uuid`);
    expect(await healSupersededSessionToken(f.sessionId)).toBeNull();
    expect(await live(f.tokenId)).toBe(false);
  });
});

describe('startSession', () => {
  test('heals the box token before it opens the runtime', async () => {
    const f = await fixture();
    await startSession({
      source: 'ui',
      loaded: { row: { accountId: project.account_id }, userId: OWNER },
      visible: { row: { metadata: {} } },
      projectId: project.project_id,
      sessionId: f.sessionId,
      waitMs: 0,
    } as never);
    expect(await live(f.tokenId)).toBe(true);
  });
});
