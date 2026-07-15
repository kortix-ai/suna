// The account_mfa_required denial is the one ACTIONABLE deny: the caller can
// complete an MFA challenge and retry. Its 403 must carry a machine-readable
// `code` (the web's step-up dialog keys on it); every other reason stays a
// plain humanized message with no code leak.
import { describe, expect, test } from 'bun:test';
import { buildDenialError } from '../iam/dispatcher';

describe('buildDenialError', () => {
  test('account_mfa_required → 403 with machine-readable code in the body', async () => {
    const err = buildDenialError('project.create', 'account_mfa_required');
    expect(err.status).toBe(403);
    const res = err.getResponse();
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('account_mfa_required');
    expect(body.error).toContain('multi-factor');
  });

  test('ordinary role denial → humanized message, NO code', async () => {
    const err = buildDenialError('project.create', 'account_role_insufficient');
    expect(err.status).toBe(403);
    const res = err.getResponse();
    const text = await res.text();
    expect(text).toContain("don't have permission");
    expect(text).not.toContain('account_mfa_required');
    expect(text).not.toContain('account_role_insufficient');
  });

  test('unknown action still yields the generic phrase with the action code', async () => {
    const err = buildDenialError('made.up_action', undefined);
    const res = err.getResponse();
    const text = await res.text();
    expect(text).toContain('made.up_action');
  });
});
