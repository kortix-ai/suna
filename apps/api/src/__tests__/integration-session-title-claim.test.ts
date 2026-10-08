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

import {
  PLACEHOLDER_TITLE_SQL_PATTERN,
  isPlaceholderOpencodeTitle,
} from '../projects/lib/opencode-title';
import type { ProjectSessionRow } from '../projects/lib/serializers';
import { transitionSession } from '../projects/session-lifecycle/status-transitions';
import { persistTitle } from '../projects/session-title-generate';
import { db } from '../shared/db';
import { getPublicSessionInfo } from '../shared/public-session-share-view';

const { writeRuntimeSessionList } = await import('../projects/lib/runtime-session-snapshot');
const { saveRuntimeProjection } = await import('../projects/lib/session-runtime-projection');

// The state document a running sandbox reported.
const projection = { sessions: { known: true, value: [{ id: 'ses_root', title: 'Runtime Title', parent_id: null }] } };

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();

let n = 0;
async function seed(
  metadata: Record<string, unknown>,
  status: (typeof projectSessions.$inferInsert)['status'] = undefined,
): Promise<ProjectSessionRow> {
  n += 1;
  const sessionId = `title-cas-${n}-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sessionId,
    createdBy: USER,
    metadata,
    ...(status ? { status } : {}),
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

    const agentPlaceholder = await seed({ name: 'New agent' });
    await persistTitle(agentPlaceholder, 'Generated Agent Title');
    expect((await metadataOf(agentPlaceholder.sessionId)).name).toBe('Generated Agent Title');

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

  test('no clobber: a create failure keeps a title written after insert', async () => {
    // sessions.ts used to write `{ ...createTimeMetadata, provisioning_error }`,
    // which erased anything (title included) landing between insert and failure.
    // It now fails the session through the `fail` transition, as here.
    const row = await seed({ runtime_transport: 'rest' }, 'running');
    await persistTitle(row, 'Generated Title');
    expect(
      await transitionSession('fail', row.sessionId, {
        error: 'boom',
        metadata: { provisioning_error: 'boom' },
      }),
    ).toBe(true);

    const metadata = await metadataOf(row.sessionId);
    expect(metadata.name).toBe('Generated Title');
    expect(metadata.provisioning_error).toBe('boom');
    expect(metadata.runtime_transport).toBe('rest');
  });

  // The list write runs beside title generation. It merges in SQL, so a title
  // committed after the session was created survives it.
  test('no clobber: the opencode_sessions list write keeps a title committed before it', async () => {
    const row = await seed({ runtime_transport: 'rest' });
    await persistTitle(row, 'Generated Title');

    expect(
      await writeRuntimeSessionList({
        sessionId: row.sessionId,
        projectId: row.projectId,
        accountId: row.accountId,
        projection,
        runtimeSessionId: 'ses_root',
      }),
    ).toBe('written');

    const metadata = await metadataOf(row.sessionId);
    expect(metadata.name).toBe('Generated Title');
    expect(metadata.runtime_transport).toBe('rest');
    expect(metadata.opencode_sessions).toEqual([
      {
        id: 'ses_root',
        title: 'Runtime Title',
        parent_id: null,
        project_id: null,
        created_at: null,
        updated_at: null,
        archived_at: null,
      },
    ]);
  });

  test('the CAS is scoped to the exact session/project/account triple', async () => {
    const row = await seed({});
    await persistTitle({ ...row, accountId: crypto.randomUUID() } as ProjectSessionRow, 'Wrong');
    expect((await metadataOf(row.sessionId)).name).toBeUndefined();
  });
});

// The CAS matches placeholders with this SQL pattern; the TS `needsTitle` gate
// uses `isPlaceholderOpencodeTitle`. If they disagree, the gate sends a row to
// the gateway that the UPDATE then refuses: a billed title on every prompt.
describe('PLACEHOLDER_TITLE_SQL_PATTERN agrees with isPlaceholderOpencodeTitle in PostgreSQL', () => {
  test.each([
    'New session',
    'New session - Jul 29',
    'new SESSION x',
    'New session_x',
    'NEW SESSION',
    '  New session - 2026-07-28  ',
    'New sessions of work',
    'Newsession',
    'New session planning doc',
    'New agent',
    'NEW AGENT',
    'New agent - Aug 3',
    'New agents at work',
    'New agent planning doc',
    'Set Up MS Graph',
    '',
  ])('%p', async (title) => {
    const [check] = await db.execute(
      sql`select (btrim(${title}::text) ~* ${PLACEHOLDER_TITLE_SQL_PATTERN})::bool as hit`,
    );
    expect((check as { hit: boolean }).hit).toBe(isPlaceholderOpencodeTitle(title));
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

// R7.4: the list follows every stored projection, scoped to the session's root.
describe('writeRuntimeSessionList', () => {
  const conv = (id: string, parent: string | null, updated: number) => ({ id, title: id, parent_id: parent, time: { created: 1, updated } });
  const doc = (...value: unknown[]) => ({ sessions: { known: true, value } });
  const write = (row: ProjectSessionRow, projection: Record<string, unknown>, runtimeSessionId: string | null) =>
    writeRuntimeSessionList({ sessionId: row.sessionId, projectId: row.projectId, accountId: row.accountId, projection, runtimeSessionId });

  test('the root and its children, newest first; another root and an unchanged list write nothing', async () => {
    const row = await seed({});
    const tree = doc(conv('ses_a', null, 2), conv('ses_a_kid', 'ses_a', 9), conv('ses_other', null, 5));
    expect(await write(row, tree, 'ses_a')).toBe('written');
    expect(((await metadataOf(row.sessionId)).opencode_sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['ses_a_kid', 'ses_a']);
    expect(await write(row, tree, 'ses_a')).toBe('unchanged');
  });

  test('storing a projection writes the list; an out-of-order capture writes neither', async () => {
    const row = await seed({});
    const save = (capturedAt: string, projection: Record<string, unknown>) =>
      saveRuntimeProjection({
        sessionId: row.sessionId,
        projectId: row.projectId,
        accountId: row.accountId,
        externalId: 'box-1',
        projectionEtag: `etag-${capturedAt}`,
        projection: { ...projection, identity: { harness: 'pi', runtime_session_id: 'ses_r' } },
        capturedAt: new Date(capturedAt),
        source: 'daemon_push',
      });
    expect(await save('2026-10-08T10:00:00.000Z', doc(conv('ses_r', null, 1), conv('ses_r_kid', 'ses_r', 4)))).toBe('stored');
    expect(((await metadataOf(row.sessionId)).opencode_sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['ses_r_kid', 'ses_r']);
    expect(await save('2026-10-08T09:00:00.000Z', doc(conv('ses_r', null, 1)))).toBe('ignored');
    expect(((await metadataOf(row.sessionId)).opencode_sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['ses_r_kid', 'ses_r']);
  });

  test('a pinned session ignores a document for another root, and a document that does not know its sessions', async () => {
    const row = await seed({});
    await db.update(projectSessions).set({ runtimeSessionId: 'ses_pinned' }).where(eq(projectSessions.sessionId, row.sessionId));
    expect(await write(row, doc(conv('ses_new', null, 1)), 'ses_new')).toBe('skipped');
    expect(await write(row, { sessions: { known: false, value: [] } }, 'ses_pinned')).toBe('skipped');
    expect((await metadataOf(row.sessionId)).opencode_sessions).toBeUndefined();
    // With the pin and no root in the document, the pin scopes it.
    expect(await write(row, doc(conv('ses_pinned', null, 1), conv('ses_kid', 'ses_pinned', 3)), null)).toBe('written');
    expect(((await metadataOf(row.sessionId)).opencode_sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['ses_kid', 'ses_pinned']);
  });
});
