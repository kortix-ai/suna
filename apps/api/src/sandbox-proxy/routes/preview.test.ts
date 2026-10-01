import { describe, expect, test } from 'bun:test';

import { getRequestContext, runWithContext } from '../../lib/request-context';
import { PROXY_HOP_HEADER, PROXY_UPSTREAM_STATUS_HEADER } from '../proxy-hop';
import {
  STRIP_FORWARD_HEADERS,
  bindSandboxRequestContext,
  isProxiedBaseReset,
  longTurnTimeoutResponse,
  portUnreachableResponse,
  shouldAutoResumeStoppedSandbox,
} from './preview';

describe('sandbox proxy audit context', () => {
  test('binds the resolved account, project, session, and sandbox before the request audit runs', () => {
    runWithContext('POST', '/v1/p/sbx_external/8000/session/ses/message', () => {
      bindSandboxRequestContext(
        {
          accountId: 'a7100000-0000-4000-a000-000000000001',
          projectId: 'a7200000-0000-4000-a000-000000000001',
          sessionId: 'a7300000-0000-4000-a000-000000000001',
        },
        'sbx_external',
      );
      expect(getRequestContext()).toMatchObject({
        accountId: 'a7100000-0000-4000-a000-000000000001',
        projectId: 'a7200000-0000-4000-a000-000000000001',
        sessionId: 'a7300000-0000-4000-a000-000000000001',
        sandboxId: 'sbx_external',
      });
    });
  });
});

// The data-path proxy may only wake a stopped box on explicit user intent.
// Passive transcript reads must still 503 so cached inventory cannot resurrect
// an idle-quiesced box.
describe('shouldAutoResumeStoppedSandbox', () => {
  test('a passive principal OpenCode read never resumes a stopped sandbox', () => {
    expect(
      shouldAutoResumeStoppedSandbox('stopped', 8000, 'principal', {
        method: 'GET',
      }),
    ).toBe(false);
  });

  test('an explicit principal OpenCode mutation resumes a stopped sandbox', () => {
    expect(
      shouldAutoResumeStoppedSandbox('stopped', 8000, 'principal', {
        method: 'POST',
      }),
    ).toBe(true);
    expect(
      shouldAutoResumeStoppedSandbox('stopped', 4096, 'principal', {
        method: 'POST',
      }),
    ).toBe(true);
  });

  test('a non-daemon port never resumes on passive (asset / XHR) traffic', () => {
    expect(shouldAutoResumeStoppedSandbox('stopped', 4096, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('stopped', 3000, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('stopped', 443, 'principal')).toBe(false);
  });

  // ═══ THE REGRESSION ═══ a parked dev server could not be recovered through the
  // preview AT ALL — only by prompting the agent — because no preview traffic
  // resumed a box. A human LOADING the page is an explicit open, the same class of
  // intent as clicking into the session.
  test('REGRESSION: a human LOADING a preview page resumes the box', () => {
    expect(
      shouldAutoResumeStoppedSandbox('stopped', 3000, 'principal', {
        browserNavigation: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoResumeStoppedSandbox('stopped', 5173, 'principal', {
        browserNavigation: true,
      }),
    ).toBe(true);
  });

  test('a page load on a SESSION-DATA port is still not a preview resume', () => {
    // 4096 carries the conversation. A navigation-style GET remains passive.
    expect(
      shouldAutoResumeStoppedSandbox('stopped', 4096, 'principal', {
        browserNavigation: true,
        method: 'GET',
      }),
    ).toBe(false);
  });

  // The box holds a credential that resolves to a valid principal. If its own
  // traffic could resume it, the self-renewing lease is rebuilt through the proxy.
  test('a request the SANDBOX authored never resumes it, on any port', () => {
    expect(
      shouldAutoResumeStoppedSandbox('stopped', 8000, 'principal', {
        sandboxAuthored: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoResumeStoppedSandbox('stopped', 3000, 'principal', {
        sandboxAuthored: true,
        browserNavigation: true,
      }),
    ).toBe(false);
  });

  // Each row below is one that DOES resume for a principal on a stopped box
  // (a POST on the daemon port, a page load on an app port). Only the access
  // kind or the status differs, so the row fails when that guard goes.
  const RESUMING_REQUESTS = [
    [8000, { method: 'POST' }],
    [3000, { browserNavigation: true }],
  ] as const;

  test.each(RESUMING_REQUESTS)('a public share never resumes (port %p)', (port, opts) => {
    expect(shouldAutoResumeStoppedSandbox('stopped', port, 'principal', opts)).toBe(true);
    expect(shouldAutoResumeStoppedSandbox('stopped', port, 'public_share', opts)).toBe(false);
  });

  test.each(['error', 'archived', 'active', 'provisioning'])(
    'only a STOPPED record is a resume candidate: %s is not',
    (status) => {
      for (const [port, opts] of RESUMING_REQUESTS) {
        expect(shouldAutoResumeStoppedSandbox(status, port, 'principal', opts)).toBe(false);
      }
    },
  );
});

// The 504 LONG_TURN_PROXY_TIMEOUT answer itself (code, no-store, the way out)
// is proven at the route in __tests__/e2e-preview-proxy.test.ts.
describe('longTurnTimeoutResponse', () => {
  test('reflects CORS origin like every other proxy response, and omits it with no Origin', () => {
    const res = longTurnTimeoutResponse('https://app.kortix.ai');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.kortix.ai');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(longTurnTimeoutResponse('').headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
});

// The daemon's `base=1` force-resets the session's branch onto the base tip —
// `git checkout -B <branch> <sha>`, where the branch IS the session id — so it
// discards every commit the session made.
//
// It must not be reachable from user traffic, and the bearer token cannot
// enforce that on its own: this proxy authenticates everything it forwards,
// including an ordinary user's request, with the target sandbox's own service
// key. So the daemon sees an identical `Authorization` either way, and the
// refusal has to happen at the layer that knows a user is on the other end.
describe('isProxiedBaseReset', () => {
  test('refuses the destructive flag on the daemon port', () => {
    expect(isProxiedBaseReset(8000, '/kortix/refresh', 'base=1')).toBe(true);
  });

  test('refuses it on opencode 4096 too, which Daytona does not reroute', () => {
    // Gating on 8000 alone left the direct-:4096 Daytona path open — the same
    // drift that made the session-visibility gate a cross-end-user leak.
    expect(isProxiedBaseReset(4096, '/kortix/refresh', 'base=1')).toBe(true);
  });

  test('refuses it behind the in-box /proxy/{port} prefix', () => {
    expect(isProxiedBaseReset(8000, '/proxy/8000/kortix/refresh', 'base=1')).toBe(true);
  });

  test('refuses it regardless of where the flag sits in the query', () => {
    expect(isProxiedBaseReset(8000, '/kortix/refresh', 'restart=0&base=1&base_sha=abc')).toBe(true);
  });

  test('leaves an ordinary refresh alone', () => {
    // The SDK's `restart` mode is a bare POST to this path. Blocking the path
    // rather than the flag would break it.
    expect(isProxiedBaseReset(8000, '/kortix/refresh', '')).toBe(false);
    expect(isProxiedBaseReset(8000, '/kortix/refresh', 'restart=0&config_dir=1')).toBe(false);
  });

  test('does not fire on a lookalike value', () => {
    expect(isProxiedBaseReset(8000, '/kortix/refresh', 'base=0')).toBe(false);
    expect(isProxiedBaseReset(8000, '/kortix/refresh', 'base_sha=deadbeef')).toBe(false);
  });

  test('does not fire on a lookalike path', () => {
    expect(isProxiedBaseReset(8000, '/kortix/refresh-status', 'base=1')).toBe(false);
    expect(isProxiedBaseReset(8000, '/kortix/env', 'base=1')).toBe(false);
  });

  test('ignores ports that are not the session data path', () => {
    // A user's own app on :3000 owns its query strings; this gate is about the
    // daemon's control surface, not arbitrary traffic.
    expect(isProxiedBaseReset(3000, '/kortix/refresh', 'base=1')).toBe(false);
  });
});

// The daemon distinguishes a direct platform call from a proxied one by a header
// this proxy strips; that strip is proven at the route in
// __tests__/e2e-preview-proxy.test.ts.
describe('the forward strip list', () => {
  test('the strip list is matched case-insensitively, as headers are', () => {
    // Headers arrive in whatever case the client sent; the forward loop
    // lowercases before testing membership, so the entry must be lowercase.
    for (const name of STRIP_FORWARD_HEADERS) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});

// A failed probe used to arrive as a bare 502/503 and every client had to guess
// which of four hops produced it. The web app guessed "the sandbox is gone" and
// painted "Waking this session up…" over a session whose dev server was simply
// not listening. The hop is that missing fact, on the header AND in the body so
// a browser probe that never reads the body still gets it.
//
// Hop attribution on real route responses (control plane, daemon, user port,
// provider ingress) is proven in __tests__/e2e-preview-proxy.test.ts, and the
// browser page and CORS exposure in preview-response-contract.test.ts.
describe('portUnreachableResponse carries hop attribution', () => {
  const jsonHeaders = new Headers({ accept: 'application/json' });

  test('a dead daemon reports the upstream status it actually saw', async () => {
    const res = portUnreachableResponse({
      port: 8000,
      status: 502,
      origin: 'https://app.kortix.test',
      incomingHeaders: jsonHeaders,
      reason: 'sandbox port unreachable',
      hop: 'daemon',
      upstreamStatus: 502,
    });
    expect(res.headers.get(PROXY_HOP_HEADER)).toBe('daemon');
    expect(res.headers.get(PROXY_UPSTREAM_STATUS_HEADER)).toBe('502');
    expect(await res.json()).toMatchObject({ hop: 'daemon', upstream_status: 502 });
  });
});
