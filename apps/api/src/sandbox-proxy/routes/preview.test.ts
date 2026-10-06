import { describe, expect, test } from 'bun:test';

import { config } from '../../config';
import { getRequestContext, runWithContext } from '../../lib/request-context';
import { PROXY_HOP_HEADER, PROXY_UPSTREAM_STATUS_HEADER } from '../proxy-hop';
import {
  STRIP_FORWARD_HEADERS,
  bindSandboxRequestContext,
  clientResponseHeaders,
  isConnectionRefusedError,
  isProxiedBaseReset,
  longTurnTimeoutResponse,
  portUnreachableResponse,
  sanitizeRedirectLocation,
  shouldAutoResumeStoppedSandbox,
  stripFrameAncestors,
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
  test('credential and hop-by-hop headers never reach a user app', () => {
    for (const name of ['x-kortix-token', 'proxy-authorization', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive']) {
      expect(STRIP_FORWARD_HEADERS.has(name)).toBe(true);
    }
  });

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

// Phase 2 of the preview.ts split (KRTX-328) moves the response/header helpers
// into ../preview-response.ts. These pins read them off ./preview — the path
// every existing importer uses — so the move cannot change what they do.
describe('stripFrameAncestors', () => {
  test('removes the frame-ancestors directive and keeps the rest of the CSP', () => {
    expect(
      stripFrameAncestors(
        "default-src 'self'; frame-ancestors 'none'; script-src 'wasm-unsafe-eval'",
      ),
    ).toBe("default-src 'self'; script-src 'wasm-unsafe-eval'");
  });

  test('a CSP that is only frame-ancestors leaves nothing to keep', () => {
    expect(stripFrameAncestors("frame-ancestors 'self'")).toBeNull();
  });

  test('the directive match is case-insensitive and tolerates surrounding whitespace', () => {
    expect(stripFrameAncestors('  FRAME-ANCESTORS * ; img-src data:')).toBe('img-src data:');
  });

  test('a lookalike directive is not eaten', () => {
    expect(stripFrameAncestors('frame-ancestors-src *')).toBe('frame-ancestors-src *');
  });

  test('an empty CSP leaves nothing', () => {
    expect(stripFrameAncestors('')).toBeNull();
  });
});

describe('clientResponseHeaders', () => {
  test('deletes X-Frame-Options and rewrites a CSP that frames the app', () => {
    const upstream = new Headers({
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
    });
    const headers = clientResponseHeaders(upstream, '');
    expect(headers.has('x-frame-options')).toBe(false);
    expect(headers.get('content-security-policy')).toBe("default-src 'self'");
  });

  test('a CSP reduced to nothing by the strip is deleted, not left empty', () => {
    const headers = clientResponseHeaders(
      new Headers({ 'content-security-policy': "frame-ancestors 'none'" }),
      '',
    );
    expect(headers.has('content-security-policy')).toBe(false);
  });

  test('the report-only CSP is rewritten too', () => {
    const headers = clientResponseHeaders(
      new Headers({ 'content-security-policy-report-only': "frame-ancestors 'self'" }),
      '',
    );
    expect(headers.has('content-security-policy-report-only')).toBe(false);
  });

  test('a CSP without frame-ancestors passes through untouched', () => {
    const csp = "default-src 'self'; script-src 'wasm-unsafe-eval'";
    const headers = clientResponseHeaders(new Headers({ 'content-security-policy': csp }), '');
    expect(headers.get('content-security-policy')).toBe(csp);
  });

  test('the CORS grant follows the same allowlist as every preview response', () => {
    const granted = clientResponseHeaders(new Headers(), config.FRONTEND_URL);
    expect(granted.get('Access-Control-Allow-Origin')).toBe(config.FRONTEND_URL);
    expect(granted.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(granted.get('Vary')).toBe('Origin');
    const arbitrary = clientResponseHeaders(new Headers(), 'https://arbitrary.example');
    expect(arbitrary.has('Access-Control-Allow-Origin')).toBe(false);
    expect(arbitrary.has('Access-Control-Allow-Credentials')).toBe(false);
  });

  test('forwarded app cookies keep their host-only scope; ours are dropped', () => {
    const upstream = new Headers();
    upstream.append('set-cookie', 'app_sid=abc; Domain=kortix.com; Path=/');
    upstream.append('set-cookie', 'theme=dark');
    upstream.append('set-cookie', '__kortix_preview=tamper; Path=/');
    const headers = clientResponseHeaders(upstream, '');
    expect(headers.getSetCookie()).toEqual(['app_sid=abc; Path=/', 'theme=dark']);
  });

  test('a lone preview cookie of ours is dropped entirely', () => {
    const upstream = new Headers({ 'set-cookie': '__kortix_preview_chips=a; Path=/' });
    const headers = clientResponseHeaders(upstream, '');
    expect(headers.getSetCookie()).toEqual([]);
  });
});

describe('sanitizeRedirectLocation', () => {
  const previewUrl = 'https://p.example/v1/p/sbx_ext/3000';
  const prefix = '/v1/p/sbx_ext/3000';

  test('a root-relative location rides the preview prefix', () => {
    expect(sanitizeRedirectLocation(previewUrl, '/login?next=/x', prefix)).toBe(
      `${prefix}/login?next=/x`,
    );
  });

  test('an absolute URL back to the preview origin is re-rooted onto the prefix', () => {
    expect(sanitizeRedirectLocation(previewUrl, 'https://p.example/dashboard#top', prefix)).toBe(
      `${prefix}/dashboard#top`,
    );
  });

  test('a loopback host is treated as the app itself', () => {
    expect(sanitizeRedirectLocation(previewUrl, 'http://localhost:3000/callback', prefix)).toBe(
      `${prefix}/callback`,
    );
  });

  test('an external redirect passes through unchanged', () => {
    expect(sanitizeRedirectLocation(previewUrl, 'https://idp.example/oauth?client=1', prefix)).toBe(
      'https://idp.example/oauth?client=1',
    );
  });

  test('a protocol-relative location is an external URL and passes through', () => {
    expect(sanitizeRedirectLocation(previewUrl, '//evil.example/x', prefix)).toBe(
      '//evil.example/x',
    );
  });

  test('no location means no rewrite', () => {
    expect(sanitizeRedirectLocation(previewUrl, null, prefix)).toBeNull();
  });

  test('an unparseable location yields null instead of throwing', () => {
    expect(sanitizeRedirectLocation(previewUrl, 'http://[::1', prefix)).toBeNull();
  });
});

describe('isConnectionRefusedError', () => {
  test('a refused code on the error or its cause proves nothing reached the box', () => {
    expect(isConnectionRefusedError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      true,
    );
    expect(isConnectionRefusedError({ cause: { code: 'ECONNREFUSED' } })).toBe(true);
  });

  test('the message alone can prove it', () => {
    for (const message of [
      'connect ECONNREFUSED 127.0.0.1:3000',
      'connection refused',
      'Failed to connect',
      'Unable to connect',
    ]) {
      expect(isConnectionRefusedError(new Error(message))).toBe(true);
    }
  });

  test('any other failure stays ambiguous and must not gate the delivery retry', () => {
    expect(
      isConnectionRefusedError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
    ).toBe(false);
    expect(isConnectionRefusedError(new Error('connection reset mid-flight'))).toBe(false);
    expect(isConnectionRefusedError(new Error('The operation was aborted'))).toBe(false);
  });

  test('non-error garbage is not a refused connection', () => {
    expect(isConnectionRefusedError(null)).toBe(false);
    expect(isConnectionRefusedError(undefined)).toBe(false);
    expect(isConnectionRefusedError('ECONNREFUSED')).toBe(false);
  });
});

// The unreachable-port page never prints the sandbox address: it is an
// internal host, and the card header already names the preview (KRTX-1644).
test('the unreachable-port page does not print the browser address', async () => {
  const res = portUnreachableResponse({
    port: 3000,
    status: 502,
    origin: '',
    incomingHeaders: new Headers({ accept: 'text/html', 'x-kortix-preview-host': 'p.example' }),
    reason: 'x',
    hop: 'upstream_port',
  });
  expect(await res.text()).not.toContain('p.example');
});

test('without host headers the page simply omits the address', async () => {
  const res = portUnreachableResponse({
    port: 3000,
    status: 502,
    origin: '',
    incomingHeaders: new Headers({ accept: 'text/html' }),
    reason: 'x',
    hop: 'upstream_port',
  });
  expect(await res.text()).not.toContain('https://');
});
