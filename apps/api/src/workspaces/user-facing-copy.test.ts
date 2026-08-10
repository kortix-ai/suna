import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = join(import.meta.dir, '..');

function source(relativePath: string): string {
  return readFileSync(join(API_ROOT, relativePath), 'utf8');
}

describe('Workspace user-facing API copy', () => {
  test('IAM role and action descriptions name Workspaces', () => {
    const presets = source('accounts/iam/role-presets.ts');
    const dispatcher = source('iam/dispatcher.ts');

    expect(presets).toContain('Full workspace control, including members and delete.');
    expect(presets).toContain('Create and edit workspace content, run sessions.');
    expect(presets).toContain('The workspace floor role.');
    expect(dispatcher).toContain("'project.create': 'create workspaces'");
    expect(dispatcher).toContain("'project.write': 'change this workspace'");
    expect(dispatcher).toContain("'project.delete': 'delete workspaces'");
    expect(dispatcher).toContain("'project.members.manage': 'manage workspace members'");
  });

  test('feature-flag descriptions and errors name Workspaces', () => {
    const registry = source('feature-flags/registry.ts');
    const gate = source('feature-flags/gate.ts');

    expect(registry).toContain('Route this workspace through the managed Kortix LLM gateway.');
    expect(registry).toContain('provider mode follows the workspace setting.');
    expect(gate).toContain('is not enabled for this workspace.');
  });

  test('shared setup-link and git-proxy errors name Workspaces', () => {
    const approvals = source('setup-links/approval-app.ts');
    const gitProxy = source('git-proxy/index.ts');

    expect(approvals).toContain('Only a workspace manager or the session launcher');
    expect(gitProxy).toContain('No git upstream is configured for this workspace');
  });
});
