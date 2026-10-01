import { beforeEach, describe, expect, test } from 'bun:test';
import { useRuntimePendingStore, useSessionStateStore } from '@kortix/sdk/react';

import {
  addOptimisticMessage,
  markOptimisticAccepted,
  removeOptimisticMessage,
  sessionMessageIds,
  sessionRows,
  sessionStatus,
  setLocalSessionStatus,
} from './session-store';
import type { MessageWithParts } from './types';

const SID = 'ses_store_1';
const message = (id: string, text: string): MessageWithParts =>
  ({
    info: { id, role: 'user', sessionID: SID, time: { created: 1 } },
    parts: [{ type: 'text', id: `prt_${id}`, text }],
  }) as unknown as MessageWithParts;

beforeEach(() => {
  useSessionStateStore.getState().reset();
  useRuntimePendingStore.getState().clear();
});

describe('session-store', () => {
  test('an optimistic message reads back as one row, its parts stamped with the message they join', () => {
    addOptimisticMessage(SID, message('msg_1', 'hello'));
    expect(sessionMessageIds(SID)).toEqual(['msg_1']);
    const [row] = sessionRows(SID);
    expect(row.info.id).toBe('msg_1');
    expect(row.parts).toMatchObject([{ type: 'text', text: 'hello', sessionID: SID, messageID: 'msg_1' }]);
    expect(useSessionStateStore.getState().isOptimisticMessage(SID, 'msg_1')).toBe(true);
  });

  test('the rows keep their identity until the transcript changes', () => {
    addOptimisticMessage(SID, message('msg_1', 'hello'));
    const first = sessionRows(SID);
    expect(sessionRows(SID)).toBe(first);
    addOptimisticMessage(SID, message('msg_2', 'again'));
    expect(sessionRows(SID)).not.toBe(first);
  });

  test('a refused send leaves the transcript; an accepted one stays', () => {
    addOptimisticMessage(SID, message('msg_1', 'refused'));
    addOptimisticMessage(SID, message('msg_2', 'accepted'));
    markOptimisticAccepted(SID, 'msg_2');
    removeOptimisticMessage(SID, 'msg_1');
    expect(sessionMessageIds(SID)).toEqual(['msg_2']);
  });

  test('a status set on this device reads back, and an unknown session has none', () => {
    expect(sessionStatus(SID)).toBeUndefined();
    setLocalSessionStatus(SID, { type: 'busy' });
    expect(sessionStatus(SID)).toEqual({ type: 'busy' });
    expect(useSessionStateStore.getState().sessionStatusOrigin[SID]).toBe('local');
    expect(sessionRows('ses_unknown')).toEqual([]);
  });
});
