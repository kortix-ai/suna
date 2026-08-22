/**
 * Park-and-restore: the box may die on time, the question may not.
 *
 * A turn waiting on a human makes no gateway LLM calls, so it earns no deadline
 * extension and its box is parked on schedule. That is correct and must stay
 * correct — the bounded-lifetime design rests on "only a control-plane-OBSERVED
 * event may extend a box", and a box that could keep itself alive by reporting
 * "still waiting" is the self-renewal that once left 187 boxes running, the
 * oldest for 264 hours.
 *
 * The bug was that parking DESTROYED the question: opencode restarts cold, so
 * the user returned to a session that had forgotten what it asked.
 *
 * The two properties worth pinning are therefore:
 *   1. recording a question does NOT extend anything, and
 *   2. a replayed relay does not become two prompts.
 */
import { describe, expect, mock, test } from 'bun:test';

type Row = Record<string, unknown>;

let inserted: Row[] = [];
let conflictTarget: unknown = null;
let updateWhereCalls = 0;
let returnRows: Row[] = [{ id: 'q1' }];

mock.module('../../shared/db', () => ({
  db: {
    insert: () => ({
      values: (v: Row) => {
        inserted.push(v);
        return {
          onConflictDoUpdate: (cfg: { target: unknown }) => {
            conflictTarget = cfg.target;
            return {
              returning: async () => [
                {
                  id: 'q1',
                  sessionId: v.sessionId,
                  requestId: v.requestId,
                  opencodeSessionId: v.opencodeSessionId ?? null,
                  questions: v.questions,
                  askedAt: '2026-08-05T12:00:00.000Z',
                },
              ],
            };
          },
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          updateWhereCalls++;
          return { returning: async () => returnRows };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => returnRows }) }),
      }),
    }),
  },
}));

const { recordPendingQuestion } = await import('./pending-questions');

const base = {
  accountId: 'acct-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  requestId: 'req-1',
  questions: [{ text: 'Deploy to prod?' }],
};

describe('recordPendingQuestion', () => {
  test('stores the question outside the sandbox', async () => {
    inserted = [];
    const row = await recordPendingQuestion(base);
    expect(row?.session_id).toBe('sess-1');
    expect(row?.request_id).toBe('req-1');
    expect(inserted).toHaveLength(1);
  });

  test('a replayed relay upserts instead of creating a second prompt', async () => {
    // The relay is best-effort and retries. Two rows would render as two
    // identical prompts and invite two answers to one question.
    inserted = [];
    conflictTarget = null;
    await recordPendingQuestion(base);
    expect(Array.isArray(conflictTarget)).toBe(true);
    expect((conflictTarget as unknown[]).length).toBe(2);
  });

  test('does NOT touch the sandbox deadline', async () => {
    // The property the whole design depends on. If recording a question could
    // extend a box, a box could keep itself alive forever by asking one.
    //
    // Asserted on CODE, not prose — the module's own comment explains the
    // deadline at length, so a bare substring match on "deadline" fails on the
    // documentation rather than on a real call. Strip comments first.
    const raw = await Bun.file(
      new URL('./pending-questions.ts', import.meta.url).pathname,
    ).text();
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    for (const forbidden of [
      'extendSandboxDeadline',
      'observeTurnStart',
      'sandbox-deadline',
      'deadlineAt',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
