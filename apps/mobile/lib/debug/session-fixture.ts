/**
 * Seeds the COR-91 parity fixture (`@kortix/shared/session-fixture`) into the
 * SDK's session store, so the debug screen renders it through the same session
 * log read (`useSessionLogThread`), `sessionLogTurns`, and `SessionTurn` rows as
 * `SessionPage`.
 *
 * Nothing here touches the network: the store is a plain zustand store, and
 * the fixture session ids (`ses_FixtureParity…`) never reach a sandbox.
 */

import { sessionLogTurns, type SessionLogThread, type SessionLogTurn } from '@kortix/sdk';
import { SESSION_FIXTURE, type SessionFixture } from '@kortix/shared/session-fixture';
import { useRuntimePendingStore, useSessionStateStore } from '@kortix/sdk/react';
import type { PermissionRequest, QuestionRequest, SessionStatus } from '@/lib/session/types';
import type { QueuedPromptState } from '@/lib/session/user-message';

export type FixtureStatusMode = 'busy' | 'retry';

/** The root session id plus every child session id the fixture carries. */
export function fixtureSessionIds(fixture: SessionFixture = SESSION_FIXTURE): string[] {
  return [fixture.sessionId, ...Object.keys(fixture.childSessions)];
}

/** The session status the working turn reads in `mode`. */
export function fixtureStatus(mode: FixtureStatusMode, fixture: SessionFixture = SESSION_FIXTURE): SessionStatus {
  return mode === 'retry' ? { ...fixture.working.retryStatus } : { ...fixture.working.status };
}

/**
 * Writes the fixture into the sync store: root + child transcripts, the root
 * session status, the pending question and permission. Evicts earlier fixture
 * state first, so a remount starts from the same data. Returns the cleanup.
 */
export function seedSessionFixture(
  mode: FixtureStatusMode = 'busy',
  fixture: SessionFixture = SESSION_FIXTURE,
): () => void {
  const ids = fixtureSessionIds(fixture);
  const store = useSessionStateStore.getState();
  const pending = useRuntimePendingStore.getState();
  const evict = () => {
    for (const id of ids) useSessionStateStore.getState().clearSession(id);
    // The fixture's requests are the only ones a debug screen can hold.
    useRuntimePendingStore.getState().clear();
  };
  evict();
  // The fixture satisfies the SDK types (lib/debug/session-fixture.types.test.ts).
  store.hydrate(fixture.sessionId, fixture.messages as never);
  for (const [childId, messages] of Object.entries(fixture.childSessions)) {
    store.hydrate(childId, messages as never);
  }
  store.setStatus(fixture.sessionId, fixtureStatus(mode, fixture));
  for (const [childId, status] of Object.entries(fixture.childStatuses)) store.setStatus(childId, { ...status });
  for (const question of fixture.questions) pending.addQuestion(question as unknown as QuestionRequest);
  for (const permission of fixture.permissions) pending.addPermission(permission as unknown as PermissionRequest);
  return evict;
}

/** The fixture thread's turns, as `SessionPage` builds them; the fixture names the working turn. */
export function fixtureTurns(
  thread: SessionLogThread | null,
  busy: boolean,
  fixture: SessionFixture = SESSION_FIXTURE,
): SessionLogTurn[] {
  return thread ? sessionLogTurns(thread, { busy, liveMessageId: fixture.working.userMessageId }) : [];
}

/** The queue state a turn row shows (`interrupted` before a run, `queued` behind the working turn). */
export function fixtureQueueState(
  userMessageId: string,
  fixture: SessionFixture = SESSION_FIXTURE,
): QueuedPromptState | null {
  return fixture.queueStates[userMessageId] ?? null;
}

/** User message ids of the queued turns — `SessionPage`'s `pendingTurnIds`. */
export function fixturePendingTurnIds(fixture: SessionFixture = SESSION_FIXTURE): Set<string> {
  return new Set(
    Object.entries(fixture.queueStates).flatMap(([id, state]) => (state === 'queued' ? [id] : [])),
  );
}
