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
  }, auditDb: {
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

const { recordPendingQuestion, resolvePendingQuestion, clearOpenQuestions, renderAnswerPrompt } = await import(
  './pending-questions'
);

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

describe('resolvePendingQuestion', () => {
  test('answering an open question succeeds', async () => {
    returnRows = [{ id: 'q1' }];
    expect(await resolvePendingQuestion({ ...base, answers: [['yes']] })).toBe(true);
  });

  test('a second answer to the same question is refused', async () => {
    // CAS on answered_at IS NULL — same discipline as the compute settle. A late
    // duplicate must not overwrite the first answer's payload.
    returnRows = [];
    expect(await resolvePendingQuestion({ ...base, answers: [['no']] })).toBe(false);
  });
});

describe('clearOpenQuestions', () => {
  test('supersedes an open question when the turn ends another way', async () => {
    // A stale prompt rendered on resume is worse than none: it invites an answer
    // that nothing is waiting for.
    returnRows = [{ id: 'q1' }, { id: 'q2' }];
    expect(await clearOpenQuestions('sess-1')).toBe(2);
  });

  test('a session with nothing open clears nothing', async () => {
    returnRows = [];
    expect(await clearOpenQuestions('sess-1')).toBe(0);
  });
});

/**
 * The answer arrives as a FOLLOW-UP TURN, so it has to carry its own context.
 *
 * It cannot go back to the call that blocked: that opencode process was parked
 * and restarted cold, its request id no longer exists, and nothing is waiting
 * on it. A fresh opencode has no memory of asking — so a bare "yes" would land
 * with nothing to attach it to. Quoting the question is what makes the reply
 * legible.
 */
describe('renderAnswerPrompt', () => {
  test('quotes the question above the answer', () => {
    const out = renderAnswerPrompt([{ text: 'Deploy to prod?' }], [['yes']]);
    expect(out).toContain('> Deploy to prod?');
    expect(out).toContain('yes');
    expect(out.indexOf('Deploy to prod?')).toBeLessThan(out.indexOf('yes'));
  });

  test('handles several questions and several answers', () => {
    const out = renderAnswerPrompt(
      [{ text: 'Region?' }, { text: 'Confirm?' }],
      [['eu-west'], ['yes']],
    );
    expect(out).toContain('> Region?');
    expect(out).toContain('> Confirm?');
    expect(out).toContain('eu-west');
  });

  test('accepts the alternate `question` field name', () => {
    // opencode's QuestionInfo has shifted shape before; tolerate both rather
    // than silently rendering an empty prompt.
    expect(renderAnswerPrompt([{ question: 'Proceed?' }], [['no']])).toContain('> Proceed?');
  });

  test('an empty answer is stated, never sent as a blank turn', () => {
    // A blank prompt would read as the user saying nothing and the agent would
    // have to guess. Say so explicitly.
    expect(renderAnswerPrompt([{ text: 'Proceed?' }], [])).toContain('(no answer given)');
  });

  test('survives a malformed question payload without throwing', () => {
    // This renders whatever the sandbox relayed; a bad payload must not 500 the
    // answer endpoint and strand the turn.
    expect(() => renderAnswerPrompt(null, [['yes']])).not.toThrow();
    expect(renderAnswerPrompt(null, [['yes']])).toContain('yes');
  });
});
