// The account_mfa_required denial is the one ACTIONABLE deny: the caller can
// complete an MFA challenge and retry. Its 403 must carry a machine-readable
// `code` (the web's step-up dialog keys on it); every other reason stays a
// plain humanized message with no code leak.
import { describe, expect, test } from 'bun:test';
import { buildDenialError } from '../iam/denial-message';

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

  test('ordinary role denial → humanized message plus code and action (spec 2026-09-22 §4)', async () => {
    const err = buildDenialError('project.create', 'account_role_insufficient');
    expect(err.status).toBe(403);
    const res = err.getResponse();
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: unknown; message: string; code: string; action: string; status: number };
    expect(body.message).toContain("don't have permission");
    expect(body.code).toBe('account_role_insufficient');
    expect(body.action).toBe('project.create');
    expect(body.status).toBe(403);
    expect(err.message).toBe(body.message);
  });

  test('account_mfa_required keeps its body and also names the action', async () => {
    const body = (await buildDenialError('project.create', 'account_mfa_required').getResponse().json()) as {
      action: string;
    };
    expect(body.action).toBe('project.create');
  });

  test('agent ceiling and human-only denials carry their own code and a remedy that is not the manifest', async () => {
    const ceiling = (await buildDenialError('project.file.read', 'agent_ceiling_insufficient').getResponse().json()) as {
      message: string;
      code: string;
      action: string;
    };
    expect(ceiling.code).toBe('agent_ceiling_insufficient');
    expect(ceiling.action).toBe('project.file.read');
    expect(ceiling.message).toMatch(/admin/i);
    expect(ceiling.message).not.toContain('kortix_permissions');
    const human = (await buildDenialError('project.delete', 'agent_human_only_action').getResponse().json()) as {
      message: string;
      code: string;
    };
    expect(human.code).toBe('agent_human_only_action');
    expect(human.message).toMatch(/human/i);
  });

  test('unknown action still yields the generic phrase with the action code', async () => {
    const err = buildDenialError('made.up_action', undefined);
    const res = err.getResponse();
    const text = await res.text();
    expect(text).toContain('made.up_action');
  });
});
