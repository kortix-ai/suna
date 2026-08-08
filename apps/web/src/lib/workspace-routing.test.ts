import { describe, expect, test } from 'bun:test';

import { canonicalWorkspacePath, workspaceCompatibilityPath } from './workspace-routing';

describe('Workspace routing', () => {
  test('canonicalizes the full Project route suffix', () => {
    expect(canonicalWorkspacePath('/projects')).toBe('/workspaces');
    expect(canonicalWorkspacePath('/projects/w1/sessions/s1')).toBe('/workspaces/w1/sessions/s1');
  });

  test('does not match lookalike paths', () => {
    expect(canonicalWorkspacePath('/projects-old')).toBeNull();
    expect(workspaceCompatibilityPath('/workspaces-old')).toBeNull();
  });

  test('rewrites the canonical route onto the current implementation', () => {
    expect(workspaceCompatibilityPath('/workspaces')).toBe('/projects');
    expect(workspaceCompatibilityPath('/workspaces/w1/files')).toBe('/projects/w1/files');
  });
});
