import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  SESSION_TOKEN_DEAD_TRIP_THRESHOLD,
  noteControlPlaneResponse,
  resetSessionTokenHealthForTests,
  sessionTokenPresumedDead,
} from '@/lib/kortix-api/session-token-health';

// PROD 76h window: 404,982 "401 Session token is not active" rejections
// across 95 projects, one box posting for a full 12h after its lease closed.
// No call site backed off on the ONE error the API can never take back. The
// breaker must recognise that streak, and nothing else (a transient 401, a
// 5xx, a reset streak) may trip it early.
//
// It must NOT end the process. See the second describe block: a dead token is
// the control plane's fault, never the box's, and the daemon that shuts itself
// down over one is unrecoverable — Platinum's pt-init launches the chain once
// and never again, so exit 0 leaves a running VM with nothing serving on it.
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
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD - 1; i++) {
      noteControlPlaneResponse(401, 'Session token is not active');
    }

    expect(sessionTokenPresumedDead()).toBe(false);
  });

  test('trips once the threshold is reached, and stays tripped', () => {
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD + 5; i++) {
      noteControlPlaneResponse(401, 'Session token is not active');
    }

    expect(sessionTokenPresumedDead()).toBe(true);
  });

  test('a healthy response clears the breaker: the control plane can rotate the credential', () => {
    // The old premise was "a dead session token never recovers", which made
    // the trip terminal. It is false: `rotateKortixToken`/`commitKortixToken`
    // install a fresh credential in the box, and a wrong sandbox row that
    // killed the old one is itself reconciled (reaping/row-vm-divergence.ts).
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD + 2; i++) {
      noteControlPlaneResponse(401, 'Session token is not active');
    }
    expect(sessionTokenPresumedDead()).toBe(true);

    noteControlPlaneResponse(200, null);

    expect(sessionTokenPresumedDead()).toBe(false);
  });

  test('is case-insensitive and ignores surrounding text', () => {
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD; i++) {
      noteControlPlaneResponse(401, '{"error":"SESSION TOKEN IS NOT ACTIVE","code":"token_inactive"}');
    }

    expect(sessionTokenPresumedDead()).toBe(true);
  });

  test('an unrelated 401 (bad signature, malformed context) never trips it', () => {
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD + 5; i++) {
      noteControlPlaneResponse(401, 'malformed user context');
    }

    expect(sessionTokenPresumedDead()).toBe(false);
  });

  test('a 5xx never trips it — only the API affirmatively saying the token is dead does', () => {
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD + 5; i++) {
      noteControlPlaneResponse(503, 'upstream unavailable');
    }

    expect(sessionTokenPresumedDead()).toBe(false);
  });

  test('a success in between resets the streak — a genuinely dead token never recovers, so this only ever protects a flapping/transient case', () => {
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD - 1; i++) {
      noteControlPlaneResponse(401, 'Session token is not active');
    }
    noteControlPlaneResponse(200, null);
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD - 1; i++) {
      noteControlPlaneResponse(401, 'Session token is not active');
    }

    expect(sessionTokenPresumedDead()).toBe(false);
  });

  // The API emits four terminal credential-state reasons
  // (apps/api/src/repositories/account-tokens.ts). Prod 2026-09-28: 6,514
  // `POST turn-stream -> 401 PAT not found or revoked` in 2h from one
  // workspace, sustained near 1/s — the breaker never tripped on that class,
  // and every such response reset the streak the base reason had built.
  test('trips on every terminal credential reason the API emits', () => {
    for (const reason of [
      'PAT not found or revoked',
      'PAT expired',
      'PAT auto-revoked due to inactivity',
    ]) {
      resetSessionTokenHealthForTests();
      for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD; i++) {
        noteControlPlaneResponse(401, reason);
      }
      expect(sessionTokenPresumedDead()).toBe(true);
    }
  });

  test('the terminal reasons share one streak — mixed reasons still trip', () => {
    noteControlPlaneResponse(401, 'Session token is not active');
    noteControlPlaneResponse(401, 'PAT not found or revoked');
    noteControlPlaneResponse(401, 'Session token is not active');
    noteControlPlaneResponse(401, 'PAT expired');
    noteControlPlaneResponse(401, 'PAT auto-revoked due to inactivity');

    expect(sessionTokenPresumedDead()).toBe(true);
  });

  test('a non-terminal 401 between terminal ones still resets the streak', () => {
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD - 1; i++) {
      noteControlPlaneResponse(401, 'PAT not found or revoked');
    }
    noteControlPlaneResponse(401, 'malformed user context');
    noteControlPlaneResponse(401, 'PAT not found or revoked');

    expect(sessionTokenPresumedDead()).toBe(false);
  });
});
