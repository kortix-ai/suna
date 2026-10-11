/**
 * Integration test (real local PostgreSQL): the unreachable diagnostics of the
 * session open — the warn rides the SPELL, and the row stamps survive.
 *
 * The unit test (session-open/session-open-readiness.test.ts) mocks the database;
 * this one proves the REAL write path: the SQL merge lands on the row, a
 * concurrent writer's keys survive it, and the warn mark and cause stamps read
 * back exactly as the next poll of the same spell will see them.
 *
 * KRTX-696 (2026-10-04): a cold wake alternates `timeout_or_network` /
 * `http_502` every ~11 s and heals inside the 30 s ride-out budget; the
 * cause-change gate warned on every flip (816 warns in one day). The gate is
 * now the spell clock the boot budget already enforces.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const { stampUnreachableDiagnostics } = await import('../projects/session-open/session-open-readiness');

let project: SeededProject;
const created: string[] = [];

const warns: unknown[][] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warns.push(args);
};

interface Row extends Record<string, unknown> {
  metadata: Record<string, unknown>;
}

async function seedSandbox(metadata: Record<string, unknown>): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.execute(sql`
    insert into kortix.project_sessions
      (session_id, account_id, project_id, branch_name, agent_name, status, error, sandbox_url,
       metadata)
    values
      (${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid, ${sessionId},
       'default', 'running', null, null,
       ${JSON.stringify({})}::jsonb)`);
  await db.execute(sql`
    insert into kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, external_id, provider, status, metadata,
       updated_at)
    values
      (${sessionId}::uuid, ${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
       'sbx_unreachablewarn', 'platinum', 'active',
       ${JSON.stringify(metadata)}::jsonb,
       date_trunc('milliseconds', now()))`);
  created.push(sessionId);
  return sessionId;
}

async function readMetadata(sandboxId: string): Promise<Row> {
  const [sandbox] = rows(
    await db.execute(sql`select metadata from kortix.session_sandboxes where sandbox_id = ${sandboxId}::uuid`),
  );
  return sandbox as Row;
}

function rows(result: unknown): Record<string, unknown>[] {
  return ((result as { rows?: Record<string, unknown>[] }).rows ??
    (result as unknown as Record<string, unknown>[])) as Record<string, unknown>[];
}

/** A write by some OTHER lifecycle writer, landing after a caller read the row. */
async function concurrentMetadataWrite(sandboxId: string, patch: Record<string, unknown>) {
  await db.execute(sql`
    update kortix.session_sandboxes
       set metadata = coalesce(metadata, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
     where sandbox_id = ${sandboxId}::uuid`);
}

async function poll(sandboxId: string, cause: 'timeout_or_network' | 'http_502') {
  const [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sandboxId))
    .limit(1);
  await stampUnreachableDiagnostics(
    { ...row!, externalId: row!.externalId! },
    { pin: null, changed: true, reason: 'unreachable', cause, responder: 'unnamed' },
    row!.externalId!,
  );
}

function warnsSince(count: number): number {
  return warns.length - count;
}

beforeAll(async () => {
  project = await seedProject('unreachable-warn-gate-test');
});

afterAll(async () => {
  console.warn = originalWarn;
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

describe('the unreachable warn gate against the real row', () => {
  test('cause flips inside the ride-out budget warn nothing and still stamp the cause', async () => {
    const sandboxId = await seedSandbox({
      runtimeUnreachableWaitStartedAt: new Date(Date.now() - 3_000).toISOString(),
    });
    const before = warns.length;
    await poll(sandboxId, 'timeout_or_network');
    await poll(sandboxId, 'http_502');
    await poll(sandboxId, 'timeout_or_network');
    expect(warnsSince(before)).toBe(0);
    const { metadata } = await readMetadata(sandboxId);
    expect(metadata.runtimeUnreachableCause).toBe('timeout_or_network');
    expect(typeof metadata.runtimeUnreachableCauseAt).toBe('string');
    expect(metadata.runtimeUnreachableWarnedAt).toBeUndefined();
  });

  test('a spell past the budget warns once; the mark and a concurrent key survive', async () => {
    const spellStart = new Date(Date.now() - 31_000).toISOString();
    const sandboxId = await seedSandbox({ runtimeUnreachableWaitStartedAt: spellStart });
    const before = warns.length;
    await poll(sandboxId, 'http_502');
    expect(warnsSince(before)).toBe(1);
    expect(warns[warns.length - 1][0]).toBe('[start] opencode session list unreachable');
    const afterWarn = await readMetadata(sandboxId);
    expect(typeof afterWarn.metadata.runtimeUnreachableWarnedAt).toBe('string');
    expect(
      Date.parse(String(afterWarn.metadata.runtimeUnreachableWarnedAt)) >=
        Date.parse(spellStart),
    ).toBe(true);
    expect(afterWarn.metadata.runtimeUnreachableCause).toBe('http_502');

    // A writer that landed between this poll's read and its write keeps its key.
    await concurrentMetadataWrite(sandboxId, { unrelatedLifecycleKey: 'keep' });
    const markCount = warns.length;
    await poll(sandboxId, 'http_502');
    expect(warnsSince(markCount)).toBe(0);
    const settled = await readMetadata(sandboxId);
    expect(settled.metadata.unrelatedLifecycleKey).toBe('keep');
    expect(Date.parse(String(settled.metadata.runtimeUnreachableWarnedAt))).toBe(
      Date.parse(String(afterWarn.metadata.runtimeUnreachableWarnedAt)),
    );
  });
});
