/**
 * The one workspace alias map (`@kortix/shared/workspace-actions`) covers
 * exactly the API's action catalog, and every IAM input accepts both names.
 */
import { describe, expect, test } from 'bun:test';
import { WORKSPACE_ACTION_BY_LEGACY } from '@kortix/shared/workspace-actions';
import {
  ACCOUNT_ACTIONS,
  ACTION_CATALOG,
  PROJECT_ACTIONS,
  VALID_ACTIONS,
  isKnownAction,
  resourceTypeForAction,
  toWorkspaceAction,
} from './actions';
import { normalizeObj, tokenScopeAllows } from './authorize';
import { agentMayPerform, canonicalizeGrantActions } from './agent-scope';

describe('the workspace alias map is the API catalog', () => {
  test('one workspace name for every catalog action, and nothing else', () => {
    expect(new Set(Object.keys(WORKSPACE_ACTION_BY_LEGACY))).toEqual(new Set(VALID_ACTIONS));
    expect(Object.keys(ACCOUNT_ACTIONS)).toHaveLength(31);
    expect(Object.keys(PROJECT_ACTIONS)).toHaveLength(53); // 54 → 53: project.artifact.comment was removed (2026-11-06)
  });

  test('both names are known and classify to the same scope', () => {
    for (const action of VALID_ACTIONS) {
      const workspace = toWorkspaceAction(action);
      expect(isKnownAction(action)).toBe(true);
      expect(isKnownAction(workspace)).toBe(true);
      expect(resourceTypeForAction(workspace)).toBe(resourceTypeForAction(action));
    }
    expect(isKnownAction('workspace.not_an_action')).toBe(false);
  });

  test('the catalog wire entry carries the workspace name next to the legacy one', () => {
    const read = ACTION_CATALOG.find((e) => e.action === 'project.read');
    expect(read).toMatchObject({ action: 'project.read', workspaceAction: 'workspace.read', resourceType: 'project' });
    const billing = ACTION_CATALOG.find((e) => e.action === 'billing.read');
    expect(billing).toMatchObject({ workspaceAction: 'workspace.billing.read', resourceType: 'account' });
  });
});

describe('the workspace object shape', () => {
  test('folds onto the project shape, resource included', () => {
    expect(normalizeObj({ type: 'workspace', id: 'w' })).toEqual({ type: 'project', id: 'w' });
    expect(normalizeObj({ type: 'workspace', id: 'w', resource: { type: 'agent', id: 'a' } })).toEqual({
      type: 'project',
      id: 'w',
      resource: { type: 'agent', id: 'a' },
    });
    expect(normalizeObj({ type: 'account' })).toEqual({ type: 'account' });
  });

  test('a workspace-bound token is in scope on its own workspace only', () => {
    const binding = { projectId: 'w1' };
    expect(tokenScopeAllows(binding, 't', 'member', 'project', { type: 'workspace', id: 'w1' })).toBe(true);
    expect(tokenScopeAllows(binding, 't', 'member', 'project', { type: 'workspace', id: 'w2' })).toBe(false);
    expect(tokenScopeAllows(binding, 't', 'member', 'account', { type: 'workspace', id: 'w1' })).toBe(false);
  });
});

describe('kortix.yaml grants accept workspace names', () => {
  const grant = (permissions: string[]) => ({ agent: 'worker', permissions, connectors: [] as string[] });

  test('canonicalization rewrites a workspace name to the stored legacy name', () => {
    const out = canonicalizeGrantActions(grant(['workspace.gitops.push', 'project.read', 'project.cr.merge']) as never);
    expect(out?.permissions).toEqual(['project.gitops.push', 'project.read', 'project.gitops.merge']);
  });

  test('a grant in either spelling permits the action in either spelling', () => {
    const legacyGrant = grant(['project.session.start']) as never;
    const workspaceGrant = grant(['workspace.session.start']) as never;
    for (const g of [legacyGrant, workspaceGrant]) {
      expect(agentMayPerform(g, 'project.session.start')).toBe(true);
      expect(agentMayPerform(g, 'workspace.session.start')).toBe(true);
      expect(agentMayPerform(g, 'project.session.stop')).toBe(false);
    }
  });
});
