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
