/**
 * BOUNDED SANDBOX LIFETIME — the single writer's SQL.
 *
 * These tests read the statement text that reaches Postgres, because the
 * properties that matter here are properties OF THE STATEMENT, not of a return
 * value:
 *
 *   - every write is a SINGLE MONOTONE statement (GREATEST/LEAST), so a
 *     concurrent writer cannot lose an update — the class of bug that had to be
 *     fixed in applyStoppedState's jsonb merge;
 *   - every extension is clamped by `active_since + cap` IN SQL, so the DB
 *     CHECK stays unreachable in normal operation;
 *   - the shortening statement is STRUCTURALLY INCAPABLE of extending;
 *   - no arithmetic is done in Node — no computed instants cross the wire, so
 *     API-instance clock skew cannot move a deadline.
 *
 * The migration integration test (packages/db) covers what Postgres then DOES
 * with these statements against real rows and real triggers.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const captured: CapturedQuery[] = [];

/**
 * Flatten drizzle's `sql` template into text + params.
 *
 * Recursive because `writeExtension` composes a nested `sql` fragment for the
 * WHERE target. A StringChunk carries `value: string[]`; a Param carries a bare
 * `value`; a nested SQL carries `queryChunks`. Anything else is a raw
 * interpolated value and becomes a parameter.
 */
function flatten(node: unknown, out: { sql: string; params: unknown[] }): void {
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.queryChunks)) {
      for (const child of record.queryChunks) flatten(child, out);
      return;
    }
    if (Array.isArray(record.value) && record.value.every((v) => typeof v === 'string')) {
      out.sql += (record.value as string[]).join('');
      return;
    }
    if ('value' in record) {
      out.params.push(record.value);
      out.sql += '?';
      return;
    }
  }
  out.params.push(node);
  out.sql += '?';
}

mock.module('../../shared/db', () => ({
  db: {
    execute: async (query: unknown) => {
      const out = { sql: '', params: [] as unknown[] };
      flatten(query, out);
      captured.push(out);
      return [];
    },
  },
}));

const { anchorDeadline, extendDeadline, shortenDeadline } = await import('./deadline');
const { observeControlPlaneEvent } = await import('./observation');
const { ABSOLUTE_RUN_CAP_MS, TURN_CEILING_MS, POST_TURN_GRACE_MS } = await import('./constants');

const proof = observeControlPlaneEvent();

beforeEach(() => {
  captured.length = 0;
});

function only(): CapturedQuery {
  expect(captured).toHaveLength(1);
  const query = captured[0];
  if (!query) throw new Error('no statement was captured');
  return query;
}

describe('extendDeadline — the extending statement', () => {
  test('is monotone: GREATEST against the current value, so a concurrent write cannot be lost', async () => {
    await extendDeadline({ sandboxId: 'box-1' }, TURN_CEILING_MS, proof);
    expect(only().sql).toContain('GREATEST(s.deadline_at, now()');
  });

  test('is clamped by active_since + the absolute cap, so the DB CHECK stays unreachable', async () => {
    await extendDeadline({ sandboxId: 'box-1' }, TURN_CEILING_MS, proof);
    const { sql, params } = only();
    expect(sql).toContain('LEAST(');
    expect(sql).toContain('s.active_since + make_interval');
    expect(params).toContain(ABSOLUTE_RUN_CAP_MS / 1000);
  });

  test('never assigns active_since — the anchor belongs to the DB trigger alone', async () => {
    await extendDeadline({ sandboxId: 'box-1' }, TURN_CEILING_MS, proof);
    // It may READ active_since (that is the cap operand); it must never SET it.
    expect(only().sql).not.toMatch(/SET[\s\S]*active_since\s*=/);
  });

  test('does the arithmetic in Postgres: an INTERVAL crosses the wire, never an instant', async () => {
    await extendDeadline({ sandboxId: 'box-1' }, TURN_CEILING_MS, proof);
    const { sql, params } = only();
    expect(sql).toContain('now() + make_interval');
    expect(params).toContain(TURN_CEILING_MS / 1000);
    // A Date parameter would mean a Node clock reached the money path.
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });

  test('touches only rows that can still be running', async () => {
    await extendDeadline({ sandboxId: 'box-1' }, TURN_CEILING_MS, proof);
    expect(only().sql).toContain("s.status IN ('active', 'provisioning')");
  });

  test('targets by sandbox id or by session id, and parameterises both', async () => {
    await extendDeadline({ sandboxId: 'box-1' }, TURN_CEILING_MS, proof);
    expect(only().sql).toContain('s.sandbox_id = ?::uuid');
    expect(only().params).toContain('box-1');
    captured.length = 0;
    await extendDeadline({ sessionId: 'sess-1' }, TURN_CEILING_MS, proof);
    expect(only().sql).toContain('s.session_id = ?');
    expect(only().params).toContain('sess-1');
  });
});

describe('anchorDeadline — a new running stretch', () => {
  test('emits the same monotone, capped statement as an extension', async () => {
    await anchorDeadline('box-1', TURN_CEILING_MS, proof);
    const { sql } = only();
    expect(sql).toContain('GREATEST(s.deadline_at, now()');
    expect(sql).toContain('LEAST(');
    expect(sql).not.toMatch(/SET[\s\S]*active_since\s*=/);
  });
});

describe('shortenDeadline — the one sandbox-reportable write', () => {
  test('is STRUCTURALLY incapable of extending: LEAST only, no GREATEST', async () => {
    await shortenDeadline({ sessionId: 'sess-1' }, POST_TURN_GRACE_MS);
    const { sql } = only();
    expect(sql).toContain('LEAST(s.deadline_at, now()');
    expect(sql).not.toContain('GREATEST');
  });

  test('needs no cap and no anchor, because it cannot raise the value', async () => {
    await shortenDeadline({ sessionId: 'sess-1' }, POST_TURN_GRACE_MS);
    expect(only().sql).not.toContain('active_since');
  });

  test('only shortens a box that is actually running', async () => {
    await shortenDeadline({ sessionId: 'sess-1' }, POST_TURN_GRACE_MS);
    expect(only().sql).toContain("s.status = 'active'");
  });

  test('takes no proof parameter — provenance is irrelevant when extension is impossible', () => {
    expect(shortenDeadline.length).toBe(2);
  });
});
