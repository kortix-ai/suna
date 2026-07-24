import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// The project routes were decomposed out of the old monolithic projects/index.ts
// into projects/routes/*.ts + projects/lib/*.ts. Scan the whole projects/ tree so
// this safety check is robust to where the sandbox-lookup handler lives.
function readProjectsSource(): string {
  const root = join(import.meta.dir, '../projects');
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

function readProjectRoute(name: string): string {
  return readFileSync(join(import.meta.dir, '../projects/routes', name), 'utf8');
}

describe('kortix-projects SQL safety', () => {
  test('project session sandbox lookup uses Drizzle query builder instead of interpolated SQL', () => {
    const source = readProjectsSource();

    expect(source).toContain('from(sessionSandboxes)');
    expect(source).toContain('eq(sessionSandboxes.sessionId, sessionId)');
    expect(source).toContain('eq(sessionSandboxes.projectId, projectId)');
    expect(source).toContain('eq(sessionSandboxes.accountId, loaded.row.accountId)');
    expect(source).not.toContain("accountId.replace(/'/g");
    expect(source).not.toContain('db.execute(`');
    expect(source).not.toContain("where account_id = '");
  });
});

describe('kortix-projects authorization safety', () => {
  test('session inventory requires project.session.read before querying sessions', () => {
    const source = readProjectRoute('r7.ts');
    const routeStart = source.indexOf('// GET /v1/projects/:projectId/sessions');
    const routeEnd = source.indexOf("path: '/{projectId}/sessions/{sessionId}'", routeStart);
    const route = source.slice(routeStart, routeEnd);
    const capabilityGate = route.indexOf(
      'await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);',
    );
    const sessionQuery = route.indexOf('.from(projectSessions)');

    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(capabilityGate).toBeGreaterThanOrEqual(0);
    expect(sessionQuery).toBeGreaterThan(capabilityGate);
  });
});
