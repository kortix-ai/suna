import { describe, expect, test } from 'bun:test';

import { sessionMayEnumerateConnection } from './connector-connection-visibility';

const connection = (connectionId: string, ownerType: string, ownerId: string | null = null) => ({
  connectionId,
  ownerType,
  ownerId,
});

const WRAPPER_OPERATOR = null; // not session-bound
const BOUND = new Set(['p-mine']);

describe('sessionMayEnumerateConnection', () => {
  test('a caller that is NOT session-bound is unaffected', () => {
    // The dashboard user, the wrapper's operator credential and the laptop CLI
    // all enumerate their own account's connections. This narrowing is for sandboxes
    // only, and must not change what an operator sees.
    for (const owner of ['project', 'member', 'external']) {
      expect(sessionMayEnumerateConnection(connection('p-any', owner), WRAPPER_OPERATOR)).toBe(true);
    }
  });

  test('THE LEAK: another end-user’s external connection is hidden from a sandbox', () => {
    // The escalation this closes: an agent in end-user A's session reads B's
    // connection_id + owner_id + label off this list, then starts a session bound to
    // it and runs as B's connected account. `mayManageSystemConnections` was true
    // for the token because it carries the WRAPPER's user id.
    expect(sessionMayEnumerateConnection(connection('p-theirs', 'external', 'end-user-b'), BOUND)).toBe(
      false,
    );
  });

  test('a session CAN see the external connection it was actually bound to', () => {
    // Otherwise the binding a wrapper deliberately handed the session becomes
    // invisible to it, which breaks the legitimate flow.
    expect(sessionMayEnumerateConnection(connection('p-mine', 'external', 'end-user-a'), BOUND)).toBe(
      true,
    );
  });

  test('project connections stay visible — the project already publishes them', () => {
    // A connector may hold several project connections (support@, sales@) and they
    // are visible to every project member by design. Hiding them from a sandbox
    // would break connector use without protecting anything.
    expect(sessionMayEnumerateConnection(connection('p-project', 'project'), BOUND)).toBe(true);
  });

  test('someone’s PRIVATE member connection is hidden unless bound', () => {
    expect(sessionMayEnumerateConnection(connection('p-private', 'member', 'human-1'), BOUND)).toBe(false);
  });

  test('an EMPTY bound set hides everything except project connections', () => {
    // A session with no bindings at all is the common KaaB case. Empty must mean
    // "bound to nothing", not "unbound, so show everything" — treating an empty
    // set as absent is exactly how this kind of guard fails open.
    const none: ReadonlySet<string> = new Set();
    expect(sessionMayEnumerateConnection(connection('p-x', 'external', 'b'), none)).toBe(false);
    expect(sessionMayEnumerateConnection(connection('p-project', 'project'), none)).toBe(true);
  });

  test('an unknown owner_type is hidden, not shown', () => {
    // Fail closed on a value this code does not recognise: a future owner class
    // should have to be added deliberately, not inherit visibility by default.
    expect(sessionMayEnumerateConnection(connection('p-future', 'something_new'), BOUND)).toBe(false);
  });
});
