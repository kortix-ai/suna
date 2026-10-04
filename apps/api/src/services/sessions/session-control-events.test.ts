/**
 * The control channel's own contract.
 *
 * What these falsify, in order of how much they would cost to get wrong:
 *   1. a control frame NEVER carries `seq` — mixing the two id-spaces is the
 *      one failure WS-Z1 named explicitly;
 *   2. a gap is never silent — every unreplayable cursor produces a typed
 *      resync with a reason;
 *   3. the replay/subscribe handoff loses nothing and duplicates nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  CONTROL_EPOCH,
  CONTROL_RING_CAPACITY,
  __resetControlEventsForTests,
  controlChannelState,
  publishControlEvent,
  subscribeControlEvents,
  type ControlEvent,
} from './session-control-events';

const SESSION = 'sess-1';

afterEach(() => __resetControlEventsForTests());

describe('control event id-space', () => {
  test('a control frame carries cseq + cepoch and NEVER a runtime seq', () => {
    const event = publishControlEvent(SESSION, 'kortix.control.turn', { known: true });
    expect(event.channel).toBe('control');
    expect(event.cseq).toBe(1);
    expect(event.cepoch).toBe(CONTROL_EPOCH);
    // The whole point of the separation: a client must never be able to read a
    // control frame's number as a daemon cursor.
    expect((event as unknown as Record<string, unknown>).seq).toBeUndefined();
    expect((event as unknown as Record<string, unknown>).epoch).toBeUndefined();
  });

  test('cseq is dense and monotonic per session, and independent across sessions', () => {
    publishControlEvent(SESSION, 'kortix.control.turn', 1);
    publishControlEvent(SESSION, 'kortix.control.queue', 2);
    publishControlEvent('other', 'kortix.control.turn', 3);
    expect(controlChannelState(SESSION).head_cseq).toBe(2);
    expect(controlChannelState('other').head_cseq).toBe(1);
  });
});

describe('subscribe: replay, resync, handoff', () => {
  test('a client holding nothing gets no replay and no resync', () => {
    publishControlEvent(SESSION, 'kortix.control.turn', 1);
    const sub = subscribeControlEvents(SESSION, {}, () => {});
    expect(sub.replay).toEqual([]);
    expect(sub.resync).toBeNull();
    expect(sub.headCseq).toBe(1);
    sub.unsubscribe();
  });

  test('an in-ring cursor replays exactly the frames after it', () => {
    for (let i = 0; i < 5; i += 1) publishControlEvent(SESSION, 'kortix.control.turn', i);
    const sub = subscribeControlEvents(
      SESSION,
      { sinceCseq: 2, cepoch: CONTROL_EPOCH },
      () => {},
    );
    expect(sub.resync).toBeNull();
    expect(sub.replay.map((event) => event.cseq)).toEqual([3, 4, 5]);
    sub.unsubscribe();
  });

  test('a cursor from another epoch resyncs rather than replaying nonsense', () => {
    publishControlEvent(SESSION, 'kortix.control.turn', 1);
    const sub = subscribeControlEvents(
      SESSION,
      { sinceCseq: 1, cepoch: 'capi_from_a_dead_process' },
      () => {},
    );
    expect(sub.resync?.reason).toBe('epoch-changed');
    expect(sub.resync?.cepoch).toBe(CONTROL_EPOCH);
    expect(sub.replay).toEqual([]);
    sub.unsubscribe();
  });

  test('a cursor with no epoch is treated as a foreign epoch, never trusted', () => {
    publishControlEvent(SESSION, 'kortix.control.turn', 1);
    const sub = subscribeControlEvents(SESSION, { sinceCseq: 1 }, () => {});
    expect(sub.resync?.reason).toBe('epoch-changed');
    sub.unsubscribe();
  });

  test('a cursor ahead of head resyncs', () => {
    publishControlEvent(SESSION, 'kortix.control.turn', 1);
    const sub = subscribeControlEvents(
      SESSION,
      { sinceCseq: 99, cepoch: CONTROL_EPOCH },
      () => {},
    );
    expect(sub.resync?.reason).toBe('ahead-of-head');
    expect(sub.resync?.requested_since).toBe(99);
    sub.unsubscribe();
  });

  test('a cursor older than the ring resyncs and names the window', () => {
    for (let i = 0; i < CONTROL_RING_CAPACITY + 10; i += 1) {
      publishControlEvent(SESSION, 'kortix.control.turn', i);
    }
    const state = controlChannelState(SESSION);
    const sub = subscribeControlEvents(
      SESSION,
      { sinceCseq: 1, cepoch: CONTROL_EPOCH },
      () => {},
    );
    expect(sub.resync?.reason).toBe('gap-too-old');
    expect(sub.resync?.first_cseq).toBe(state.first_cseq);
    expect(sub.resync?.head_cseq).toBe(state.head_cseq);
    // The recovery is spelled out, so a client never has to guess.
    expect(sub.resync?.recover.length).toBeGreaterThan(0);
    sub.unsubscribe();
  });

  test('THE handoff property: nothing lost, nothing duplicated across replay', () => {
    for (let i = 0; i < 10; i += 1) publishControlEvent(SESSION, 'kortix.control.turn', i);

    const received: number[] = [];
    const sub = subscribeControlEvents(
      SESSION,
      { sinceCseq: 6, cepoch: CONTROL_EPOCH },
      (event: ControlEvent) => received.push(event.cseq),
    );
    // Publish DURING the drain, exactly as the stream does.
    publishControlEvent(SESSION, 'kortix.control.queue', 'during');
    const applied = [...sub.replay.map((event) => event.cseq), ...received];
    const deduped = applied.filter((cseq, index) => applied.indexOf(cseq) === index);
    expect(deduped).toEqual([7, 8, 9, 10, 11]);
    expect(applied.length).toBe(deduped.length);
    sub.unsubscribe();
  });

  test('the ring is bounded and keeps the NEWEST frames', () => {
    for (let i = 0; i < CONTROL_RING_CAPACITY * 2; i += 1) {
      publishControlEvent(SESSION, 'kortix.control.turn', i);
    }
    const state = controlChannelState(SESSION);
    expect(state.head_cseq).toBe(CONTROL_RING_CAPACITY * 2);
    expect(state.first_cseq).toBe(CONTROL_RING_CAPACITY + 1);
  });

  test('a listener that throws does not break the publish or the other listeners', () => {
    const seen: number[] = [];
    const bad = subscribeControlEvents(SESSION, {}, () => {
      throw new Error('boom');
    });
    const good = subscribeControlEvents(SESSION, {}, (event) => seen.push(event.cseq));
    expect(() => publishControlEvent(SESSION, 'kortix.control.turn', 1)).not.toThrow();
    expect(seen).toEqual([1]);
    bad.unsubscribe();
    good.unsubscribe();
  });
});
