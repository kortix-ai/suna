/**
 * Integration test (real local DB): a query that reads a column of ANOTHER row
 * must be correlated to THAT row, never to whatever row Postgres returns first.
 *
 * INC-2026-09-15-CROSS-TENANT-AGENT-GRANT. `loadSandbox` computed `agentName`
 * with a Drizzle `sql` subquery that interpolated `projectSessions.sessionId`
 * and `sessionSandboxes.sessionId`. In a single-table select Drizzle renders
 * both as the bare `"session_id"`, so Postgres evaluated
 * `where "session_id" = "session_id"` against the inner table — always true —
 * and `limit 1` answered an arbitrary tenant's agent. A prompt with no `agent`
 * in its body then re-minted the session token to that foreign agent.
 *
 * Each case uses rows with DIFFERENT agent names, so an uncorrelated subquery
 * cannot pass by returning one arbitrary row for all of them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { loadSandbox } from '../sandbox-proxy/backend';
import { db } from '../shared/db';
import { removeSeeded, seedProject } from './helpers/integration-fixtures';

const run = crypto.randomUUID().slice(0, 8);
const fixtures = {
  sessionIds: [] as string[],
  sandboxIds: [] as string[],
};

interface ProjectRow {
  project_id: string;
  account_id: string;
}

let projectsForTest: ProjectRow[] = [];

async function insertSession(input: {
  project: ProjectRow;
  agentName: string;
  status: string;
  updatedAt?: string;
}): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.execute(sql`
    insert into kortix.project_sessions
      (session_id, account_id, project_id, branch_name, agent_name, status, updated_at)
    values
      (${sessionId}, ${input.project.account_id}::uuid, ${input.project.project_id}::uuid,
       ${sessionId}, ${input.agentName}, ${input.status}::kortix.project_session_status,
       ${input.updatedAt ?? new Date().toISOString()}::timestamptz)
  `);
  fixtures.sessionIds.push(sessionId);
  return sessionId;
}

async function insertSandbox(input: {
  project: ProjectRow;
  sessionId: string;
  externalId: string;
  status: string;
}): Promise<void> {
  const sandboxId = crypto.randomUUID();
  await db.execute(sql`
    insert into kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, external_id, status)
    values
      (${sandboxId}::uuid, ${input.sessionId}, ${input.project.account_id}::uuid,
       ${input.project.project_id}::uuid, ${input.externalId},
       ${input.status}::kortix.session_sandbox_status)
  `);
  fixtures.sandboxIds.push(sandboxId);
}

beforeAll(async () => {
  // Two tenants: each project in its own synthetic account.
  projectsForTest = [
    await seedProject(`iso-a-${run}`),
    await seedProject(`iso-b-${run}`),
  ];
});

afterAll(async () => {
  // `guard_session_sandbox_identity` refuses to delete a sandbox row whose
  // session is not tombstoned, so tombstone first, then delete in FK order.
  for (const sessionId of fixtures.sessionIds) {
    await db.execute(sql`
      update kortix.project_sessions
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('deletedAt', now()::text)
       where session_id = ${sessionId}
    `);
  }
  for (const sandboxId of fixtures.sandboxIds) {
    await db.execute(
      sql`delete from kortix.session_sandboxes where sandbox_id = ${sandboxId}::uuid`,
    );
  }
  for (const sessionId of fixtures.sessionIds) {
    await db.execute(sql`delete from kortix.project_sessions where session_id = ${sessionId}`);
  }
  await removeSeeded(projectsForTest);
});

describe('correlated reads stay on their own row', () => {
  test('loadSandbox answers each sandbox with ITS OWN session agent', async () => {
    expect(projectsForTest.length).toBe(2);
    const [projectA, projectB] = projectsForTest as [ProjectRow, ProjectRow];

    const sessionA = await insertSession({
      project: projectA,
      agentName: `iso-a-${run}`,
      status: 'running',
    });
    const sessionB = await insertSession({
      project: projectB,
      agentName: `iso-b-${run}`,
      status: 'running',
    });
    await insertSandbox({
      project: projectA,
      sessionId: sessionA,
      externalId: `sbx_iso_a_${run}`,
      status: 'active',
    });
    await insertSandbox({
      project: projectB,
      sessionId: sessionB,
      externalId: `sbx_iso_b_${run}`,
      status: 'active',
    });

    const recordA = await loadSandbox(`sbx_iso_a_${run}`);
    const recordB = await loadSandbox(`sbx_iso_b_${run}`);

    expect(recordA?.sessionId).toBe(sessionA);
    expect(recordA?.agentName).toBe(`iso-a-${run}`);
    expect(recordB?.sessionId).toBe(sessionB);
    expect(recordB?.agentName).toBe(`iso-b-${run}`);
  });

  test('loadSandbox keeps the agent on the case-insensitive fallback path', async () => {
    const [projectA] = projectsForTest as [ProjectRow];
    const session = await insertSession({
      project: projectA,
      agentName: `iso-c-${run}`,
      status: 'running',
    });
    await insertSandbox({
      project: projectA,
      sessionId: session,
      externalId: `SBX_ISO_C_${run}`,
      status: 'active',
    });

    const record = await loadSandbox(`sbx_iso_c_${run}`.toLowerCase());
    expect(record?.sessionId).toBe(session);
    expect(record?.agentName).toBe(`iso-c-${run}`);
    // The canonical provider id, never the lowercased request: every gate
    // after this one keys on it.
    expect(record?.externalId).toBe(`SBX_ISO_C_${run}`);
  });

  // A failed provision can leave older rows on the same provider id. The
  // proxy must route to the row that owns the box now.
  test('loadSandbox prefers the active row over a more recently touched failed row', async () => {
    const [projectA] = projectsForTest as [ProjectRow];
    const failedSession = await insertSession({
      project: projectA,
      agentName: `iso-failed-${run}`,
      status: 'running',
    });
    const liveSession = await insertSession({
      project: projectA,
      agentName: `iso-live-${run}`,
      status: 'running',
    });
    await insertSandbox({
      project: projectA,
      sessionId: liveSession,
      externalId: `sbx_iso_shared_${run}`,
      status: 'active',
    });
    await insertSandbox({
      project: projectA,
      sessionId: failedSession,
      externalId: `sbx_iso_shared_${run}`,
      status: 'error',
    });
    await db.execute(sql`
      update kortix.session_sandboxes set updated_at = now() + interval '1 minute'
       where session_id = ${failedSession}`);

    const record = await loadSandbox(`sbx_iso_shared_${run}`);
    expect(record?.sessionId).toBe(liveSession);
    expect(record?.status).toBe('active');
  });
});
