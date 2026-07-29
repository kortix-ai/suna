import { describe, expect, test } from 'bun:test';

import {
  AgentSecretGrantMismatchError,
  SecretGrantResolutionError,
} from '../../projects/lib/secret-grant';
import {
  longTurnTimeoutResponse,
  secretGrantErrorResponse,
  shouldAutoResumeStoppedSandbox,
} from './preview';

// The data-path proxy may only wake a stopped box on ACTIVE user traffic to the
// OpenCode daemon (port 8000, principal). Everything else must still 503 so we
// never resurrect an idle-quiesced box on passive asset/preview traffic.
describe('shouldAutoResumeStoppedSandbox', () => {
  test('stopped + daemon port 8000 + principal → resume', () => {
    expect(shouldAutoResumeStoppedSandbox('stopped', 8000, 'principal')).toBe(true);
  });

  test('a non-daemon (passive/asset/preview) port never resumes', () => {
    expect(shouldAutoResumeStoppedSandbox('stopped', 4096, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('stopped', 3000, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('stopped', 443, 'principal')).toBe(false);
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

  // ── BOUNDED SANDBOX LIFETIME (§2.1 W6) — the turn-intent gate ─────────────
  //
  // A resume is the ONE thing that legitimately mints a fresh 24h cap operand,
  // so any path that re-anchors on traffic the user did not intend defeats the
  // ceiling. Off by default: this ships SHADOW ONLY, and with no kill path
  // there is nothing to flap against, so tightening it now would be a
  // user-visible behaviour change bought for nothing.
  describe('turn-intent gate', () => {
    const base = { isTurnStart: false, quiesced: true, selfAuthored: false };

    test('with the gate DISABLED, behaviour is byte-for-byte what it is today', () => {
      expect(
        shouldAutoResumeStoppedSandbox('stopped', 8000, 'principal', {
          ...base,
          enforceTurnIntentGate: false,
        }),
      ).toBe(true);
    });

    test('a QUIESCED box ignores passive traffic — that loop is the ceiling defeat', () => {
      // A tab polling session.list every 30s would otherwise resume a
      // just-stopped box, mint a fresh stretch, and across 187 boxes issue
      // roughly 18k provider starts a day into a provider with a documented
      // 429 history.
      expect(
        shouldAutoResumeStoppedSandbox('stopped', 8000, 'principal', {
          ...base,
          enforceTurnIntentGate: true,
        }),
      ).toBe(false);
    });

    test('a QUIESCED box DOES wake on a real observed turn start', () => {
      expect(
        shouldAutoResumeStoppedSandbox('stopped', 8000, 'principal', {
          ...base,
          enforceTurnIntentGate: true,
          isTurnStart: true,
        }),
      ).toBe(true);
    });

    test('a box stopped by the PROVIDER (not quiesced) keeps waking on any traffic', () => {
      // Only the reaper's deliberate idle-stop sets idleQuiesced. A provider
      // auto-stop or a webhook must not start 503ing.
      expect(
        shouldAutoResumeStoppedSandbox('stopped', 8000, 'principal', {
          ...base,
          enforceTurnIntentGate: true,
          quiesced: false,
        }),
      ).toBe(true);
    });

    test('a sandbox may NEVER resurrect itself, even with a perfect turn start', () => {
      // The box holds a session-bound executor token and can issue a
      // syntactically valid prompt against itself. `access.kind` is
      // 'principal' for that request, so path classification alone is not a
      // defence.
      expect(
        shouldAutoResumeStoppedSandbox('stopped', 8000, 'principal', {
          ...base,
          enforceTurnIntentGate: true,
          isTurnStart: true,
          selfAuthored: true,
          quiesced: false,
        }),
      ).toBe(false);
    });
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
  test('a grant-changing agent switch is a 409 the web client already codes against', async () => {
    const res = secretGrantErrorResponse(new AgentSecretGrantMismatchError('narrow', 'broad'), '');
    expect(res).not.toBeNull();
    expect(res?.status).toBe(409);
    const body = (await res?.json()) as {
      code: string;
      expected_agent: string;
      requested_agent: string;
    };
    expect(body.code).toBe('AGENT_SWITCH_REQUIRES_NEW_SESSION');
    expect(body.expected_agent).toBe('narrow');
    expect(body.requested_agent).toBe('broad');
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
      new AgentSecretGrantMismatchError('a', 'b'),
      'https://app.kortix.ai',
    );
    expect(res?.headers.get('Access-Control-Allow-Origin')).toBe('https://app.kortix.ai');
  });
});
