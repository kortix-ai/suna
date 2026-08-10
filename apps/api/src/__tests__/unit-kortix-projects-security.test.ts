import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// The project routes were decomposed out of the old monolithic projects/index.ts
// into projects/routes/*.ts + projects/lib/*.ts. Scan the whole projects/ tree so
// this safety check is robust to where the sandbox-lookup handler lives.
function readWorkspacesSource(): string {
  const root = join(import.meta.dir, '../workspaces');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
        out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out.join('\n');
}

function readWorkspaceRoute(name: string): string {
  return readFileSync(join(import.meta.dir, '../workspaces/routes', name), 'utf8');
}

describe('kortix-projects SQL safety', () => {
  test('project session sandbox lookup uses Drizzle query builder instead of interpolated SQL', () => {
    const source = readWorkspacesSource();

    expect(source).toContain('from(sessionSandboxes)');
    expect(source).toContain('eq(sessionSandboxes.sessionId, sessionId)');
    expect(source).toContain('eq(sessionSandboxes.workspaceId, workspaceId)');
    expect(source).toContain('eq(sessionSandboxes.accountId, loaded.row.accountId)');
    expect(source).not.toContain("accountId.replace(/'/g");
    expect(source).not.toContain('db.execute(`');
    expect(source).not.toContain("where account_id = '");
  });
});

describe('kortix-projects authorization safety', () => {
  test('session inventory requires project.session.read before querying sessions', () => {
    const source = readWorkspaceRoute('r7.ts');
    const routeStart = source.indexOf('// GET /v1/projects/:workspaceId/sessions');
    const routeEnd = source.indexOf("path: '/{workspaceId}/sessions/{sessionId}'", routeStart);
    const route = source.slice(routeStart, routeEnd);
    const capabilityGate = route.indexOf(
      'await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ);',
    );
    const sessionQuery = route.indexOf('.from(projectSessions)');

    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(capabilityGate).toBeGreaterThanOrEqual(0);
    expect(sessionQuery).toBeGreaterThan(capabilityGate);
  });
});
