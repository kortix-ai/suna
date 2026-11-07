import { describe, expect, test } from 'bun:test';
import type { PermissionProbeInput } from '@kortix/sdk';
import { projectPermissionTarget } from './use-project-can';

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
