import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { PUBLIC_SHARE_BLOCKED_PORTS } from '../shared/session-public-shares';
import { SESSION_DATA_PORTS, carriesSessionData } from './session-data-ports';

describe('carriesSessionData', () => {
  test('the daemon port is gated', () => {
    expect(carriesSessionData(8000)).toBe(true);
  });

  test('opencode 4096 is gated — THE LEAK', () => {
    // Daytona's routeIngress is a pass-through, so a client-addressed :4096 stays
    // :4096. Gating on 8000 alone let a sandbox token reach ANOTHER end-user's
    // conversation there, because ownership alone cannot separate end-users when
    // every KaaB session shares one created_by.
    expect(carriesSessionData(4096)).toBe(true);
  });

  test('ordinary user ports are NOT gated — dev servers must stay reachable', () => {
    // Over-gating would break the product: a user's own app on :3000 has nothing
    // to do with session visibility.
    for (const port of [3000, 5173, 8080, 80, 443]) {
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

describe('no auth guard keys on a bare port number', () => {
  test('preview.ts has no `=== 8000` gate left', () => {
    // Strix caught the first cut of this fix: the HTTP proxy was updated and the
    // WebSocket resolver in the SAME FILE still keyed on 8000, so the PTY/opencode
    // WS leg stayed ungated on Daytona. Three call sites had to change, not one.
    //
    // A literal port comparison in an authorization decision is the shape of that
    // bug, so it is banned here rather than left to the next reviewer to notice.
    const source = readFileSync(
      join(import.meta.dir, 'routes', 'preview.ts'),
      'utf8',
    );
    const offenders = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /(?:upstreamPort|effectivePort)\s*===\s*8000/.test(line));
    expect(offenders).toEqual([]);
  });
});
