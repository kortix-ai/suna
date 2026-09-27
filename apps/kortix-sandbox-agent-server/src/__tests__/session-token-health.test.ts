import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  SESSION_TOKEN_DEAD_TRIP_THRESHOLD,
  configureSessionTokenHealth,
  noteControlPlaneResponse,
  resetSessionTokenHealthForTests,
} from '../lib/kortix-api/session-token-health';

// PROD 76h window: 404,982 "401 Session token is not active" rejections
// across 95 projects, one box posting for a full 12h after its lease closed.
// No call site backed off on the ONE error the API can never take back. This
// is the regression guard for the daemon's side of the fix: a repeated dead
// -token signal must trip the breaker exactly once, and nothing else
// (a transient 401, a 5xx, a reset streak) may trip it early.
describe('session-token-health', () => {
  beforeEach(() => {
    resetSessionTokenHealthForTests();
  });

  // Module-level state (session-token-health.ts's singleton counter and
  // handler) is shared by every test file in this bun process. Resetting only
  // on the way IN protects this file; the file that runs next inherits
  // whatever this one left behind — see test-state-reset-tripwire.test.ts.
  afterEach(() => {
    resetSessionTokenHealthForTests();
  });

  test('does not trip on fewer than the threshold of consecutive dead-token signals', () => {
    let tripped = 0;
    configureSessionTokenHealth(() => {
      tripped += 1;
    });

    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD - 1; i++) {
      noteControlPlaneResponse(401, 'Session token is not active');
    }

    expect(tripped).toBe(0);
  });

  test('trips exactly once the threshold is reached, and never again', () => {
    let tripped = 0;
    configureSessionTokenHealth(() => {
      tripped += 1;
    });

    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD + 5; i++) {
      noteControlPlaneResponse(401, 'Session token is not active');
    }

    expect(tripped).toBe(1);
  });

  test('is case-insensitive and ignores surrounding text', () => {
    let tripped = 0;
    configureSessionTokenHealth(() => {
      tripped += 1;
    });

    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD; i++) {
      noteControlPlaneResponse(401, '{"error":"SESSION TOKEN IS NOT ACTIVE","code":"token_inactive"}');
    }

    expect(tripped).toBe(1);
  });

  test('an unrelated 401 (bad signature, malformed context) never trips it', () => {
    let tripped = 0;
    configureSessionTokenHealth(() => {
      tripped += 1;
    });

    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD + 5; i++) {
      noteControlPlaneResponse(401, 'malformed user context');
    }

    expect(tripped).toBe(0);
  });

  test('a 5xx never trips it — only the API affirmatively saying the token is dead does', () => {
    let tripped = 0;
    configureSessionTokenHealth(() => {
      tripped += 1;
    });

    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD + 5; i++) {
      noteControlPlaneResponse(503, 'upstream unavailable');
    }

    expect(tripped).toBe(0);
  });

  test('a success in between resets the streak — a genuinely dead token never recovers, so this only ever protects a flapping/transient case', () => {
    let tripped = 0;
    configureSessionTokenHealth(() => {
      tripped += 1;
    });

    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD - 1; i++) {
      noteControlPlaneResponse(401, 'Session token is not active');
    }
    noteControlPlaneResponse(200, null);
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD - 1; i++) {
      noteControlPlaneResponse(401, 'Session token is not active');
    }

    expect(tripped).toBe(0);
  });
});
