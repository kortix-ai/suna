// Unit tests for recordBootTimeline (the server-side persistence half of the
// in-guest boot timeline relay — apps/kortix-sandbox-agent-server/src/boot-timeline-relay.ts
// is the daemon-side sender).
//
// The DB is a lightweight in-memory fake that just records insert() calls, so
// this runs fully offline. Run this file in its own `bun test <file>`
// invocation — `mock.module` is process-global and other suites mock the same
// `../../shared/db` specifier with a different shape (see the same caveat in
// managed-github-app.test.ts).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let inserted: Array<Record<string, unknown>> = [];
let insertShouldThrow = false;
let insertDelayMs = 0;

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        if (insertDelayMs > 0) await new Promise((r) => setTimeout(r, insertDelayMs));
        if (insertShouldThrow) throw new Error('DB hiccup');
        inserted.push(v);
        return undefined;
      },
    }),
  },
}));

const { recordBootTimeline } = await import('./boot-timeline-store');

beforeEach(() => {
  inserted = [];
  insertShouldThrow = false;
  insertDelayMs = 0;
});

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('recordBootTimeline', () => {
  test('inserts a provider_events row with kind=boot and the timeline as marks', async () => {
    recordBootTimeline({
      provider: 'daytona',
      sessionId: 'sess-1',
      accountId: 'acct-1',
      timeline: [
        { label: 'repo-materialized', atMs: 6686 },
        { label: 'opencode-session-created', atMs: 12066 },
      ],
    });
    await flush();

    expect(inserted.length).toBe(1);
    expect(inserted[0]).toMatchObject({
      provider: 'daytona',
      kind: 'boot',
      outcome: 'ok',
      sessionId: 'sess-1',
      accountId: 'acct-1',
      totalMs: 12066,
    });
    expect(inserted[0]!.marks).toEqual([
      { label: 'repo-materialized', atMs: 6686 },
      { label: 'opencode-session-created', atMs: 12066 },
    ]);
  });

  test('totalMs is null for an empty timeline', async () => {
    recordBootTimeline({ provider: 'platinum', sessionId: 'sess-2', timeline: [] });
    await flush();

    expect(inserted[0]!.totalMs).toBeNull();
    expect(inserted[0]!.marks).toEqual([]);
  });

  test('accountId defaults to null when omitted', async () => {
    recordBootTimeline({ provider: 'daytona', sessionId: 'sess-3', timeline: [{ label: 'a', atMs: 1 }] });
    await flush();

    expect(inserted[0]!.accountId).toBeNull();
  });

  test('never throws when the insert fails — telemetry must not affect the caller', async () => {
    insertShouldThrow = true;
    expect(() =>
      recordBootTimeline({ provider: 'daytona', sessionId: 'sess-4', timeline: [{ label: 'a', atMs: 1 }] }),
    ).not.toThrow();
    await flush();

    expect(inserted).toEqual([]);
  });

  test('does not block the caller on a slow insert — returns before it resolves', async () => {
    insertDelayMs = 100;

    const before = Date.now();
    recordBootTimeline({ provider: 'daytona', sessionId: 'sess-5', timeline: [{ label: 'a', atMs: 1 }] });
    expect(Date.now() - before).toBeLessThan(10);

    expect(inserted).toEqual([]);
    await new Promise((r) => setTimeout(r, 150));
    expect(inserted.length).toBe(1);
  });
});
