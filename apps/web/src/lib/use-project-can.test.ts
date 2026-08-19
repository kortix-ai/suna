import { describe, expect, test } from 'bun:test';
import type { PermissionProbeInput } from './iam-client';
import { projectPermissionProbes, projectPermissionTarget } from './use-project-can';

// @ts-expect-error Project-scoped probes require resourceId.
const invalidProjectProbe: PermissionProbeInput = {
  action: 'project.read',
  resourceType: 'project',
};
void invalidProjectProbe;

describe('projectPermissionTarget', () => {
  test('omits the project scope until the project id exists', () => {
    expect(projectPermissionTarget(undefined)).toBeUndefined();
  });

  test('returns a complete project scope', () => {
    expect(projectPermissionTarget('project-1')).toEqual({
      resourceType: 'project',
      resourceId: 'project-1',
    });
  });
});

describe('projectPermissionProbes', () => {
  test('sends no probes while the project id is absent', () => {
    expect(projectPermissionProbes(undefined, ['project.read'])).toEqual([]);
  });

  test('adds the project id to every scoped probe', () => {
    expect(projectPermissionProbes('project-1', ['project.read', 'project.write'])).toEqual([
      { action: 'project.read', resourceType: 'project', resourceId: 'project-1' },
      { action: 'project.write', resourceType: 'project', resourceId: 'project-1' },
    ]);
  });
});
