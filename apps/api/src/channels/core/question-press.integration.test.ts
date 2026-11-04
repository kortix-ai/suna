/**
 * Real-Postgres contract for a press on an agent question (questions.ts
 * `decideQuestionPress`, `settleQuestionAnswer`): picks the stored question
 * does not take answer nothing, a press in another conversation answers
 * nothing, only an answer to every question is stored and released in the
 * turn, and the follow-up pairs each answered question with its answer. The
 * runtime is a recorder, as in the Telegram suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatEventDedup, sessionPendingQuestions } from '@kortix/db';
import { eq, like } from 'drizzle-orm';
import { removeSeeded, seedProject, seedSession, type SeededProject } from '../../__tests__/helpers/integration-fixtures';
import { db } from '../../shared/db';
import type { ChannelTarget } from './conversation';
import {
  type QuestionAnswer,
  type QuestionPick,
  decideQuestionPress,
  rememberQuestionMessage,
  rememberedQuestionRef,
  settleQuestionAnswer,
} from './questions';
import { bindChatThread } from './threads';

let releaseOutcome: 'released' | 'already_answered' | 'unreachable' = 'released';
const releases: unknown[][] = [];
mock.module('../../projects/session-lifecycle/release-runtime-question', () => ({
  releaseRuntimeQuestion: async (...args: unknown[]) => {
    releases.push(args);
    return releaseOutcome;
  },
}));

const WORKSPACE = `TPRESS${crypto.randomUUID().slice(0, 8)}`;
const REF = '1700000000.000100';
const QUESTIONS = [
  {
    header: 'Region',
    question: 'Which regions?',
    options: [
      { label: 'eu-west', description: '' },
      { label: 'us-east', description: '' },
    ],
    multiple: true,
    custom: true,
  },
  {
    header: 'Confirm',
    question: 'Deploy now?',
    options: [
      { label: 'Yes', description: '' },
      { label: 'No', description: '' },
    ],
    multiple: false,
    custom: false,
  },
];

let project: SeededProject;
let sessionId: string;
let threadN = 0;
const delivered: QuestionAnswer[] = [];
let deliverResult: 'handled' | 'gone' = 'handled';
const deliver = async (a: QuestionAnswer) => {
  delivered.push(a);
  return deliverResult;
};

beforeAll(async () => {
  project = await seedProject(`press-${crypto.randomUUID().slice(0, 8)}`);
  sessionId = await seedSession(project, crypto.randomUUID());
});

beforeEach(() => {
  releaseOutcome = 'released';
  releases.length = 0;
  delivered.length = 0;
  deliverResult = 'handled';
});

afterAll(async () => {
  await db.delete(sessionPendingQuestions).where(eq(sessionPendingQuestions.projectId, project.project_id));
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `slack:question-buttons:${project.project_id}:%`));
  await removeSeeded([project]);
});

/** A conversation bound to `session`, with an open question posted in it and remembered. */
async function asked(session = sessionId) {
  const target: ChannelTarget = { platform: 'slack', projectId: project.project_id, workspaceId: WORKSPACE, threadId: `C1:${++threadN}` };
  await bindChatThread({ ...target, sessionId: session });
  const [row] = await db
    .insert(sessionPendingQuestions)
    .values({ accountId: project.account_id, projectId: project.project_id, sessionId: session, requestId: `que_${crypto.randomUUID()}`, questions: QUESTIONS })
    .returning({ id: sessionPendingQuestions.id, requestId: sessionPendingQuestions.requestId });
  await rememberQuestionMessage(target, REF, row!.id);
  return { target, pendingId: row!.id, requestId: row!.requestId };
}

const stored = async (pendingId: string) =>
  (await db.select().from(sessionPendingQuestions).where(eq(sessionPendingQuestions.id, pendingId)))[0]!;

describe('a press on an agent question — migrated PostgreSQL', () => {
  test('picks the stored question does not take answer nothing', async () => {
    const { target, pendingId } = await asked();
    const press = (picks: QuestionPick[]) => decideQuestionPress({ target, ref: REF, pendingId, picks });
    for (const picks of [
      [],
      [{ question: 0, options: [] }],
      [{ question: 2, options: [0] }],
      [{ question: -1, options: [0] }],
      [{ question: 0, options: [2] }],
      [{ question: 0, options: [0, 0] }],
      [{ question: 1, options: [0, 1] }],
      [{ question: 1, options: [], text: 'later' }],
      [
        { question: 0, options: [0] },
        { question: 0, options: [1] },
      ],
    ] satisfies QuestionPick[][]) {
      expect(await press(picks)).toEqual({ kind: 'earlier', questions: QUESTIONS as never });
    }
    // An unknown question, or one of another project, names nothing to show.
    expect(await decideQuestionPress({ target, ref: REF, pendingId: crypto.randomUUID(), picks: [{ question: 0, options: [0] }] })).toEqual({
      kind: 'earlier',
      questions: [],
    });
    const other = await seedProject(`press-other-${crypto.randomUUID().slice(0, 8)}`);
    try {
      expect(
        await decideQuestionPress({ target: { ...target, projectId: other.project_id }, ref: REF, pendingId, picks: [{ question: 0, options: [0] }] }),
      ).toEqual({ kind: 'earlier', questions: [] });
    } finally {
      await removeSeeded([other]);
    }
    expect(releases).toEqual([]);
  });

  test("a press in a conversation that is not the question's session's answers nothing", async () => {
    const { target, pendingId } = await asked();
    const picks = [{ question: 1, options: [0] }];
    const otherSession = await seedSession(project, crypto.randomUUID());
    const moved = await asked(otherSession);
    expect(await decideQuestionPress({ target: moved.target, ref: REF, pendingId, picks })).toMatchObject({ kind: 'earlier' });
    expect(await decideQuestionPress({ target: { ...target, threadId: 'C1:unbound' }, ref: REF, pendingId, picks })).toMatchObject({ kind: 'earlier' });
    expect(await decideQuestionPress({ target, ref: REF, pendingId, picks }, async () => null)).toMatchObject({ kind: 'earlier' });
    expect(await decideQuestionPress({ target, ref: REF, pendingId, picks }, async (sid) => (sid === sessionId ? 'C1:elsewhere' : null))).toMatchObject({
      kind: 'answer',
      answer: { threadId: 'C1:elsewhere' },
    });
  });

  test('an answer to some of the questions is never stored or released: it follows up quoting only those', async () => {
    const { target, pendingId } = await asked();
    expect(await rememberedQuestionRef(target, pendingId)).toBe(REF);
    const press = { target, ref: REF, pendingId, picks: [{ question: 1, options: [1] }] };
    const decision = await decideQuestionPress(press);
    if (decision.kind !== 'answer') throw new Error('expected an answer');
    expect(decision.answer).toMatchObject({ sessionId, threadId: target.threadId, answers: [[], ['No']], whole: false, label: 'No' });
    expect(decision.answer.prompt).toBe('You asked:\n> Deploy now?\n\nNo');

    expect(await settleQuestionAnswer(press, decision.answer, deliver, { finalAttempt: false })).toBe('delivered');
    expect(releases).toEqual([]);
    expect(delivered).toEqual([decision.answer]);
    expect(await stored(pendingId)).toMatchObject({ answeredAt: null, answers: null });
    // The other question is still open on the message.
    expect(await rememberedQuestionRef(target, pendingId)).toBe(REF);
  });

  test('an answer to every question is stored and released in the turn once, and the message is forgotten', async () => {
    const { target, pendingId, requestId } = await asked();
    const press = {
      target,
      ref: REF,
      pendingId,
      picks: [
        { question: 0, options: [0, 1], text: '  ap-south  ' },
        { question: 1, options: [0] },
      ],
    };
    const decision = await decideQuestionPress(press);
    if (decision.kind !== 'answer') throw new Error('expected an answer');
    const answers = [['eu-west', 'us-east', 'ap-south'], ['Yes']];
    expect(decision.answer).toMatchObject({ requestId, answers, whole: true, label: 'eu-west, us-east, ap-south, Yes' });

    expect(await settleQuestionAnswer(press, decision.answer, deliver, { finalAttempt: false })).toBe('in_turn');
    expect(releases).toEqual([[sessionId, requestId, answers]]);
    expect(delivered).toEqual([]);
    const row = await stored(pendingId);
    expect(row.answeredAt).not.toBeNull();
    expect(row.answers).toEqual(answers);
    expect(await rememberedQuestionRef(target, pendingId)).toBeNull();

    // Someone else answered it differently first: the press follows up instead.
    releases.length = 0;
    const other = { ...press, picks: [{ question: 0, options: [1] }, { question: 1, options: [1] }] };
    const second = await decideQuestionPress(other);
    if (second.kind !== 'answer') throw new Error('expected an answer');
    expect(await settleQuestionAnswer(other, second.answer, deliver, { finalAttempt: false })).toBe('delivered');
    expect(releases).toEqual([]);
    expect((await stored(pendingId)).answers).toEqual(answers);
  });

  test('a whole answer the turn no longer takes follows up, each question paired with its answer; a gone session says so', async () => {
    releaseOutcome = 'already_answered';
    const { target, pendingId } = await asked();
    const press = {
      target,
      ref: REF,
      pendingId,
      picks: [
        { question: 1, options: [1] },
        { question: 0, options: [1] },
      ],
    };
    const decision = await decideQuestionPress(press);
    if (decision.kind !== 'answer') throw new Error('expected an answer');
    expect(decision.answer.prompt).toBe('You asked:\n> Which regions?\nus-east\n\n> Deploy now?\nNo');
    expect(await settleQuestionAnswer(press, decision.answer, deliver, { finalAttempt: false })).toBe('delivered');
    expect(releases).toHaveLength(1);
    expect(delivered.map((a) => a.prompt)).toEqual([decision.answer.prompt]);

    // The retry finds its own answer stored: released again, then the delivery reports the session gone.
    deliverResult = 'gone';
    expect(await settleQuestionAnswer(press, decision.answer, deliver, { finalAttempt: true })).toBe('gone');
    expect(releases).toHaveLength(2);
  });
});
