import { describe, expect, test } from 'bun:test';
import {
  MAX_REMEMBERED_QUESTIONS,
  QUESTION_REMINDER_BODY,
  QUESTION_REMINDER_SECONDS,
  createReminderTracker,
  planQuestionReminders,
  questionReminderRequest,
  reminderIdentifier,
} from './question-reminder';

const S1 = { projectId: 'p1', sessionId: 's1' };
const S2 = { projectId: 'p1', sessionId: 's2' };

function plan(
  tracker = createReminderTracker(),
  input: Partial<Parameters<typeof planQuestionReminders>[1]> = {}
) {
  return planQuestionReminders(tracker, { pendingIds: [], bound: S1, enabled: true, ...input });
}

describe('planQuestionReminders', () => {
  test('a new question in the bound session schedules one reminder for that session', () => {
    expect(plan(undefined, { pendingIds: ['q1'] })).toEqual({
      schedule: [{ requestId: 'q1', session: S1 }],
      cancel: [],
    });
  });

  test('the same question id never schedules twice', () => {
    const tracker = createReminderTracker();
    plan(tracker, { pendingIds: ['q1'] });
    expect(plan(tracker, { pendingIds: ['q1'] })).toEqual({ schedule: [], cancel: [] });
  });

  test('an answered question (gone from the store) cancels its reminder', () => {
    const tracker = createReminderTracker();
    plan(tracker, { pendingIds: ['q1', 'q2'] });
    expect(plan(tracker, { pendingIds: ['q2'] })).toEqual({ schedule: [], cancel: ['q1'] });
  });

  test('a question answered and re-added by a stale hydrate does not schedule again', () => {
    const tracker = createReminderTracker();
    plan(tracker, { pendingIds: ['q1'] });
    plan(tracker, { pendingIds: [] });
    expect(plan(tracker, { pendingIds: ['q1'] })).toEqual({ schedule: [], cancel: [] });
  });

  test('the onQuestion switch off schedules nothing, and turning it off cancels', () => {
    expect(plan(undefined, { pendingIds: ['q1'], enabled: false })).toEqual({ schedule: [], cancel: [] });

    const tracker = createReminderTracker();
    plan(tracker, { pendingIds: ['q1'] });
    expect(plan(tracker, { pendingIds: ['q1'], enabled: false })).toEqual({ schedule: [], cancel: ['q1'] });
  });

  test('leaving the session (another session or none bound) cancels its reminders', () => {
    const tracker = createReminderTracker();
    plan(tracker, { pendingIds: ['q1'] });
    expect(plan(tracker, { pendingIds: ['q1'], bound: S2 })).toEqual({ schedule: [], cancel: ['q1'] });

    const other = createReminderTracker();
    plan(other, { pendingIds: ['q1'] });
    expect(plan(other, { pendingIds: ['q1'], bound: null })).toEqual({ schedule: [], cancel: ['q1'] });
  });

  test('sign-out (store cleared, no session bound) cancels every reminder', () => {
    const tracker = createReminderTracker();
    plan(tracker, { pendingIds: ['q1', 'q2'] });
    expect(plan(tracker, { pendingIds: [], bound: null })).toEqual({ schedule: [], cancel: ['q1', 'q2'] });
  });

  test('a question seen with no session bound is remembered and never scheduled later', () => {
    const tracker = createReminderTracker();
    expect(plan(tracker, { pendingIds: ['q1'], bound: null })).toEqual({ schedule: [], cancel: [] });
    expect(plan(tracker, { pendingIds: ['q1'] })).toEqual({ schedule: [], cancel: [] });
  });

  test('remembered ids are bounded; the oldest is forgotten first', () => {
    const tracker = createReminderTracker();
    const ids = Array.from({ length: MAX_REMEMBERED_QUESTIONS + 1 }, (_, i) => `q${i}`);
    for (const id of ids) plan(tracker, { pendingIds: [id], enabled: false });
    expect(tracker.seen.size).toBe(MAX_REMEMBERED_QUESTIONS);
    expect(tracker.seen.has('q0')).toBe(false);
  });
});

describe('questionReminderRequest', () => {
  test('fires once after 60 s on the attention channel, opens the session on tap', () => {
    const request = questionReminderRequest({ requestId: 'q1', session: S1, playSound: true });
    expect(request).toEqual({
      identifier: 'question-reminder:q1',
      content: {
        title: 'Kortix',
        body: 'You need to answer the question.',
        sound: 'kortix_attention.wav',
        data: { kind: 'question', type: 'question', projectId: 'p1', sessionId: 's1', reminder: true },
      },
      trigger: { type: 'timeInterval', seconds: 60, repeats: false, channelId: 'session-attention' },
    });
    expect(QUESTION_REMINDER_SECONDS).toBe(60);
    expect(QUESTION_REMINDER_BODY).toBe('You need to answer the question.');
  });

  test('with sound off: the silent channel and no iOS sound', () => {
    const request = questionReminderRequest({ requestId: 'q1', session: S1, playSound: false });
    expect(request.content.sound).toBe(false);
    expect(request.trigger.channelId).toBe('session-silent');
  });

  test('the identifier is stable per request id', () => {
    expect(reminderIdentifier('abc')).toBe('question-reminder:abc');
  });
});
