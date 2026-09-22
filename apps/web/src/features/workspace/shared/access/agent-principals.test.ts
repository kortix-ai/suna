import { describe, expect, test } from 'bun:test';

import type { RoleAssignment } from '@kortix/sdk';

import {
  GRANTABLE_PROJECT_PERMISSIONS,
  HUMAN_ONLY_PERMISSIONS,
  agentIdentityFor,
  ceilingAssignments,
  computeAgentAuthority,
  expandPermissionGrant,
} from './agent-principals';

describe('computeAgentAuthority — kortix_permissions ∩ ceiling − HUMAN_ONLY', () => {
  test('no bound role: the default ceiling keeps every declared permission except human-only', () => {
    const result = computeAgentAuthority(
      ['project.file.read', 'project.members.manage', 'project.secret.read'],
      null,
    );
    expect(result.effective).toEqual(['project.file.read', 'project.read', 'project.secret.read']);
    expect(result.humanOnly).toEqual(['project.members.manage']);
    expect(result.outsideCeiling).toEqual([]);
  });

  test('a bound role caps the declared list; project.read is always granted', () => {
    const result = computeAgentAuthority(
      ['project.file.read', 'project.file.write', 'project.delete'],
      ['project.read', 'project.file.read'],
    );
    expect(result.effective).toEqual(['project.file.read', 'project.read']);
    expect(result.outsideCeiling).toEqual(['project.file.write']);
    expect(result.humanOnly).toEqual(['project.delete']);
  });

  test('`all` expands to every grantable permission and never yields a human-only one', () => {
    const result = computeAgentAuthority('all', null);
    expect(result.declared.length).toBe(GRANTABLE_PROJECT_PERMISSIONS.length);
    for (const p of HUMAN_ONLY_PERMISSIONS) expect(result.effective).not.toContain(p);
    expect(result.humanOnly).toEqual([...HUMAN_ONLY_PERMISSIONS].sort());
    expect(result.effective.length).toBe(
      GRANTABLE_PROJECT_PERMISSIONS.length - HUMAN_ONLY_PERMISSIONS.length,
    );
  });

  test('none / missing grant leaves only project.read', () => {
    expect(computeAgentAuthority('none', null).effective).toEqual(['project.read']);
    expect(computeAgentAuthority(undefined, ['project.file.read']).effective).toEqual([
      'project.read',
    ]);
    expect(expandPermissionGrant([])).toEqual([]);
  });

  test('every human-only permission is in the grantable catalog (drift guard)', () => {
    for (const p of HUMAN_ONLY_PERMISSIONS) expect(GRANTABLE_PROJECT_PERMISSIONS).toContain(p);
  });
});

describe('agent identity + ceiling assignment selection', () => {
  const row = (over: Partial<RoleAssignment>): RoleAssignment => ({
    assignment_id: 'a',
    account_id: 'acct',
    principal_type: 'service_account',
    principal_id: 'sa_1',
    role_id: 'r',
    role_key: 'member',
    role_is_system: true,
    scope_type: 'project',
    scope_id: 'p_1',
    object_type: null,
    object_id: null,
    expires_at: null,
    granted_by: null,
    source: 'manual',
    created_at: '',
    updated_at: '',
    ...over,
  });

  test('agentIdentityFor matches project AND agent name', () => {
    const ids = [
      { service_account_id: 'sa_1', name: 'x', project_id: 'p_1', agent_name: 'ops' },
      { service_account_id: 'sa_2', name: 'y', project_id: 'p_2', agent_name: 'ops' },
    ];
    expect(agentIdentityFor(ids, 'p_2', 'ops')?.service_account_id).toBe('sa_2');
    expect(agentIdentityFor(ids, 'p_1', 'other')).toBeNull();
  });

  test('ceilingAssignments keeps role rows for that service account at this project or the account', () => {
    const rows = [
      row({ assignment_id: 'keep-project' }),
      row({ assignment_id: 'keep-account', scope_type: 'account', scope_id: null }),
      row({ assignment_id: 'other-project', scope_id: 'p_2' }),
      row({ assignment_id: 'object', object_type: 'agent', object_id: 'ops' }),
      row({ assignment_id: 'other-sa', principal_id: 'sa_9' }),
      row({ assignment_id: 'user', principal_type: 'user' }),
    ];
    expect(ceilingAssignments(rows, 'sa_1', 'p_1').map((r) => r.assignment_id)).toEqual([
      'keep-project',
      'keep-account',
    ]);
  });
});
