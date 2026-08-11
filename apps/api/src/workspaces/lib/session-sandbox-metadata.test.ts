import { describe, expect, test } from 'bun:test';

import {
  resolveSessionSandboxSlug,
  sandboxSlugFromSessionMetadata,
  workspaceModeFromSessionMetadata,
} from './session-sandbox-metadata';
import {
  isRepositoryWorkspaceAction,
  workspaceMetadataAllowsRepositoryAccess,
} from './session-workspace-access';
import { WORKSPACE_ACTIONS } from '../../iam/actions';

describe('sandboxSlugFromSessionMetadata', () => {
  test('returns a persisted template slug', () => {
    expect(sandboxSlugFromSessionMetadata({ sandbox_slug: 'ml' })).toBe('ml');
    expect(sandboxSlugFromSessionMetadata({ sandbox_slug: 'default' })).toBe('default');
  });

  test('rejects missing and invalid metadata values', () => {
    expect(sandboxSlugFromSessionMetadata(null)).toBeUndefined();
    expect(sandboxSlugFromSessionMetadata({})).toBeUndefined();
    expect(sandboxSlugFromSessionMetadata({ sandbox_slug: '../escape' })).toBeUndefined();
  });
});

describe('workspaceModeFromSessionMetadata', () => {
  test('returns a persisted workspace mode', () => {
    expect(workspaceModeFromSessionMetadata({ workspace_mode: 'runtime' })).toBe('runtime');
    expect(workspaceModeFromSessionMetadata({ workspace_mode: 'read' })).toBe('read');
    expect(workspaceModeFromSessionMetadata({ workspace_mode: 'branch' })).toBe('branch');
  });

  test('keeps missing metadata legacy-compatible and maps invalid stored modes to runtime', () => {
    expect(workspaceModeFromSessionMetadata(null)).toBeUndefined();
    expect(workspaceModeFromSessionMetadata({})).toBeUndefined();
    expect(workspaceModeFromSessionMetadata({ workspace_mode: 'all' })).toBe('runtime');
    expect(workspaceModeFromSessionMetadata({ workspace_mode: null })).toBe('runtime');
  });
});

describe('restricted workspace repository boundary', () => {
  test('restricted metadata denies repository access while branch and legacy metadata allow it', () => {
    expect(workspaceMetadataAllowsRepositoryAccess({ workspace_mode: 'runtime' })).toBe(false);
    expect(workspaceMetadataAllowsRepositoryAccess({ workspace_mode: 'read' })).toBe(false);
    expect(workspaceMetadataAllowsRepositoryAccess({ workspace_mode: 'all' })).toBe(false);
    expect(workspaceMetadataAllowsRepositoryAccess({ workspace_mode: 'branch' })).toBe(true);
    expect(workspaceMetadataAllowsRepositoryAccess({})).toBe(true);
  });

  test('classifies every repository-backed project capability', () => {
    expect(isRepositoryWorkspaceAction(WORKSPACE_ACTIONS.WORKSPACE_FILE_READ)).toBe(true);
    expect(isRepositoryWorkspaceAction(WORKSPACE_ACTIONS.WORKSPACE_FILE_WRITE)).toBe(true);
    expect(isRepositoryWorkspaceAction(WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ)).toBe(true);
    expect(isRepositoryWorkspaceAction(WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH)).toBe(true);
    expect(isRepositoryWorkspaceAction(WORKSPACE_ACTIONS.WORKSPACE_GITOPS_MERGE)).toBe(true);
    expect(isRepositoryWorkspaceAction(WORKSPACE_ACTIONS.WORKSPACE_SECRET_READ)).toBe(false);
    expect(isRepositoryWorkspaceAction(WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_READ)).toBe(false);
  });
});

describe('resolveSessionSandboxSlug', () => {
  test('uses explicit, agent, project, then platform precedence', () => {
    expect(
      resolveSessionSandboxSlug({
        explicit: 'override',
        agent: 'ml',
        workspace: 'node',
      }),
    ).toBe('override');
    expect(resolveSessionSandboxSlug({ agent: 'ml', workspace: 'node' })).toBe('ml');
    expect(resolveSessionSandboxSlug({ workspace: 'node' })).toBe('node');
    expect(resolveSessionSandboxSlug({})).toBe('default');
  });
});
