import { beforeEach, describe, expect, test } from 'bun:test';

import { useFailedSendStore, withFailed, withoutFailed } from './failed-sends';

const send = { text: 'hello', options: { agent: 'kortix' } };

describe('failed sends', () => {
  beforeEach(() => useFailedSendStore.setState({ bySession: {} }));

  test('markFailed keeps the payload under its session and message', () => {
    useFailedSendStore.getState().markFailed('s1', 'msg_1', send);
    expect(useFailedSendStore.getState().bySession).toEqual({ s1: { msg_1: send } });
  });

  test('take returns the payload once, so a double tap retries once', () => {
    useFailedSendStore.getState().markFailed('s1', 'msg_1', send);
    expect(useFailedSendStore.getState().take('s1', 'msg_1')).toEqual(send);
    expect(useFailedSendStore.getState().take('s1', 'msg_1')).toBeUndefined();
    expect(useFailedSendStore.getState().bySession).toEqual({});
  });

  test('take leaves the other failed sends of the session', () => {
    useFailedSendStore.getState().markFailed('s1', 'msg_1', send);
    useFailedSendStore.getState().markFailed('s1', 'msg_2', { text: 'two', options: {} });
    useFailedSendStore.getState().take('s1', 'msg_1');
    expect(Object.keys(useFailedSendStore.getState().bySession.s1!)).toEqual(['msg_2']);
  });

  test('withoutFailed on a missing entry returns the same object', () => {
    const state = withFailed({}, 's1', 'msg_1', send);
    expect(withoutFailed(state, 's1', 'nope')).toBe(state);
    expect(withoutFailed(state, 's2', 'msg_1')).toBe(state);
  });
});
