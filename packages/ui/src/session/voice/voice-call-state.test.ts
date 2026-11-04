import { describe, expect, test } from 'bun:test';

import {
  CLEAR_ROLLOFF_MS,
  createPlayback,
  DIAL_MS,
  DUCK_GAIN,
  HOLD_PAUSE_MS,
  INITIAL_CALL,
  reduceCall,
  REDIAL_MS,
  type CallEvent,
  type CallState,
} from './voice-call-state';

const run = (events: CallEvent[], from: CallState = INITIAL_CALL) => events.reduce(reduceCall, from);

describe('reduceCall', () => {
  test('ready makes the call live', () => {
    expect(run([{ type: 'ready' }]).phase).toBe('live');
  });

  test('a drop before ready is dialed again while a new box opens the relay, then ends the call', () => {
    const drops = (relay: 'unreachable' | 'unknown' | 'reachable', n: number) =>
      run(Array.from({ length: n }, () => ({ type: 'drop' as const, relay })));
    for (let i = 1; i <= DIAL_MS.length; i++) expect(drops('unreachable', i)).toMatchObject({ phase: 'connecting', redials: i });
    // After the last try: unavailable when nothing listens on the port, failed otherwise.
    expect(drops('unreachable', DIAL_MS.length + 1)).toMatchObject({ phase: 'ended', end: 'unavailable' });
    expect(drops('unknown', DIAL_MS.length + 1)).toMatchObject({ phase: 'ended', end: 'failed' });
    expect(drops('reachable', DIAL_MS.length + 1)).toMatchObject({ phase: 'ended', end: 'failed' });
    // The relay answers on a later try: the call goes live.
    expect(run([{ type: 'drop', relay: 'unreachable' }, { type: 'ready' }])).toMatchObject({ phase: 'live', redials: 0 });
  });

  test('a live call that drops reconnects, and ends as lost after the last redial fails', () => {
    let state = run([{ type: 'ready' }, { type: 'drop' }]);
    expect(state).toMatchObject({ phase: 'reconnecting', redials: 0 });
    for (let i = 1; i < REDIAL_MS.length; i++) {
      state = reduceCall(state, { type: 'drop' });
      expect(state).toMatchObject({ phase: 'reconnecting', redials: i });
    }
    expect(reduceCall(state, { type: 'drop' })).toMatchObject({ phase: 'ended', end: 'lost' });
  });

  test('a redial that reaches ready is live again with a fresh redial budget', () => {
    const state = run([{ type: 'ready' }, { type: 'drop' }, { type: 'drop' }, { type: 'ready' }]);
    expect(state).toMatchObject({ phase: 'live', redials: 0 });
    expect(reduceCall(state, { type: 'drop' })).toMatchObject({ phase: 'reconnecting', redials: 0 });
  });

  test("the relay's closed ends the call, and the socket close after it changes nothing", () => {
    const closed = run([{ type: 'ready' }, { type: 'closed' }]);
    expect(closed).toMatchObject({ phase: 'ended', end: 'closed' });
    expect(reduceCall(closed, { type: 'drop' })).toBe(closed);
    expect(reduceCall(closed, { type: 'ready' })).toBe(closed);
  });

  test('a failed audio start ends a live call as failed', () => {
    expect(run([{ type: 'ready' }, { type: 'audio-failed' }])).toMatchObject({ phase: 'ended', end: 'failed' });
  });

  test('the latest agent or user line is kept; screen readings and empty lines are not', () => {
    const state = run([
      { type: 'ready' },
      { type: 'text', role: 'user', who: 'caller', text: ' what failed? ' },
      { type: 'text', role: 'screen', who: 'screen', text: 'a terminal with a stack trace' },
      { type: 'text', role: 'agent', who: 'Kortix', text: '   ' },
    ]);
    expect(state.line).toEqual({ role: 'user', who: 'caller', text: 'what failed?' });
    expect(reduceCall(state, { type: 'text', role: 'agent', who: 'Kortix', text: 'The build step.' }).line).toEqual({
      role: 'agent',
      who: 'Kortix',
      text: 'The build step.',
    });
  });

  test('speaking flips only on a change, and ending the call clears it', () => {
    const live = run([{ type: 'ready' }, { type: 'speaking', on: true }]);
    expect(live.speaking).toBe(true);
    expect(reduceCall(live, { type: 'speaking', on: true })).toBe(live);
    expect(reduceCall(live, { type: 'drop' }).speaking).toBe(false);
  });

  test('a blocked microphone is recorded once', () => {
    const blocked = run([{ type: 'ready' }, { type: 'mic-blocked' }]);
    expect(blocked.micBlocked).toBe(true);
    expect(reduceCall(blocked, { type: 'mic-blocked' })).toBe(blocked);
  });
});

describe('createPlayback', () => {
  const setup = () => {
    const calls: string[] = [];
    const timers: { run: () => void; ms: number }[] = [];
    const playback = createPlayback(
      { post: (m) => calls.push(`post ${m}`), level: (v) => calls.push(`level ${v}`) },
      (run, ms) => timers.push({ run, ms }),
    );
    const flush = () => timers.splice(0).forEach((t) => t.run());
    return { calls, timers, playback, flush };
  };

  test('clear lowers the voice at once, then drops the queue and restores full gain after the roll-off', () => {
    const { calls, timers, playback, flush } = setup();
    expect(playback.handle({ type: 'clear' })).toBe(true);
    expect(calls).toEqual(['level 0']);
    expect(timers.map((t) => t.ms)).toEqual([CLEAR_ROLLOFF_MS]);
    flush();
    expect(calls).toEqual(['level 0', 'post clear', 'level 1']);
  });

  test('duck lowers the voice and restores it; a hold keeps it silent', () => {
    const { calls, playback } = setup();
    playback.handle({ type: 'duck', on: true });
    playback.handle({ type: 'duck', on: false });
    expect(calls).toEqual([`level ${DUCK_GAIN}`, 'level 1']);
    playback.handle({ type: 'hold', on: true });
    calls.length = 0;
    playback.handle({ type: 'duck', on: true });
    expect(calls).toEqual([]);
  });

  test('hold silences, pauses within a beat, and resume goes back to the ducked or full gain', () => {
    const { calls, timers, playback, flush } = setup();
    playback.handle({ type: 'duck', on: true });
    playback.handle({ type: 'hold', on: true });
    expect(timers.map((t) => t.ms)).toEqual([HOLD_PAUSE_MS]);
    flush();
    playback.handle({ type: 'hold', on: false });
    expect(calls).toEqual([`level ${DUCK_GAIN}`, 'level 0', 'post pause', 'post resume', `level ${DUCK_GAIN}`]);
  });

  test('a hold released before its beat does not pause', () => {
    const { calls, playback, flush } = setup();
    playback.handle({ type: 'hold', on: true });
    playback.handle({ type: 'hold', on: false });
    flush();
    expect(calls).not.toContain('post pause');
  });

  test('clear ends a hold and a duck: the gain after the roll-off is full', () => {
    const { calls, playback, flush } = setup();
    playback.handle({ type: 'duck', on: true });
    playback.handle({ type: 'hold', on: true });
    playback.handle({ type: 'clear' });
    expect(playback.current()).toEqual({ held: false, ducked: false });
    flush();
    expect(calls.slice(-2)).toEqual(['post clear', 'level 1']);
    expect(calls).not.toContain('post pause');
  });

  test('a speaker set up later starts where the messages left it', () => {
    const { playback } = setup();
    playback.handle({ type: 'duck', on: true });
    playback.handle({ type: 'hold', on: true });
    expect(playback.current()).toEqual({ held: true, ducked: true });
  });

  test('any other message is not a playback message', () => {
    const { calls, playback } = setup();
    expect(playback.handle({ type: 'text' })).toBe(false);
    expect(playback.handle({})).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("a call's length", () => {
  test('counts from the first answer, across a reconnect', () => {
    const live = run([{ type: 'ready', at: 1_000 }]);
    expect(live.liveAt).toBe(1_000);
    expect(run([{ type: 'drop' }, { type: 'ready', at: 9_000 }], live).liveAt).toBe(1_000);
    expect(INITIAL_CALL.liveAt).toBeNull();
  });
});
