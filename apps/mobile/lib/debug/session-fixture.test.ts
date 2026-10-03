import { afterEach, describe, expect, test } from 'bun:test';
import { resolveWorkingTurn } from '@kortix/sdk';
import { SESSION_FIXTURE } from '@kortix/shared/session-fixture';

import { useRuntimePendingStore, useSessionStateStore } from '@kortix/sdk/react';
import { sessionRows } from '@/lib/session/session-store';
import { hasCompactionTurn, type TurnBodyTurn } from '@/lib/session/turn-body';
import {
  fixturePendingTurnIds,
  fixtureQueueState,
  fixtureSessionIds,
  fixtureStatus,
  fixtureTurns,
  seedSessionFixture,
} from './session-fixture';

const ROOT = SESSION_FIXTURE.sessionId;

afterEach(() => {
  for (const id of fixtureSessionIds()) useSessionStateStore.getState().clearSession(id);
  useRuntimePendingStore.getState().clear();
});

const pendingFor = (sessionId: string) => {
  const pending = useRuntimePendingStore.getState();
  return {
    questions: Object.values(pending.questions).filter((q) => q.sessionID === sessionId),
    permissions: Object.values(pending.permissions).filter((p) => p.sessionID === sessionId),
  };
};

describe('seedSessionFixture', () => {
  test('hydrates the root and every child transcript, status, question, and permission', () => {
    seedSessionFixture('busy');
    const state = useSessionStateStore.getState();
    expect(state.messages[ROOT]?.length).toBe(SESSION_FIXTURE.messages.length);
    for (const [childId, messages] of Object.entries(SESSION_FIXTURE.childSessions)) {
      expect(state.messages[childId]?.length).toBe(messages.length);
    }
    expect(state.sessionStatus[ROOT]).toEqual({ type: 'busy' });
    for (const [childId, status] of Object.entries(SESSION_FIXTURE.childStatuses)) {
      expect(state.sessionStatus[childId]).toEqual(status);
    }
    const pending = pendingFor(ROOT);
    expect(pending.questions.map((q) => q.tool?.callID)).toEqual(SESSION_FIXTURE.questions.map((q) => q.tool?.callID));
    expect(pending.permissions.map((p) => p.tool?.callID)).toEqual(SESSION_FIXTURE.permissions.map((p) => p.tool?.callID));
  });

  test('a second seed replaces the first instead of duplicating questions and permissions', () => {
    seedSessionFixture('busy');
    seedSessionFixture('retry');
    expect(pendingFor(ROOT).questions.length).toBe(1);
    expect(pendingFor(ROOT).permissions.length).toBe(1);
    expect(useSessionStateStore.getState().sessionStatus[ROOT]?.type).toBe('retry');
  });

  test('the cleanup empties every fixture session', () => {
    const cleanup = seedSessionFixture('busy');
    cleanup();
    // The SDK store clears a session to an empty transcript (it has no evict).
    for (const id of fixtureSessionIds()) expect(sessionRows(id)).toEqual([]);
    expect(pendingFor(ROOT).questions).toEqual([]);
  });
});

describe('fixture turns', () => {
  test('store messages group into one turn per user message, in fixture order', () => {
    seedSessionFixture('busy');
    const turns = fixtureTurns(sessionRows(ROOT));
    const userIds = SESSION_FIXTURE.messages.filter((m) => m.info.role === 'user').map((m) => m.info.id);
    expect(turns.map((t) => t.userMessage.info.id)).toEqual(userIds);
  });

  test("the SDK's working-turn resolver agrees with the fixture's working turn", () => {
    const turns = fixtureTurns(SESSION_FIXTURE.messages as never);
    const resolved = resolveWorkingTurn({ turns: turns as never, hintMessageId: null });
    expect(resolved.workingTurnId).toBe(SESSION_FIXTURE.working.userMessageId);
    expect([...fixturePendingTurnIds()]).toEqual(resolved.pendingTurnIds as string[]);
  });

  test('the compaction turn renders as a landed marker', () => {
    const turns = fixtureTurns(SESSION_FIXTURE.messages as never) as unknown as TurnBodyTurn[];
    expect(hasCompactionTurn(turns)).toBe(true);
  });

  test('queue states map to the interrupted and queued rows', () => {
    const states = SESSION_FIXTURE.messages
      .filter((m) => m.info.role === 'user')
      .map((m) => fixtureQueueState(m.info.id))
      .filter(Boolean);
    expect(states).toEqual(['interrupted', 'queued']);
  });

  test('retry mode hands the working turn a retry frame', () => {
    expect(fixtureStatus('retry')).toEqual(SESSION_FIXTURE.working.retryStatus);
    expect(fixtureStatus('busy')).toEqual({ type: 'busy' });
  });
});
