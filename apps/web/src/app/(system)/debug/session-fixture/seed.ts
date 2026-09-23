/**
 * Seeds the COR-91 parity fixture into the SDK session store, so the task /
 * agent_spawn / session_spawn renderers find their child transcripts through
 * `useRuntimeMessages` exactly as they do in a live session.
 *
 * React-free and network-free: the store is a zustand store, and the fixture
 * ids (`ses_FixtureParity…`, `ses_FixtureChild…`) never reach a runtime.
 */

import { SESSION_FIXTURE, type SessionFixture } from '@kortix/shared/session-fixture';
import { groupMessagesIntoTurns } from '@kortix/sdk';
import { useSessionStateStore } from '@kortix/sdk/react';
import type { MessageWithParts, SessionStatus, Turn } from '@/ui';

export type FixtureStatusMode = 'busy' | 'retry';

export function fixtureSessionIds(fixture: SessionFixture = SESSION_FIXTURE): string[] {
  return [fixture.sessionId, ...Object.keys(fixture.childSessions)];
}

/** The session status the working turn reads in `mode`. */
export function fixtureStatus(
  mode: FixtureStatusMode,
  fixture: SessionFixture = SESSION_FIXTURE,
): SessionStatus {
  return mode === 'retry' ? { ...fixture.working.retryStatus } : { ...fixture.working.status };
}

/**
 * Writes the root and child transcripts and statuses into the store (after
 * clearing earlier fixture state). Returns the cleanup that clears them again.
 */
export function seedSessionFixture(
  mode: FixtureStatusMode = 'busy',
  fixture: SessionFixture = SESSION_FIXTURE,
): () => void {
  const ids = fixtureSessionIds(fixture);
  const store = useSessionStateStore.getState();
  for (const id of ids) store.clearSession(id);
  store.hydrate(fixture.sessionId, fixture.messages);
  for (const [childId, messages] of Object.entries(fixture.childSessions)) {
    store.hydrate(childId, messages);
  }
  store.setStatus(fixture.sessionId, fixtureStatus(mode, fixture));
  for (const [childId, status] of Object.entries(fixture.childStatuses)) {
    store.setStatus(childId, { ...status });
  }
  return () => {
    const current = useSessionStateStore.getState();
    for (const id of ids) current.clearSession(id);
  };
}

/** The root transcript as turns, grouped by the SDK as `SessionChat` does. */
export function fixtureTurns(fixture: SessionFixture = SESSION_FIXTURE): Turn[] {
  return groupMessagesIntoTurns(fixture.messages as MessageWithParts[]) as Turn[];
}

/** User message ids of the turns queued behind the working turn (`pendingTurnIds`). */
export function fixturePendingTurnIds(fixture: SessionFixture = SESSION_FIXTURE): Set<string> {
  return new Set(
    Object.entries(fixture.queueStates).flatMap(([id, state]) => (state === 'queued' ? [id] : [])),
  );
}
