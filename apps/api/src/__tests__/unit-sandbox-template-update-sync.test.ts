// Regression guard for the reusable sandbox-template lifecycle.
//
// Creation and explicit rebuild already fan out through kickRoutedPreBuild.
// Editing used to update only the database row, leaving the new content hash
// absent on Daytona, Platinum, and E2B until a session happened to need one.
// Keep the PATCH route on the same provider-neutral synchronization path.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('sandbox template update synchronization', () => {
  test('PATCH schedules the updated slug on every enabled template provider', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'workspaces', 'routes', 'r2.ts'), 'utf8');
    const routeStart = source.indexOf('// PATCH /v1/workspaces/:workspaceId/sandbox-templates/:templateId');
    const routeEnd = source.indexOf('// DELETE /v1/workspaces/:workspaceId/sandbox-templates/:templateId');
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);

    const patchRoute = source.slice(routeStart, routeEnd);
    expect(patchRoute).toContain('const updated = await updateTemplate(templateId, patch, workspaceId)');
    expect(patchRoute).toContain('kickRoutedPreBuild(workspace, {');
    expect(patchRoute).toContain('slug: updated.slug');
    expect(patchRoute).toContain('accountId: loaded.row.accountId');
    expect(patchRoute).toContain("source: 'manual'");
    expect(patchRoute).toContain('providers: templateBuildProviders()');
  });
});
