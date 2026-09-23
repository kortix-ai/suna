import { afterEach, describe, expect, test } from 'bun:test';
import { resolveWorkingTurn } from '@kortix/sdk';
import { SESSION_FIXTURE } from '@kortix/shared/session-fixture';

import { useSyncStore } from '@/lib/opencode/sync-store';
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
  useSyncStore.getState().evictSessions(fixtureSessionIds());
});

describe('seedSessionFixture', () => {
  test('hydrates the root and every child transcript, status, question, and permission', () => {
    seedSessionFixture('busy');
    const state = useSyncStore.getState();
    expect(state.messages[ROOT]?.length).toBe(SESSION_FIXTURE.messages.length);
    for (const [childId, messages] of Object.entries(SESSION_FIXTURE.childSessions)) {
      expect(state.messages[childId]?.length).toBe(messages.length);
    }
    expect(state.sessionStatus[ROOT]).toEqual({ type: 'busy' });
    for (const [childId, status] of Object.entries(SESSION_FIXTURE.childStatuses)) {
      expect(state.sessionStatus[childId]).toEqual(status);
    }
    expect(state.questions[ROOT]?.map((q) => q.tool?.callID)).toEqual(SESSION_FIXTURE.questions.map((q) => q.tool?.callID));
    expect(state.permissions[ROOT]?.map((p) => p.tool?.callID)).toEqual(SESSION_FIXTURE.permissions.map((p) => p.tool?.callID));
  });

  test('a second seed replaces the first instead of duplicating questions and permissions', () => {
    seedSessionFixture('busy');
    seedSessionFixture('retry');
    const state = useSyncStore.getState();
    expect(state.questions[ROOT]?.length).toBe(1);
    expect(state.permissions[ROOT]?.length).toBe(1);
    expect(state.sessionStatus[ROOT]?.type).toBe('retry');
  });

  test('the cleanup evicts every fixture session', () => {
    const cleanup = seedSessionFixture('busy');
    cleanup();
    const state = useSyncStore.getState();
    for (const id of fixtureSessionIds()) expect(state.messages[id]).toBeUndefined();
  });
});

describe('fixture turns', () => {
  test('store messages group into one turn per user message, in fixture order', () => {
    seedSessionFixture('busy');
    const turns = fixtureTurns(useSyncStore.getState().messages[ROOT] ?? []);
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
