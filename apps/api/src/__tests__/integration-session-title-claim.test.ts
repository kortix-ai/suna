/**
 * Integration test (real local DB): the title UPDATE is a compare-and-set over
 * an atomic jsonb merge.
 *
 * Moving titling to create time puts the write exactly inside the window where
 * the remote-branch publisher and the start-timeline writer commit their own
 * metadata. A read-modify-write of the whole metadata
 * object would clobber, or be clobbered by, any of them — and would let a late
 * duplicate overwrite a user rename. These tests pin both halves: the WHERE
 * clause (first-writer-wins) and the merge expression (no key loss).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import type { ProjectSessionRow } from '../projects/lib/serializers';
import { projectSessionMetadataMerge } from '../projects/lib/session-metadata-merge';
import { persistTitle } from '../projects/session-title-generate';
import { db } from '../shared/db';
import { getPublicSessionInfo } from '../shared/public-session-share-view';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();

let n = 0;
async function seed(metadata: Record<string, unknown>): Promise<ProjectSessionRow> {
  n += 1;
  const sessionId = `title-cas-${n}-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sessionId,
    createdBy: USER,
    metadata,
  });
  return { sessionId, accountId: ACCOUNT, projectId: PROJECT, metadata } as ProjectSessionRow;
}

async function metadataOf(sessionId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId));
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'title-cas-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p',
    repoUrl: 'https://example.com/p.git',
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades sessions
});

describe('persistTitle — compare-and-set', () => {
  test('two concurrent writers: exactly one title lands, and it never flip-flops', async () => {
    const row = await seed({});
    await Promise.all([persistTitle(row, 'First Title'), persistTitle(row, 'Second Title')]);
    const name = (await metadataOf(row.sessionId)).name as string;
    expect(['First Title', 'Second Title']).toContain(name);

    // A late duplicate arriving after the row is titled is a no-op.
    await persistTitle(row, 'Late Duplicate');
    expect((await metadataOf(row.sessionId)).name).toBe(name);
  });

  test('a user rename (custom_name) is never overwritten', async () => {
    const row = await seed({ custom_name: 'My Own Name' });
    await persistTitle(row, 'Generated Title');
    const metadata = await metadataOf(row.sessionId);
    expect(metadata.name).toBeUndefined();
    expect(metadata.custom_name).toBe('My Own Name');
  });

  test('a real existing title is never overwritten', async () => {
    const row = await seed({ name: 'Set Up MS Graph' });
    await persistTitle(row, 'Generated Title');
    expect((await metadataOf(row.sessionId)).name).toBe('Set Up MS Graph');
  });

  test("opencode's frozen placeholder IS overwritten", async () => {
    const row = await seed({ name: 'New session - Jul 29' });
    await persistTitle(row, 'Generated Title');
    expect((await metadataOf(row.sessionId)).name).toBe('Generated Title');

    const veyris = await seed({ name: 'New agent' });
    await persistTitle(veyris, 'Generated Veyris Title');
    expect((await metadataOf(veyris.sessionId)).name).toBe('Generated Veyris Title');

    // …but a real title that merely starts with the word "New" is not.
    const near = await seed({ name: 'New sessions of work' });
    await persistTitle(near, 'Generated Title');
    expect((await metadataOf(near.sessionId)).name).toBe('New sessions of work');
  });

  test('a blank/whitespace name counts as untitled', async () => {
    const row = await seed({ name: '   ' });
    await persistTitle(row, 'Generated Title');
    expect((await metadataOf(row.sessionId)).name).toBe('Generated Title');

    // PostgreSQL's bare trim() strips SPACES only. Trimming a narrower set than
    // JavaScript's String.trim() here makes the CAS refuse rows that the TS
    // `needsTitle` gate already waved through — a silent, billed, forever loop.
    const tabbed = await seed({ name: '\n\t New session - Jul 29 \r\n' });
    await persistTitle(tabbed, 'Generated Title');
    expect((await metadataOf(tabbed.sessionId)).name).toBe('Generated Title');

    const onlyWhitespace = await seed({ name: '\n\t\r ' });
    await persistTitle(onlyWhitespace, 'Generated Title');
    expect((await metadataOf(onlyWhitespace.sessionId)).name).toBe('Generated Title');
  });

  test('a NON-STRING name/custom_name reads as set — the same way needsTitle reads it', async () => {
    // `metadata->>'x'` stringifies any jsonb scalar. The TS predicate reads it
    // the same way, so neither of these ever reaches the gateway; if one did,
    // this UPDATE would no-op and the cycle would repeat on every prompt.
    const numericName = await seed({ name: 123 });
    await persistTitle(numericName, 'Generated Title');
    expect((await metadataOf(numericName.sessionId)).name).toBe(123);

    const numericCustom = await seed({ custom_name: 123 });
    await persistTitle(numericCustom, 'Generated Title');
    expect((await metadataOf(numericCustom.sessionId)).name).toBeUndefined();
  });

  test('no clobber: a concurrent full-metadata write survives with the title', async () => {
    const row = await seed({ runtime_transport: 'rest', provider_session_id: 'provider-1' });

    // Race a full metadata rewrite against persistTitle to verify both writes.
    const claimIdentity = db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, row.sessionId))
        .for('update');
      await tx
        .update(projectSessions)
        .set({
          metadata: {
            ...((locked?.metadata ?? {}) as Record<string, unknown>),
            sync_checkpoint: 'checkpoint-9',
          },
        })
        .where(eq(projectSessions.sessionId, row.sessionId));
    });

    await Promise.all([claimIdentity, persistTitle(row, 'Generated Title')]);

    const metadata = await metadataOf(row.sessionId);
    expect(metadata.sync_checkpoint).toBe('checkpoint-9');
    expect(metadata.name).toBe('Generated Title');
    expect(metadata.provider_session_id).toBe('provider-1');
  });

  test('no clobber: the provisioning_error merge preserves a title written after insert', async () => {
    // sessions.ts used to write `{ ...createTimeMetadata, provisioning_error }`,
    // which erased anything (title included) landing between insert and failure.
    const row = await seed({ runtime_transport: 'rest' });
    await persistTitle(row, 'Generated Title');
    await db
      .update(projectSessions)
      .set({ metadata: projectSessionMetadataMerge({ provisioning_error: 'boom' }) })
      .where(eq(projectSessions.sessionId, row.sessionId));

    const metadata = await metadataOf(row.sessionId);
    expect(metadata.name).toBe('Generated Title');
    expect(metadata.provisioning_error).toBe('boom');
    expect(metadata.runtime_transport).toBe('rest');
  });

  test('the CAS is scoped to the exact session/project/account triple', async () => {
    const row = await seed({});
    await persistTitle({ ...row, accountId: crypto.randomUUID() } as ProjectSessionRow, 'Wrong');
    expect((await metadataOf(row.sessionId)).name).toBeUndefined();
  });

  test('the placeholder predicate runs case-insensitively in Postgres', async () => {
    const [check] = await db.execute(
      sql`select ('new SESSION x' ~* '^new session([^[:alnum:]_]|$)')::bool as hit`,
    );
    expect((check as { hit: boolean }).hit).toBe(true);
  });
});

describe('getPublicSessionInfo — the anonymous share viewer sees the same title chain', () => {
  test('nulls the frozen placeholder, keeps a real title, and custom_name still wins', async () => {
    const placeholder = await seed({ name: 'New session - Jul 29' });
    const generated = await seed({ name: 'Set Up MS Graph' });
    const renamed = await seed({ name: 'Set Up MS Graph', custom_name: 'Mine' });

    const titleOf = async (sessionId: string) => {
      const result = await getPublicSessionInfo(sessionId);
      expect(result.ok).toBe(true);
      return result.ok ? result.session.title : undefined;
    };

    expect(await titleOf(placeholder.sessionId)).toBeNull();
    expect(await titleOf(generated.sessionId)).toBe('Set Up MS Graph');
    expect(await titleOf(renamed.sessionId)).toBe('Mine');
  });
});
