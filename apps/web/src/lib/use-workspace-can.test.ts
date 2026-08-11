import { describe, expect, test } from 'bun:test';
import type { PermissionProbeInput } from './iam-client';
import { workspacePermissionProbes, workspacePermissionTarget } from './use-workspace-can';

// @ts-expect-error Workspace-scoped probes require resourceId.
const invalidWorkspaceProbe: PermissionProbeInput = {
  action: 'project.read',
  resourceType: 'workspace',
};
void invalidWorkspaceProbe;

describe('workspacePermissionTarget', () => {
  test('omits the workspace scope until the workspace id exists', () => {
    expect(workspacePermissionTarget(undefined)).toBeUndefined();
  });

  test('returns a complete workspace scope', () => {
    expect(workspacePermissionTarget('project-1')).toEqual({
      resourceType: 'workspace',
      resourceId: 'project-1',
    });
  });
});

describe('workspacePermissionProbes', () => {
  test('sends no probes while the workspace id is absent', () => {
    expect(workspacePermissionProbes(undefined, ['project.read'])).toEqual([]);
  });

  test('adds the workspace id to every scoped probe', () => {
    expect(workspacePermissionProbes('project-1', ['project.read', 'project.write'])).toEqual([
      { action: 'project.read', resourceType: 'workspace', resourceId: 'project-1' },
      { action: 'project.write', resourceType: 'workspace', resourceId: 'project-1' },
    ]);
  });
});
