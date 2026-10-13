import { describe, expect, test } from 'bun:test';
import type { useSession } from '../use-session';
import type { useChatTurns } from './use-chat-turns';

// Type-level: these lines fail `tsc` (the SDK `typecheck` gate) when the
// parameter rejects what a host holds. `bun test` only runs the runtime assert.
type SessionMessages = ReturnType<typeof useSession>['messages'];
type TurnsInput = Parameters<typeof useChatTurns>[0];

/** `session.messages` feeds `useChatTurns` with no cast. */
export const fromSession = (messages: SessionMessages): TurnsInput => messages;
/** A frozen or `readonly` transcript (a store snapshot) does too. */
export const fromReadonly = (messages: readonly SessionMessages[number][]): TurnsInput => messages;

describe('useChatTurns input type', () => {
  test('accepts session.messages and a readonly transcript', () => {
    expect(typeof fromSession).toBe('function');
    expect(typeof fromReadonly).toBe('function');
  });
});
