import { describe, expect, test } from 'bun:test';

import {
  collectSessionPage,
  encodeSessionCursor,
  parseSessionCursor,
  parseSessionPageLimit,
  type SessionCursor,
} from './session-page';

interface FakeRow {
  id: string;
  visible: boolean;
}

/** `count` rows, newest first, each with a distinct microsecond cursor. */
function rows(count: number, visible: (index: number) => boolean = () => true) {
  return Array.from({ length: count }, (_, index) => ({
    row: { id: `s${String(index).padStart(4, '0')}`, visible: visible(index) } as FakeRow,
    cursor: {
      updatedAt: `2026-09-16T10:00:00.${String(999_999 - index).padStart(6, '0')}Z`,
      sessionId: `s${String(index).padStart(4, '0')}`,
    } as SessionCursor,
  }));
}

/** A keyset reader over an in-memory table, recording every batch it serves. */
function reader(table: ReturnType<typeof rows>) {
  const calls: Array<{ after: SessionCursor | null; size: number }> = [];
  const readBatch = async (after: SessionCursor | null, size: number) => {
    calls.push({ after, size });
    const start = after
      ? table.findIndex((entry) => entry.cursor.sessionId === after.sessionId) + 1
      : 0;
    return table.slice(start, start + size);
  };
  return { calls, readBatch };
}

const keepVisible = async (batch: FakeRow[]) => batch.filter((row) => row.visible);

describe('session cursor', () => {
  test('round-trips a microsecond timestamp and a session id', () => {
    const cursor = { updatedAt: '2026-09-16T10:00:00.123456Z', sessionId: 'a1b2-c3' };
    expect(parseSessionCursor(encodeSessionCursor(cursor))).toEqual(cursor);
  });

  test.each([
    ['empty', ''],
    ['no separator', '2026-09-16T10:00:00.123456Z'],
    ['two separators', '2026-09-16T10:00:00Z|a|b'],
    ['not an instant', 'yesterday|abc'],
    ['empty session id', '2026-09-16T10:00:00Z|'],
    ['impossible date', '2026-13-45T10:00:00Z|abc'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseSessionCursor(value)).toThrow('cursor is invalid');
  });
});

describe('parseSessionPageLimit', () => {
  test('defaults when absent', () => {
    expect(parseSessionPageLimit(undefined)).toBe(50);
  });

  test('accepts 1 through 200', () => {
    expect(parseSessionPageLimit('1')).toBe(1);
    expect(parseSessionPageLimit('200')).toBe(200);
  });

  test.each(['0', '201', '-1', '1.5', 'abc', ''])('rejects %p', (value) => {
    expect(() => parseSessionPageLimit(value)).toThrow('limit must be an integer from 1 to 200');
  });
});

describe('collectSessionPage', () => {
  test('returns one page and a cursor at its last row when more rows exist', async () => {
    const table = rows(120);
    const { calls, readBatch } = reader(table);

    const page = await collectSessionPage({
      limit: 50,
      after: null,
      readBatch,
      selectVisible: keepVisible,
    });

    expect(page.items.map((row) => row.id)).toEqual(table.slice(0, 50).map((e) => e.row.id));
    expect(page.nextCursor).toEqual(table[49]!.cursor);
    // One read of limit + 1 rows proves there is a next page without a count query.
    expect(calls).toEqual([{ after: null, size: 51 }]);
  });

  test('walks every row exactly once across pages, with no duplicates or gaps', async () => {
    const table = rows(137);
    const { readBatch } = reader(table);
    const seen: string[] = [];
    let after: SessionCursor | null = null;
    let pages = 0;

    do {
      const page: { items: FakeRow[]; nextCursor: SessionCursor | null } =
        await collectSessionPage({ limit: 50, after, readBatch, selectVisible: keepVisible });
      seen.push(...page.items.map((row) => row.id));
      after = page.nextCursor;
      pages += 1;
    } while (after && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(table.map((entry) => entry.row.id));
  });

  test('returns a null cursor when the last page is exactly full', async () => {
    const { readBatch } = reader(rows(50));
    const page = await collectSessionPage({ limit: 50, after: null, readBatch, selectVisible: keepVisible });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeNull();
  });

  test('keeps reading batches until the page fills when the fold drops rows', async () => {
    // Every third row is visible: a single LIMIT 51 read would return a 17-row page.
    const table = rows(300, (index) => index % 3 === 0);
    const { calls, readBatch } = reader(table);

    const page = await collectSessionPage({ limit: 50, after: null, readBatch, selectVisible: keepVisible });

    expect(page.items).toHaveLength(50);
    expect(page.items.every((row) => row.visible)).toBe(true);
    expect(page.nextCursor?.sessionId).toBe(page.items[49]!.id);
    expect(calls.length).toBeGreaterThan(1);
  });

  test('stops at the scan budget and resumes after the last scanned row', async () => {
    // A viewer who can open none of 5,000 rows must not scan all of them in one request.
    const table = rows(5_000, () => false);
    const { calls, readBatch } = reader(table);

    const page = await collectSessionPage({
      limit: 50,
      after: null,
      readBatch,
      selectVisible: keepVisible,
      scanBudget: 1_000,
    });

    const scanned = calls.reduce((total, call) => total + call.size, 0);
    expect(page.items).toEqual([]);
    expect(scanned).toBeLessThanOrEqual(1_000 + 51);
    expect(page.nextCursor).not.toBeNull();
    const resumeIndex = table.findIndex((e) => e.cursor.sessionId === page.nextCursor!.sessionId);
    expect(resumeIndex).toBe(scanned - 1);
  });

  test('an empty table is one read and no cursor', async () => {
    const { calls, readBatch } = reader([]);
    const page = await collectSessionPage({ limit: 50, after: null, readBatch, selectVisible: keepVisible });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(calls).toHaveLength(1);
  });
});
