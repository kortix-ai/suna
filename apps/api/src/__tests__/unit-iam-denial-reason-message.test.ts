// A 403's message must name the constraint that ACTUALLY fired.
//
// `authorizeV2` folds three independent limits into one boolean — the human's
// project role, the agent session's `kortix_cli` grant, and an activated service
// account's assigned role. Only `verdict.reason` separates them. The project
// loader used to discard the reason and re-derive the cause by probing
// `project.read`, which is exempt from the agent-grant fold — so the probe
// passed for EVERY agent-session token and every agent/service-account denial
// rendered as "your role is too low". An account owner running the meta
// coordinator was told to ask an account owner for a higher role.
//
// These tests pin the reason → message mapping as a pure function, and pin the
// two properties that keep it honest: a remedy that matches the constraint, and
// no disclosure of the account's wider permission model.
import { describe, expect, test } from 'bun:test';
import { buildDenialError, denialReasonMessage } from '../iam/denial-message';

describe('denialReasonMessage', () => {
  test('agent_scope_insufficient names the agent grant, not the role', () => {
    const message = denialReasonMessage('project.session.start', 'agent_scope_insufficient');
    expect(message).toBe(
      'This agent session is not granted "project.session.start". Add it to the agent\'s kortix_cli in kortix.yaml and merge the change.',
    );
    // The bug being fixed: this must NEVER read as a role problem.
    expect(message).not.toContain('role');
  });

  test('service_account_scope_insufficient names the service account role', () => {
    const message = denialReasonMessage(
      'project.session.start',
      'service_account_scope_insufficient',
    );
    expect(message).toBe(
      'This agent runs as its own service account, and the role assigned to it does not allow "project.session.start". Ask an account admin to update that role.',
    );
    // The launching user's own role is irrelevant once the SA is activated, so
    // the remedy must point at the SA's role, not the caller's.
    expect(message).not.toContain('higher role');
  });

  test('token_out_of_scope names the token binding', () => {
    expect(denialReasonMessage('project.write', 'token_out_of_scope')).toBe(
      'This token is scoped to a single project and cannot be used for this request.',
    );
  });

  test('resource_scope_insufficient names the per-resource grant', () => {
    expect(denialReasonMessage('project.agent.read', 'resource_scope_insufficient')).toBe(
      'You are not granted access to this resource.',
    );
  });

  test('account_mfa_required keeps the step-up wording', () => {
    expect(denialReasonMessage('project.write', 'account_mfa_required')).toContain(
      'multi-factor authentication',
    );
  });

  test('role-shaped and unknown reasons return null so the caller keeps its own wording', () => {
    for (const reason of [
      'project_role_insufficient',
      'no_project_membership',
      'account_role_insufficient',
      'project_target_required',
      'not_a_member',
      'impersonation_scope',
      undefined,
      'a_reason_that_does_not_exist_yet',
    ]) {
      expect(denialReasonMessage('project.session.start', reason)).toBeNull();
    }
  });

  test('no message discloses the permission model beyond the caller\'s own request', () => {
    for (const reason of [
      'agent_scope_insufficient',
      'service_account_scope_insufficient',
      'token_out_of_scope',
      'resource_scope_insufficient',
      'account_mfa_required',
    ]) {
      const message = denialReasonMessage('project.session.start', reason);
      expect(message).not.toBeNull();
      // No engine internals, and no enumeration of what WOULD be allowed.
      expect(message).not.toContain(reason);
      expect(message).not.toContain('iam_policies');
      expect(message).not.toContain('super_admin');
      expect(message).not.toContain('project_members');
    }
  });
});

describe('buildDenialError uses the reason message', () => {
  test('agent_scope_insufficient 403 body carries the agent-grant remedy', async () => {
    const err = buildDenialError('project.session.read', 'agent_scope_insufficient');
    expect(err.status).toBe(403);
    const text = await err.getResponse().text();
    expect(text).toContain('kortix_cli');
    expect(text).toContain('project.session.read');
  });

  test('a role denial still falls back to the humanized action phrase', async () => {
    const err = buildDenialError('project.write', 'project_role_insufficient');
    const text = await err.getResponse().text();
    expect(text).toContain("don't have permission to change this project");
  });
});
