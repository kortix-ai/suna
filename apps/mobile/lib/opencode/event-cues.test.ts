import { describe, expect, test } from 'bun:test';
import { MAX_REMEMBERED_PROMPTS, createCueTracker, cueForEvent, type CueEvent, type EventCue } from './event-cues';

const FG = { foreground: true };
const BG = { foreground: false };

const status = (sessionID: string, type: string): CueEvent => ({
  type: 'session.status',
  properties: { sessionID, status: { type } },
});
const idle = (sessionID: string): CueEvent => ({ type: 'session.idle', properties: { sessionID } });
const error = (sessionID: string, name = 'APIError'): CueEvent => ({
  type: 'session.error',
  properties: { sessionID, error: { name, data: { message: 'x' } } },
});
const question = (id: string, sessionID = 's1'): CueEvent => ({
  type: 'question.asked',
  properties: { id, sessionID },
});
const permission = (id: string, sessionID = 's1'): CueEvent => ({
  type: 'permission.asked',
  properties: { id, sessionID },
});

const COMPLETION: EventCue = { sound: 'completion', haptic: 'success' };

describe('reply complete', () => {
  test('busy then idle plays completion with a success haptic', () => {
    const t = createCueTracker();
    expect(cueForEvent(t, status('s1', 'busy'), FG)).toBeNull();
    expect(cueForEvent(t, status('s1', 'idle'), FG)).toEqual(COMPLETION);
  });

  test('status idle followed by session.idle plays once', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, status('s1', 'idle'), FG)).toEqual(COMPLETION);
    expect(cueForEvent(t, idle('s1'), FG)).toBeNull();
    expect(cueForEvent(t, status('s1', 'idle'), FG)).toBeNull();
  });

  test('session.idle alone ends a busy turn', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, idle('s1'), FG)).toEqual(COMPLETION);
  });

  test('idle without a busy seen by this stream plays nothing', () => {
    const t = createCueTracker();
    expect(cueForEvent(t, status('s1', 'idle'), FG)).toBeNull();
    expect(cueForEvent(t, idle('s1'), FG)).toBeNull();
  });

  test('repeated busy frames and a retry still end in one completion', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), FG);
    cueForEvent(t, status('s1', 'retry'), FG);
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, idle('s1'), FG)).toEqual(COMPLETION);
    expect(cueForEvent(t, idle('s1'), FG)).toBeNull();
  });

  test('each turn plays its own completion', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, idle('s1'), FG)).toEqual(COMPLETION);
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, idle('s1'), FG)).toEqual(COMPLETION);
  });

  test('sessions are tracked independently', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, idle('s2'), FG)).toBeNull();
    expect(cueForEvent(t, idle('s1'), FG)).toEqual(COMPLETION);
  });

  test('backgrounded: no cue, and the turn is consumed', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, idle('s1'), BG)).toBeNull();
    // Returning to the foreground does not replay the missed completion.
    expect(cueForEvent(t, idle('s1'), FG)).toBeNull();
  });

  test('a turn that started in the background still chimes when it ends in the foreground', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), BG);
    expect(cueForEvent(t, idle('s1'), FG)).toEqual(COMPLETION);
  });
});

describe('turn error', () => {
  test('an error plays the error sound and suppresses the completion', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, error('s1'), FG)).toEqual({ sound: 'error' });
    expect(cueForEvent(t, status('s1', 'idle'), FG)).toBeNull();
    expect(cueForEvent(t, idle('s1'), FG)).toBeNull();
  });

  test('a second error in the same turn plays nothing', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, error('s1'), FG)).toEqual({ sound: 'error' });
    expect(cueForEvent(t, error('s1'), FG)).toBeNull();
  });

  test('the next turn can error again', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), FG);
    cueForEvent(t, error('s1'), FG);
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, error('s1'), FG)).toEqual({ sound: 'error' });
  });

  test('an error without a busy seen still plays (a prompt rejected at once)', () => {
    const t = createCueTracker();
    expect(cueForEvent(t, error('s1'), FG)).toEqual({ sound: 'error' });
  });

  test('a user abort is silent and cancels the completion', () => {
    const t = createCueTracker();
    cueForEvent(t, status('s1', 'busy'), FG);
    expect(cueForEvent(t, error('s1', 'MessageAbortedError'), FG)).toBeNull();
    expect(cueForEvent(t, idle('s1'), FG)).toBeNull();
  });

  test('backgrounded error plays nothing', () => {
    const t = createCueTracker();
    expect(cueForEvent(t, error('s1'), BG)).toBeNull();
  });
});

describe('prompts', () => {
  test('a question plays the notification sound once per id', () => {
    const t = createCueTracker();
    expect(cueForEvent(t, question('q1'), FG)).toEqual({ sound: 'notification' });
    expect(cueForEvent(t, question('q1'), FG)).toBeNull();
    expect(cueForEvent(t, question('q2'), FG)).toEqual({ sound: 'notification' });
  });

  test('a permission plays the notification sound once per id', () => {
    const t = createCueTracker();
    expect(cueForEvent(t, permission('p1'), FG)).toEqual({ sound: 'notification' });
    expect(cueForEvent(t, permission('p1'), FG)).toBeNull();
  });

  test('question and permission ids do not collide', () => {
    const t = createCueTracker();
    expect(cueForEvent(t, question('x'), FG)).toEqual({ sound: 'notification' });
    expect(cueForEvent(t, permission('x'), FG)).toEqual({ sound: 'notification' });
  });

  test('a prompt first seen in the background never plays later', () => {
    const t = createCueTracker();
    expect(cueForEvent(t, question('q1'), BG)).toBeNull();
    expect(cueForEvent(t, question('q1'), FG)).toBeNull();
  });

  test('a prompt without an id plays nothing', () => {
    const t = createCueTracker();
    expect(cueForEvent(t, { type: 'question.asked', properties: { sessionID: 's1' } }, FG)).toBeNull();
  });

  test('remembered ids are bounded; the oldest is forgotten first', () => {
    const t = createCueTracker();
    for (let i = 0; i <= MAX_REMEMBERED_PROMPTS; i++) cueForEvent(t, question(`q${i}`), FG);
    expect(t.prompted.size).toBe(MAX_REMEMBERED_PROMPTS);
    expect(t.prompted.has('q:q0')).toBe(false);
    expect(t.prompted.has(`q:q${MAX_REMEMBERED_PROMPTS}`)).toBe(true);
  });
});

describe('other events', () => {
  test('streaming and bookkeeping events play nothing', () => {
    const t = createCueTracker();
    for (const type of ['message.updated', 'message.part.delta', 'question.replied', 'permission.replied', 'session.updated']) {
      expect(cueForEvent(t, { type, properties: { sessionID: 's1', id: 'a' } }, FG)).toBeNull();
    }
  });

  test('events without a session id play nothing', () => {
    const t = createCueTracker();
    expect(cueForEvent(t, { type: 'session.idle', properties: {} }, FG)).toBeNull();
    expect(cueForEvent(t, { type: 'session.error' }, FG)).toBeNull();
  });
});
