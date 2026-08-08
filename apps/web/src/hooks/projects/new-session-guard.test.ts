import { beforeEach, describe, expect, test } from 'bun:test';

import {
  canBeginNewSession,
  hasLandedOnNewSession,
  pendingNewSessionPath,
  useNewSessionGuardStore,
} from './new-session-guard';

const P = 'proj-1';

beforeEach(() => {
  useNewSessionGuardStore.setState({ pending: {} });
});

describe('canBeginNewSession', () => {
  test('allows a create when the project holds no claim', () => {
    expect(canBeginNewSession({}, P)).toBe(true);
  });

  test('blocks a create while the project holds a claim', () => {
    expect(canBeginNewSession({ [P]: { sessionId: null } }, P)).toBe(false);
    expect(canBeginNewSession({ [P]: { sessionId: 'sess-1' } }, P)).toBe(false);
  });

  test('scopes the claim to its own project', () => {
    expect(canBeginNewSession({ 'proj-2': { sessionId: null } }, P)).toBe(true);
  });
});

describe('the click guard', () => {
  // The reported bug: 10 rapid clicks minted 8 sessions, because the old
  // per-instance ref released as soon as `POST /sessions` resolved.
  test('ten rapid activations claim the guard exactly once', () => {
    const store = useNewSessionGuardStore.getState();
    const granted = Array.from({ length: 10 }, () => store.begin(P));
    expect(granted.filter(Boolean)).toHaveLength(1);
    expect(granted[0]).toBe(true);
  });

  test('the claim survives the create resolving and releases on landing', () => {
    const store = useNewSessionGuardStore.getState();
    expect(store.begin(P)).toBe(true);
    store.target(P, 'sess-1');

    const midFlight = useNewSessionGuardStore.getState().pending;
    expect(canBeginNewSession(midFlight, P)).toBe(false);
    expect(pendingNewSessionPath(midFlight, P)).toBe(
      '/workspaces/proj-1/sessions/sess-1',
    );
    expect(hasLandedOnNewSession(midFlight, P, '/workspaces/proj-1')).toBe(
      false,
    );
    expect(
      hasLandedOnNewSession(
        midFlight,
        P,
        '/workspaces/proj-1/sessions/sess-1',
      ),
    ).toBe(true);

    useNewSessionGuardStore.getState().settle(P);
    expect(canBeginNewSession(useNewSessionGuardStore.getState().pending, P)).toBe(true);
  });

  test('releasing one project does not release another', () => {
    const store = useNewSessionGuardStore.getState();
    store.begin(P);
    store.begin('proj-2');
    useNewSessionGuardStore.getState().settle(P);
    const pending = useNewSessionGuardStore.getState().pending;
    expect(canBeginNewSession(pending, P)).toBe(true);
    expect(canBeginNewSession(pending, 'proj-2')).toBe(false);
  });

  test('a settled project can start a second session', () => {
    const store = useNewSessionGuardStore.getState();
    expect(store.begin(P)).toBe(true);
    useNewSessionGuardStore.getState().settle(P);
    expect(useNewSessionGuardStore.getState().begin(P)).toBe(true);
  });

  test('target on an unclaimed project writes nothing', () => {
    useNewSessionGuardStore.getState().target(P, 'sess-1');
    expect(useNewSessionGuardStore.getState().pending[P]).toBeUndefined();
  });

  test('settle is a no-op when nothing is pending', () => {
    const before = useNewSessionGuardStore.getState().pending;
    useNewSessionGuardStore.getState().settle(P);
    expect(useNewSessionGuardStore.getState().pending).toBe(before);
  });
});

describe('hasLandedOnNewSession', () => {
  test('is false before the create resolves a session id', () => {
    expect(
      hasLandedOnNewSession(
        { [P]: { sessionId: null } },
        P,
        '/workspaces/proj-1',
      ),
    ).toBe(false);
  });

  test('is false without a pathname', () => {
    expect(hasLandedOnNewSession({ [P]: { sessionId: 'sess-1' } }, P, null)).toBe(false);
  });

  test('does not match a different session on the same project', () => {
    expect(
      hasLandedOnNewSession(
        { [P]: { sessionId: 'sess-1' } },
        P,
        '/workspaces/proj-1/sessions/sess-2',
      ),
    ).toBe(false);
  });
});
