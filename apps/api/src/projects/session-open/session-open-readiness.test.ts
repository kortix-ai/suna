/**
 * The unreachable warn rides the SPELL, not the cause flip.
 *
 * KRTX-696 (2026-10-04): a cold wake fails its first session-list probes with
 * transient causes that alternate — `timeout_or_network`, then the provider
 * edge's `http_502` for the not-yet-bound port — and the 2026-09-29
 * cause-change gate warned on every flip: 816 warns in one day from 14 boxes,
 * consecutive flips 11 s apart, 73% of spells over in under 30 s. The gate is
 * now the spell clock the open path already budgets (30 s): a spell the
 * budget itself calls still-booting is not a fault, and a spell that outlives
 * it warns once. The durable row stamp keeps recording every cause change.
 */

import { describe, expect, afterAll, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sessionSandboxes } from '@kortix/db';
import type { UnreachableCause } from '../opencode-mapping';

// Render the written statement through drizzle's own dialect so a test can
// assert WHICH metadata keys a poll merged, not just that a write happened.
const dialect = new PgDialect();
function mergedMetadataOf(query: unknown): Record<string, unknown> {
  const [json] = dialect.sqlToQuery(query as SQL).params;
  // The statement carries exactly one bind parameter: the merged JSON object.
  if (typeof json !== 'string') {
    throw new Error('expected the merged metadata JSON as the one bound parameter');
  }
  return JSON.parse(json);
}

const writes: Array<{ metadata: Record<string, unknown>; rowIds: string[] }> = [];
const warns: unknown[][] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warns.push(args);
};

mock.module('../../shared/db', () => ({
  db: {
    update: () => ({
      set: (patch: { metadata: unknown }) => ({
        where: (condition: unknown) => {
          const { params } = dialect.sqlToQuery(condition as SQL);
          writes.push({
            metadata: mergedMetadataOf(patch.metadata),
            rowIds: params.filter((p): p is string => typeof p === 'string'),
          });
          return Promise.resolve();
        },
      }),
    }),
  },
  hasDatabase: true,
}));

const { stampUnreachableDiagnostics } = await import('./session-open-readiness');

afterAll(() => {
  console.warn = originalWarn;
});

const UUID = '00000000-0000-4000-8000-000000000001';

function row(metadata: Record<string, unknown>): typeof sessionSandboxes.$inferSelect {
  return {
    sandboxId: UUID,
    sessionId: 'sess-1',
    accountId: UUID,
    projectId: UUID,
    provider: 'platinum',
    externalId: 'sbx_1',
    baseUrl: null,
    status: 'active',
    config: {},
    metadata,
    lastUsedAt: null,
    activeSince: new Date(0),
    deadlineAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** One open poll: the row as this poll read it, and the cause the probe reported. */
async function poll(metadata: Record<string, unknown>, cause: UnreachableCause): Promise<void> {
  await stampUnreachableDiagnostics(
    row(metadata),
    { pin: null, changed: true, reason: 'unreachable', cause, responder: 'unnamed' },
    'sbx_1',
  );
}

/** The row the next poll reads: every stamp the last write merged. */
function rowAfterLastWrite(metadata: Record<string, unknown>): Record<string, unknown> {
  return { ...metadata, ...writes[writes.length - 1].metadata };
}

describe('stampUnreachableDiagnostics: the warn rides the spell clock', () => {
  test('a cold wake that flips transient causes inside the budget stays silent', async () => {
    // Poll 1: no spell clock yet (the budget phase stamps it after the
    // diagnostics). Polls 2-3: the clock the previous poll stamped, 3 s old,
    // cause alternating — the exact 2026-10-04 spike shape. Silent; only the
    // durable cause stamp is written.
    writes.length = 0; warns.length = 0;
    const clock = { runtimeUnreachableWaitStartedAt: new Date(Date.now() - 3_000).toISOString() };
    await poll({}, 'timeout_or_network');
    await poll({ ...clock, runtimeUnreachableCause: 'timeout_or_network' }, 'http_502');
    await poll({ ...clock, runtimeUnreachableCause: 'http_502' }, 'timeout_or_network');
    expect(warns).toHaveLength(0);
    expect(writes).toHaveLength(3);
    expect(writes[2].metadata.runtimeUnreachableCause).toBe('timeout_or_network');
    expect(writes[2].rowIds).toEqual([UUID]);
  });

  test('a spell that outlives the budget warns exactly once, then stays silent', async () => {
    // Same cause throughout — the 2026-09-29 gate was silent here, a per-poll
    // gate would warn every 3 s for hours. One warn at the budget crossing,
    // and the mark that keeps the rest of the spell quiet.
    writes.length = 0; warns.length = 0;
    const base = { runtimeUnreachableWaitStartedAt: new Date(Date.now() - 31_000).toISOString() };
    await poll(base, 'http_502');
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toBe('[start] opencode session list unreachable');
    const afterWarn = rowAfterLastWrite(base);
    expect(typeof afterWarn.runtimeUnreachableWarnedAt).toBe('string');

    warns.length = 0; writes.length = 0;
    await poll(afterWarn, 'http_502');
    expect(warns).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test('a spell that flips causes past the budget warns once, not per flip', async () => {
    writes.length = 0; warns.length = 0;
    const base = { runtimeUnreachableWaitStartedAt: new Date(Date.now() - 31_000).toISOString() };
    await poll(base, 'http_502');
    expect(warns).toHaveLength(1);
    const afterWarn = rowAfterLastWrite(base);
    warns.length = 0; writes.length = 0;
    await poll(afterWarn, 'timeout_or_network');
    expect(warns).toHaveLength(0);
    // The durable cause stamp still records the flip.
    expect(writes).toHaveLength(1);
    expect(writes[0].metadata.runtimeUnreachableCause).toBe('timeout_or_network');
  });

  test('a warn mark from a previous spell does not mute the next spell', async () => {
    writes.length = 0; warns.length = 0;
    await poll(
      {
        runtimeUnreachableWaitStartedAt: new Date(Date.now() - 31_000).toISOString(),
        runtimeUnreachableWarnedAt: new Date(Date.now() - 600_000).toISOString(),
      },
      'http_502',
    );
    expect(warns).toHaveLength(1);
  });
});
