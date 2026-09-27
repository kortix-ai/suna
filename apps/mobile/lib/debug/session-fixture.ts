/**
 * Seeds the COR-91 parity fixture (`@kortix/shared/session-fixture`) into the
 * sync store, so the debug screen renders it through the same store read,
 * `groupMessagesIntoTurns`, and `SessionTurn` rows as `SessionPage`.
 *
 * Nothing here touches the network: the store is a plain zustand store, and
 * the fixture session ids (`ses_FixtureParity…`) never reach a sandbox.
 */

import { groupMessagesIntoTurns } from '@kortix/sdk';
import { SESSION_FIXTURE, type SessionFixture } from '@kortix/shared/session-fixture';
import { useSyncStore } from '@/lib/opencode/sync-store';
import type {
  MessageWithParts,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
  Turn,
} from '@/lib/opencode/types';
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
  const store = useSyncStore.getState();
  store.evictSessions(ids);
  // Mobile's wire types are a local copy of the SDK's; the fixture satisfies
  // the SDK types (lib/debug/session-fixture.types.test.ts).
  store.hydrate(fixture.sessionId, fixture.messages as unknown as MessageWithParts[]);
  for (const [childId, messages] of Object.entries(fixture.childSessions)) {
    store.hydrate(childId, messages as unknown as MessageWithParts[]);
  }
  store.setStatus(fixture.sessionId, fixtureStatus(mode, fixture));
  for (const [childId, status] of Object.entries(fixture.childStatuses)) store.setStatus(childId, { ...status });
  for (const question of fixture.questions) {
    store.addQuestion(fixture.sessionId, question as unknown as QuestionRequest);
  }
  for (const permission of fixture.permissions) {
    // Mobile's local PermissionRequest still names the v1 `input` field.
    const request: PermissionRequest = { ...permission, input: permission.metadata };
    store.addPermission(fixture.sessionId, request);
  }
  return () => useSyncStore.getState().evictSessions(ids);
}

/** Groups store messages into turns, as `SessionPage` does. */
export function fixtureTurns(messages: readonly MessageWithParts[]): Turn[] {
  return groupMessagesIntoTurns(messages as MessageWithParts[]) as unknown as Turn[];
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
