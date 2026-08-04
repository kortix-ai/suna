import { describe, expect, test } from 'bun:test';

import { sessionTurnPropsAreEqual } from './session-turn-memo';

const turn = { userMessage: { info: { id: 'u1', role: 'user' }, parts: [] }, assistantMessages: [] };

const base = {
  turn,
  isLastUserTurn: false,
  isPlanAnchor: false,
  sessionId: 's1',
  sessionStatus: undefined,
  permissions: [],
  questions: [],
  agentNames: undefined,
  isFirstTurn: true,
  isBusy: false,
  isCompaction: false,
  providers: undefined,
  commandMessages: undefined,
  commands: undefined,
  disableToolNavigation: false,
  onPermissionReply: () => {},
  onRewind: () => {},
  rewindDisabled: false,
} as unknown as Parameters<typeof sessionTurnPropsAreEqual>[0];

describe('sessionTurnPropsAreEqual', () => {
  test('skips the re-render when every prop is reference-equal', () => {
    expect(sessionTurnPropsAreEqual(base, { ...base })).toBe(true);
  });

  test('re-renders when the turn identity changed', () => {
    expect(sessionTurnPropsAreEqual(base, { ...base, turn: { ...base.turn } })).toBe(false);
  });

  test('re-renders when isBusy flips', () => {
    expect(sessionTurnPropsAreEqual(base, { ...base, isBusy: true })).toBe(false);
  });

  test('re-renders when this turn becomes the last user turn', () => {
    expect(sessionTurnPropsAreEqual(base, { ...base, isLastUserTurn: true })).toBe(false);
  });

  test('re-renders when a new permission array arrives', () => {
    expect(sessionTurnPropsAreEqual(base, { ...base, permissions: [] })).toBe(false);
  });
});
