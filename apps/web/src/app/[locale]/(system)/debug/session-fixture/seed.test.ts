import { afterEach, describe, expect, test } from 'bun:test';
import { SESSION_FIXTURE } from '@kortix/shared/session-fixture';
import { resolveWorkingTurn } from '@kortix/sdk';
import { useSessionStateStore } from '@kortix/sdk/react';

import {
  fixturePendingTurnIds,
  fixtureSessionIds,
  fixtureStatus,
  fixtureTurns,
  seedSessionFixture,
} from './seed';

const ROOT = SESSION_FIXTURE.sessionId;

afterEach(() => {
  const store = useSessionStateStore.getState();
  for (const id of fixtureSessionIds()) store.clearSession(id);
});

describe('/debug/session-fixture seed', () => {
  test('hydrates the root and every child transcript with their statuses', () => {
    seedSessionFixture('busy');
    const state = useSessionStateStore.getState();
    expect(state.getMessages(ROOT).map((m) => m.info.id)).toEqual(SESSION_FIXTURE.messages.map((m) => m.info.id));
    for (const [childId, messages] of Object.entries(SESSION_FIXTURE.childSessions)) {
      expect(state.getMessages(childId).length).toBe(messages.length);
      expect(state.sessionStatus[childId]?.type).toBe(SESSION_FIXTURE.childStatuses[childId]?.type);
    }
    expect(state.sessionStatus[ROOT]).toEqual({ type: 'busy' });
  });

  test('retry mode stores the retry frame; the cleanup clears every fixture session', () => {
    const cleanup = seedSessionFixture('retry');
    expect(useSessionStateStore.getState().sessionStatus[ROOT]).toEqual(fixtureStatus('retry'));
    cleanup();
    const state = useSessionStateStore.getState();
    for (const id of fixtureSessionIds()) expect(state.getMessages(id)).toEqual([]);
  });

  test("turns match the fixture's user messages and the SDK's working-turn resolver", () => {
    const turns = fixtureTurns();
    const userIds = SESSION_FIXTURE.messages.filter((m) => m.info.role === 'user').map((m) => m.info.id);
    expect(turns.map((t) => t.userMessage.info.id)).toEqual(userIds);
    const resolved = resolveWorkingTurn({ turns, hintMessageId: null });
    expect(resolved.workingTurnId).toBe(SESSION_FIXTURE.working.userMessageId);
    expect([...fixturePendingTurnIds()]).toEqual([...resolved.pendingTurnIds]);
  });
});
