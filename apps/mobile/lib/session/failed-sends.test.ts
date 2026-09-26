import { beforeEach, describe, expect, test } from 'bun:test';

import { sendIdsFor, useFailedSendStore, withFailed, withoutFailed } from './failed-sends';

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

  test('markFailed keeps fileParts and localFiles and take returns them', () => {
    const withFiles = {
      text: 'hi',
      options: {},
      fileParts: [{ type: 'file' as const, attachment_id: 'a1', mime: 'image/jpeg', filename: 'photo_1.jpg' }],
      localFiles: [{ uri: 'file:///cache/photo_1.jpg', name: 'photo_1.jpg', mimeType: 'image/jpeg', isImage: true }],
    };
    useFailedSendStore.getState().markFailed('s1', 'msg_1', withFiles);
    expect(useFailedSendStore.getState().take('s1', 'msg_1')).toEqual(withFiles);
  });

  test('markFailed keeps the send ids and take returns them', () => {
    const withIds = { text: 'hi', options: {}, clientMessageId: 'c-1', messageId: 'msg_1' };
    useFailedSendStore.getState().markFailed('s1', 'msg_1', withIds);
    expect(useFailedSendStore.getState().take('s1', 'msg_1')).toEqual(withIds);
  });
});

describe('sendIdsFor', () => {
  const mint = () => ({ clientMessageId: 'fresh-client', messageId: 'msg_fresh' });

  test('a first send mints new ids', () => {
    expect(sendIdsFor(undefined, mint)).toEqual({ clientMessageId: 'fresh-client', messageId: 'msg_fresh' });
  });

  test('a retry reuses both ids, so the server dedupes a prompt that already landed', () => {
    expect(sendIdsFor({ clientMessageId: 'c-1', messageId: 'msg_1' }, mint)).toEqual({
      clientMessageId: 'c-1',
      messageId: 'msg_1',
    });
  });

  test('a retry with only one id kept mints the other', () => {
    expect(sendIdsFor({ messageId: 'msg_1' }, mint)).toEqual({ clientMessageId: 'fresh-client', messageId: 'msg_1' });
  });
});
