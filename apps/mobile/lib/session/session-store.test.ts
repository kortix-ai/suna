import { beforeEach, describe, expect, test } from 'bun:test';
import { useRuntimePendingStore, useSessionStateStore } from '@kortix/sdk/react';

import {
  addOptimisticMessage,
  markOptimisticAccepted,
  markSeededPrompt,
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

  // The project home hands a session's first prompt to the server at create,
  // so this device never learns the id the runtime gives it. The echo arrives
  // under another id and must replace the seed, not sit beside it: a seed that
  // stays optimistic shows the prompt twice and blocks the idle reconcile.
  test('a seeded first prompt is replaced by its echo, which has another id', () => {
    addOptimisticMessage(SID, message('msg_seed', 'first prompt'));
    markSeededPrompt(SID, 'msg_seed');
    useSessionStateStore.getState().hydrate(SID, [
      {
        info: { id: 'msg_echo', role: 'user', sessionID: SID, time: { created: 2 } },
        parts: [{ type: 'text', id: 'prt_echo', sessionID: SID, messageID: 'msg_echo', text: 'first prompt' }],
      },
    ] as never);
    expect(sessionMessageIds(SID)).toEqual(['msg_echo']);
    expect(useSessionStateStore.getState().hasOptimisticMessages(SID)).toBe(false);
  });

  test('an accepted inbox prompt is NOT replaced by an unrelated user message', () => {
    addOptimisticMessage(SID, message('msg_mine', 'mine'));
    markOptimisticAccepted(SID, 'msg_mine');
    useSessionStateStore.getState().hydrate(SID, [
      {
        info: { id: 'msg_other', role: 'user', sessionID: SID, time: { created: 2 } },
        parts: [{ type: 'text', id: 'prt_other', sessionID: SID, messageID: 'msg_other', text: 'someone else' }],
      },
    ] as never);
    expect(sessionMessageIds(SID).sort()).toEqual(['msg_mine', 'msg_other']);
  });

  test('a status set on this device reads back, and an unknown session has none', () => {
    expect(sessionStatus(SID)).toBeUndefined();
    setLocalSessionStatus(SID, { type: 'busy' });
    expect(sessionStatus(SID)).toEqual({ type: 'busy' });
    expect(useSessionStateStore.getState().sessionStatusOrigin[SID]).toBe('local');
    expect(sessionRows('ses_unknown')).toEqual([]);
  });
});
