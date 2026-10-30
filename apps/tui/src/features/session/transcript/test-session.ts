/**
 * Fixtures for the transcript and prompt tests.
 *
 * Wire shapes are copied from the SDK's own turn fixtures
 * (`packages/sdk/src/core/turns/classify.test.ts`), so a card is asserted
 * against the data the runtime really sends — including the bash tool's
 * `<exit_code>` tail, which is the only place a shell exit code exists.
 *
 * `fakeSession` builds the minimal `useSession` return the transcript reads and
 * casts it: the real type has ~60 fields and the transcript touches 15 of them,
 * so a full mock would be 45 lies. The transcript renders the session log
 * (`useSessionLogThread`), which reads the SDK's store, so `fakeSession` puts
 * `messages` there for runtime session `s1`, as the runtime read would.
 */

import type { MessageWithParts } from '@kortix/sdk';
import { useSessionStateStore } from '@kortix/sdk/react';

import type { SessionState } from './transcript.tsx';

export function textPart(id: string, text: string, synthetic = false) {
  return { id, sessionID: 's1', messageID: 'm', type: 'text', text, synthetic };
}

export function toolPart(
  id: string,
  tool: string,
  status: 'pending' | 'running' | 'completed' | 'error',
  input: Record<string, unknown>,
  output?: string,
  error?: string,
) {
  const state =
    status === 'completed'
      ? { status, input, output: output ?? '', time: { start: 0, end: 1 } }
      : status === 'error'
        ? { status, input, error: error ?? 'failed', time: { start: 0, end: 1 } }
        : { status, input, time: { start: 0 } };
  return { id, sessionID: 's1', messageID: 'm', type: 'tool', tool, callID: `c-${id}`, state };
}

/** Real bash-tool output: the exit code only exists inside this tail. */
export function shellOutput(stdout: string, exitCode = 0): string {
  return `${stdout}\n<exit_code>${exitCode}</exit_code>`;
}

export function message(
  id: string,
  role: 'user' | 'assistant',
  parts: unknown[],
  info: Record<string, unknown> = {},
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: 's1',
      role,
      time: { created: Date.now() - 60_000 },
      agent: role === 'assistant' ? 'galileo' : 'build',
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      ...info,
    },
    parts,
  } as unknown as MessageWithParts;
}

const IDLE_WORKING = { state: 'idle' as const, since: 0, source: 'server' as const, turnId: null };

/**
 * Put the fake's `messages` in the SDK store under its runtime session, alone.
 * The store keys parts by message id, and the fixtures reuse ids, so a test that
 * renders a fake built earlier (at describe time) seeds it again first.
 */
export function seedSessionStore(session: SessionState): void {
  const store = useSessionStateStore.getState();
  store.reset();
  store.hydrate('s1', session.messages as unknown as MessageWithParts[]);
}

export function fakeSession(overrides: Record<string, unknown> = {}): SessionState {
  const session = {
    projectId: 'p1',
    sessionId: 's1',
    runtimeSessionId: 's1',
    messages: [],
    questions: [],
    permissions: [],
    hasOlder: false,
    isLoadingOlder: false,
    loadOlder: () => {},
    phase: 'ready',
    stage: 'ready',
    working: IDLE_WORKING,
    isBusy: false,
    sendError: null,
    startError: null,
    failure: null,
    answerQuestion: async () => {},
    rejectQuestion: async () => {},
    answerPermission: async () => {},
    ...overrides,
  } as unknown as SessionState;
  seedSessionStore(session);
  return session;
}
