import { describe, expect, test } from 'bun:test';

import { getRequestContext, runWithContext } from '../../lib/request-context';
import { SecretGrantResolutionError } from '../../projects/lib/secret-grant';
import { SessionGrantRemintError } from '../../projects/lib/session-token-grant';
import { KORTIX_SERVICE_CALL_HEADER } from '../../shared/kortix-user-context';
import { PROXY_HOP_HEADER, PROXY_UPSTREAM_STATUS_HEADER } from '../proxy-hop';
import {
  STRIP_FORWARD_HEADERS,
  bindSandboxRequestContext,
  isProxiedBaseReset,
  longTurnTimeoutResponse,
  portUnreachableResponse,
  secretGrantErrorResponse,
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

  test('non-user (service / share) access never resumes', () => {
    expect(shouldAutoResumeStoppedSandbox('stopped', 8000, 'service')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('stopped', 8000, 'share')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('stopped', 8000, '')).toBe(false);
  });

  test('only a STOPPED record is a resume candidate (error/archived/active are not)', () => {
    expect(shouldAutoResumeStoppedSandbox('error', 8000, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('archived', 8000, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('active', 8000, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('provisioning', 8000, 'principal')).toBe(false);
  });
});

// A long reasoning+tool turn on the blocking `POST /session/:id/message` path
// can legitimately outrun the proxy's retry budget while the sandbox is
// perfectly healthy. That must surface as a distinct, honest signal — never
// the generic "sandbox unreachable" 502 (which implies the box is dead and
// invites the caller to retry the exact same non-idempotent request).
describe('longTurnTimeoutResponse', () => {
  test('reports 504 with a distinct machine-readable code, not a generic 502', async () => {
    const res = longTurnTimeoutResponse('');
    expect(res.status).toBe(504);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('LONG_TURN_PROXY_TIMEOUT');
    expect(body.error).toMatch(/prompt_async/);
  });

  test('is never cached — a retry must always re-evaluate the upstream', () => {
    const res = longTurnTimeoutResponse('');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test('reflects CORS origin like every other proxy response', () => {
    const res = longTurnTimeoutResponse('https://app.kortix.ai');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.kortix.ai');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  test('omits CORS headers when there is no Origin', () => {
    const res = longTurnTimeoutResponse('');
    expect(res.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
});

describe('secretGrantErrorResponse', () => {
  // The agent-switch 409 is GONE. A prompt naming a different agent is
  // re-scoped, never refused, so no error this function handles may map to a
  // permanent conflict — every one is "we could not APPLY the re-scope", which
  // the client must retry. This test is the guard against a 409 creeping back.
  test('no grant failure maps to a 409 — a switch is never refused', async () => {
    for (const err of [
      new SecretGrantResolutionError('kortix', new Error('git unreachable')),
      new SessionGrantRemintError('ses_1', new Error('db down')),
    ]) {
      const res = secretGrantErrorResponse(err, '');
      expect(res).not.toBeNull();
      expect(res?.status).not.toBe(409);
      expect(res?.status).toBe(503);
      const body = (await res?.json()) as { code: string };
      expect(body.code).not.toBe('AGENT_SWITCH_REQUIRES_NEW_SESSION');
    }
  });

  test('a failed grant re-mint is a 503, so the prompt is retried rather than dropped', async () => {
    const res = secretGrantErrorResponse(new SessionGrantRemintError('ses_1', new Error('db')), '');
    expect(res?.status).toBe(503);
    const body = (await res?.json()) as { code: string };
    expect(body.code).toBe('AGENT_SWITCH_GRANT_UNAPPLIED');
  });

  test('an unresolvable grant is a 503, not the generic unreachable 502', async () => {
    const res = secretGrantErrorResponse(
      new SecretGrantResolutionError('kortix', new Error('git unreachable')),
      '',
    );
    expect(res?.status).toBe(503);
    const body = (await res?.json()) as { code: string };
    expect(body.code).toBe('AGENT_SECRET_GRANT_UNRESOLVED');
  });

  test('an ordinary env-sync failure is left to the existing retry path', () => {
    expect(secretGrantErrorResponse(new Error('env sync failed: 502'), '')).toBeNull();
    expect(secretGrantErrorResponse(undefined, '')).toBeNull();
  });

  test('reflects CORS origin like every other proxy response', () => {
    const res = secretGrantErrorResponse(
      new SecretGrantResolutionError('a', new Error('git unreachable')),
      'https://app.kortix.ai',
    );
    expect(res?.headers.get('Access-Control-Allow-Origin')).toBe('https://app.kortix.ai');
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
// this proxy strips. If that name ever falls out of the strip list, a caller can
// set it themselves and the daemon's gate opens.
describe('the service-call header cannot be injected through the proxy', () => {
  test('it is stripped from forwarded requests', () => {
    expect(STRIP_FORWARD_HEADERS.has(KORTIX_SERVICE_CALL_HEADER.toLowerCase())).toBe(true);
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
describe('portUnreachableResponse carries hop attribution', () => {
  const jsonHeaders = new Headers({ accept: 'application/json' });

  test('the control plane answering "this row is not active" says so', async () => {
    const res = portUnreachableResponse({
      port: 8000,
      status: 503,
      origin: 'https://app.kortix.test',
      incomingHeaders: jsonHeaders,
      reason: 'sandbox not ready (status: stopped)',
      hop: 'control_plane',
    });
    expect(res.status).toBe(503);
    expect(res.headers.get(PROXY_HOP_HEADER)).toBe('control_plane');
    expect(res.headers.get(PROXY_UPSTREAM_STATUS_HEADER)).toBeNull();
    expect(await res.json()).toEqual({
      error: 'sandbox not ready (status: stopped)',
      port: 8000,
      status: 503,
      hop: 'control_plane',
      upstream_status: null,
    });
  });

  test('a readiness 503 carries the stable machine code and retry flag', async () => {
    // Clients branch on `code`, not on the human-readable `reason` — and
    // `retry: true` says the same request succeeds once the box is up.
    const res = portUnreachableResponse({
      port: 8000,
      status: 503,
      origin: 'https://app.kortix.test',
      incomingHeaders: jsonHeaders,
      reason: 'sandbox not ready (status: stopped)',
      hop: 'control_plane',
      code: 'sandbox_not_ready',
      retry: true,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'sandbox_not_ready', retry: true });
  });

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

  test("a dead app port is the user's own process, and says so", async () => {
    const res = portUnreachableResponse({
      port: 3000,
      status: 502,
      origin: '',
      incomingHeaders: jsonHeaders,
      reason: 'sandbox port unreachable',
      hop: 'upstream_port',
      upstreamStatus: 502,
    });
    expect(res.headers.get(PROXY_HOP_HEADER)).toBe('upstream_port');
    expect(await res.json()).toMatchObject({ hop: 'upstream_port' });
  });

  test('a provider ingress that never resolved is its own hop', async () => {
    const res = portUnreachableResponse({
      port: 8000,
      status: 502,
      origin: '',
      incomingHeaders: jsonHeaders,
      reason: 'sandbox upstream unreachable',
      hop: 'provider_ingress',
    });
    expect(res.headers.get(PROXY_HOP_HEADER)).toBe('provider_ingress');
  });

  test('a browser navigation still gets the friendly HTML — and the hop headers with it', async () => {
    const res = portUnreachableResponse({
      port: 3000,
      status: 502,
      origin: 'https://app.kortix.test',
      incomingHeaders: new Headers({ accept: 'text/html' }),
      reason: 'sandbox port unreachable',
      hop: 'upstream_port',
      upstreamStatus: 502,
    });
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get(PROXY_HOP_HEADER)).toBe('upstream_port');
    expect(await res.text()).toContain('<!doctype html>');
  });

  // The probe runs cross-origin (dev.kortix.com → dev-api.kortix.com). Without
  // this the browser hides both headers from JS and every failure reads as an
  // unattributed one — the exact ambiguity this step removes.
  test('both hop headers are CORS-exposed so a cross-origin probe can read them', () => {
    const res = portUnreachableResponse({
      port: 8000,
      status: 502,
      origin: 'https://app.kortix.test',
      incomingHeaders: jsonHeaders,
      reason: 'sandbox upstream unreachable',
      hop: 'daemon',
      upstreamStatus: 502,
    });
    const exposed = (res.headers.get('Access-Control-Expose-Headers') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase());
    expect(exposed).toContain(PROXY_HOP_HEADER.toLowerCase());
    expect(exposed).toContain(PROXY_UPSTREAM_STATUS_HEADER.toLowerCase());
  });
});
