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
  // The inventory read moved out of the route into projects/lib/session-list.ts
  // (`loadProjectSessionInventory`) so a batch/bundle route can reuse the exact
  // same queries. The invariant is unchanged and still enforced here: the
  // project.session.read gate must run BEFORE anything reads session rows.
  test('session inventory requires project.session.read before reading sessions', () => {
    const source = readProjectRoute('project-sessions.ts');
    const routeStart = source.indexOf('// GET /v1/projects/:projectId/sessions');
    const routeEnd = source.indexOf("path: '/{projectId}/sessions/{sessionId}'", routeStart);
    const route = source.slice(routeStart, routeEnd);
    const capabilityGate = route.indexOf(
      'await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);',
    );
    const inventoryRead = route.indexOf('loadProjectSessionInventory({');

    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(capabilityGate).toBeGreaterThanOrEqual(0);
    expect(inventoryRead).toBeGreaterThan(capabilityGate);
    // The route itself must not have grown a second, ungated session read.
    expect(route).not.toContain('.from(projectSessions)');
  });

  // `loadProjectSessionInventory` carries no request context and therefore no
  // gate of its own — it is authorized by its caller. Keep it that way: an
  // inventory helper that could authorize itself would invite a caller to skip
  // the leaf assert, which is exactly the regression the test above guards.
  test('the extracted inventory read stays caller-authorized and tenant-scoped', () => {
    const source = readFileSync(
      join(import.meta.dir, '../projects/lib/session-list.ts'),
      'utf8',
    );

    expect(source).toContain('eq(projectSessions.projectId, input.projectId)');
    expect(source).toContain('eq(projectSessions.accountId, input.accountId)');
    expect(source).toContain('eq(sessionSandboxes.projectId, input.projectId)');
    expect(source).toContain('eq(sessionSandboxes.accountId, input.accountId)');
    expect(source).not.toContain('assertProjectCapability');
    expect(source).not.toContain('db.execute(`');
  });
});
