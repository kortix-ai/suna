import { describe, expect, test } from 'bun:test';

import { OPENCODE_PORTS } from '../shared/opencode-ports';
import {
  PROXY_HOP_HEADER,
  PROXY_UPSTREAM_STATUS_HEADER,
  portFailureHop,
  type ProxyHop,
} from './proxy-hop';

// The whole point of the hop is that a client can tell "your box is gone" from
// "your own dev server isn't listening" without parsing prose. These cases pin
// which port maps to which answer.
describe('portFailureHop', () => {
  test('the daemon port owns a failure on the session conversation path', () => {
    expect(portFailureHop(8000)).toBe('daemon');
  });

  test("opencode's own ports are the daemon too — the provider decides which one is addressed", () => {
    for (const port of OPENCODE_PORTS) {
      expect(portFailureHop(port)).toBe('daemon');
    }
  });

  test("an ordinary app port is the user's own process, never the runtime", () => {
    expect(portFailureHop(3000)).toBe('upstream_port');
    expect(portFailureHop(8080)).toBe('upstream_port');
    // 3211 is the in-box static-file listener: still user content, not the
    // daemon, so a dead one must not read as "the sandbox is gone".
    expect(portFailureHop(3211)).toBe('upstream_port');
  });
});

describe('hop header names', () => {
  test('are the exact strings the SDK probe reads', () => {
    // `packages/sdk/src/core/session/health.ts` looks these up verbatim. A
    // rename on one side alone silently drops attribution back to null.
    expect(PROXY_HOP_HEADER).toBe('X-Kortix-Proxy-Hop');
    expect(PROXY_UPSTREAM_STATUS_HEADER).toBe('X-Kortix-Upstream-Status');
  });

  test('the four hops are the closed set both sides agree on', () => {
    const hops: ProxyHop[] = ['control_plane', 'provider_ingress', 'daemon', 'upstream_port'];
    expect(hops).toHaveLength(4);
  });
});
