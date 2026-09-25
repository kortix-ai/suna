import { describe, expect, test } from 'bun:test';
import { PUBLIC_SHARE_BLOCKED_PORTS } from '../shared/session-public-shares';
import { SESSION_DATA_PORTS, carriesSessionData } from './session-data-ports';

describe('carriesSessionData', () => {
  test('the daemon port is gated', () => {
    expect(carriesSessionData(8000)).toBe(true);
  });

  // Daytona's routeIngress is a pass-through, so a client-addressed :4096 stays
  // :4096. Gating on 8000 alone let a sandbox token reach ANOTHER end-user's
  // conversation there, because ownership alone cannot separate end-users when
  // every KaaB session shares one created_by. The daemon's verified reload
  // boots the replacement opencode on the idle half of the pair, so 4097 can be
  // the live port. Literal rows: iterating the shared constant would pass when
  // someone removed 4097 from it.
  test.each([4096, 4097])('opencode %p is gated — THE LEAK', (port) => {
    expect(carriesSessionData(port)).toBe(true);
  });

  test('ordinary user ports are NOT gated — dev servers must stay reachable', () => {
    // Over-gating would break the product: a user's own app on :3000 has nothing
    // to do with session visibility. 3211 (the static-file listener) has its own
    // session gate and is deliberately not session data.
    for (const port of [3000, 5173, 8080, 80, 443, 3211]) {
      expect(carriesSessionData(port)).toBe(false);
    }
  });

  test('agrees with the public-share block list, which already knew both ports', () => {
    // shared/session-public-shares.ts blocks 4096 AND 8000 from public shares.
    // The two lists encode the same judgement; if they ever disagree, one of them
    // is wrong.
    for (const port of SESSION_DATA_PORTS) {
      expect(PUBLIC_SHARE_BLOCKED_PORTS.has(port)).toBe(true);
    }
  });
});

// The gates that consume this are proven at the route, port by port, in
// __tests__/e2e-preview-proxy.test.ts ("per-session gate on session-data ports").
