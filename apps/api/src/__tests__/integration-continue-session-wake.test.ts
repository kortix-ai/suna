/**
 * Integration test (real local PostgreSQL): the wake `continueSession` applies
 * before it delivers a prompt into a parked session.
 *
 * The delivery flips a `stopped` (or `completed`) session to `running` before
 * it knows whether a runtime can come up. When the delivery then ends with no
 * runtime (`unreachable`, `pending`), the session goes back to the status it
 * woke from. It keeps `running` only when an `active` sandbox row backs it.
 *
 * `openSession` (the /start path) is replaced per case, so each case chooses
 * what the runtime does. Everything else, including every status write, is the
 * shipped code against real rows.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as realShared from '../projects/routes/shared';
import * as realTitle from '../projects/session-title-generate';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

type OpenResult = Record<string, unknown> | null;
let openSessionImpl: (sessionId: string) => Promise<OpenResult> = async () => null;

mock.module('../projects/routes/shared', () => ({
  ...realShared,
  openSession: async (args: { sessionId: string }) => openSessionImpl(args.sessionId),
}));
mock.module('../projects/session-title-generate', () => ({
  ...realTitle,
  generateSessionTitleFromFirstPrompt: async () => undefined,
}));

const { continueSession } = await import('../projects/session-lifecycle/continue-session');

type Row = Record<string, unknown>;
const rows = (result: unknown) => ((result as { rows?: Row[] }).rows ?? result) as Row[];

let project: SeededProject;
const created: string[] = [];

async function fixture(
  sessionStatus: 'stopped' | 'completed',
  sessionMetadata: Row = {},
): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.execute(sql`
    insert into kortix.project_sessions
      (session_id, account_id, project_id, branch_name, agent_name, status, metadata)
    values
      (${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid, ${sessionId},
       'default', ${sessionStatus}::kortix.project_session_status,
       ${JSON.stringify(sessionMetadata)}::jsonb)`);
  await db.execute(sql`
    insert into kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, external_id, provider, status, metadata)
    values
      (${sessionId}::uuid, ${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
       ${`sbx_wake_${sessionId.slice(0, 8)}`}, 'daytona', 'stopped', '{}'::jsonb)`);
  created.push(sessionId);
  return sessionId;
}

async function statuses(sessionId: string): Promise<{ session: string; sandbox: string }> {
  const [session] = rows(
    await db.execute(sql`select status from kortix.project_sessions where session_id = ${sessionId}`),
  );
  const [sandbox] = rows(
    await db.execute(
      sql`select status from kortix.session_sandboxes where sandbox_id = ${sessionId}::uuid`,
    ),
  );
  return { session: session!.status as string, sandbox: sandbox!.status as string };
}

function deliver(sessionId: string) {
  return continueSession({
    source: 'ui',
    sessionId,
    projectId: project.project_id,
    text: 'hello',
    userId: crypto.randomUUID(),
  });
}

beforeAll(async () => {
  project = await seedProject('continue-session-wake-test');
});

afterAll(async () => {
  for (const sessionId of created) {
    await db.execute(sql`
      update kortix.project_sessions
         set metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"cleanup"}'::jsonb
       where session_id = ${sessionId}`);
    await db.execute(
      sql`delete from kortix.session_sandboxes where sandbox_id = ${sessionId}::uuid`,
    );
    await db.execute(sql`delete from kortix.project_sessions where session_id = ${sessionId}`);
  }
  await removeSeeded([project]);
});

describe('the pre-delivery wake', () => {
  test('an unreachable runtime puts the session back to stopped', async () => {
    const sessionId = await fixture('stopped');
    let statusDuringOpen = null as string | null;
    openSessionImpl = async (id) => {
      statusDuringOpen = (await statuses(id)).session;
      return { stage: 'failed', sandbox: null, opencode_session_id: null };
    };
    expect(await deliver(sessionId)).toBe('unreachable');
    // The wake itself still happens: the open ran against a `running` session.
    expect(statusDuringOpen).toBe('running');
    expect(await statuses(sessionId)).toEqual({ session: 'stopped', sandbox: 'stopped' });
  });

  test('a pending delivery puts the session back to stopped', async () => {
    const sessionId = await fixture('stopped');
    // Ready, but with no sandbox to converge: the env sync cannot run and the
    // delivery ends `pending` before any POST.
    openSessionImpl = async () => ({ stage: 'ready', sandbox: null, opencode_session_id: null });
    expect(await deliver(sessionId)).toBe('pending');
    expect((await statuses(sessionId)).session).toBe('stopped');
  });

  test('a completed session goes back to completed', async () => {
    const sessionId = await fixture('completed');
    openSessionImpl = async () => ({ stage: 'failed', sandbox: null, opencode_session_id: null });
    expect(await deliver(sessionId)).toBe('unreachable');
    expect((await statuses(sessionId)).session).toBe('completed');
  });

  test('a session whose box the wake brought up stays running', async () => {
    const sessionId = await fixture('stopped');
    openSessionImpl = async (id) => {
      // The wake finalized: the sandbox row is active. The delivery still ends
      // `pending` (no sandbox in the answer), but a runtime now backs the row.
      await db.execute(
        sql`update kortix.session_sandboxes set status = 'active' where sandbox_id = ${id}::uuid`,
      );
      return { stage: 'ready', sandbox: null, opencode_session_id: null };
    };
    expect(await deliver(sessionId)).toBe('pending');
    expect(await statuses(sessionId)).toEqual({ session: 'running', sandbox: 'active' });
  });

  // A deleted session keeps its row, `stopped`, with `metadata.deletedAt`. A
  // late prompt (a trigger fire, a retry) must never wake it back up.
  test('a deleted session is never woken, and its runtime is never opened', async () => {
    const sessionId = await fixture('stopped', { deletedAt: '2026-09-25T10:00:00.000Z' });
    let opened = false;
    openSessionImpl = async () => {
      opened = true;
      return { stage: 'ready', sandbox: null, opencode_session_id: null };
    };
    expect(await deliver(sessionId)).toBe('no-session');
    expect(opened).toBe(false);
    expect((await statuses(sessionId)).session).toBe('stopped');
  });
});
