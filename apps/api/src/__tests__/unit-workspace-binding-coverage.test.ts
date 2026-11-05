/**
 * The credential fence has ONE rule over ONE table
 * (`middleware/workspace-binding.ts`). This file fails when:
 *   - a route in `tests/spec/routes.generated.json` has no binding (an unlisted
 *     route would answer 403 to every workspace-bound credential at runtime);
 *   - a `/v1/workspaces/:workspaceId/*` alias binds differently from the
 *     `/v1/projects/:projectId/*` route it aliases;
 *   - one of the cases the old per-route allowlist decided changes verdict.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WORKSPACE_ADMIN_SUBTREES,
  bindingFor,
  workspaceFenceVerdict,
  type WorkspaceCredential,
} from '../middleware/workspace-binding';

const MANIFEST = join(import.meta.dir, '..', '..', '..', '..', 'tests', 'spec', 'routes.generated.json');
const routes = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { routes: Array<{ method: string; path: string }> }).routes;

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SANDBOX_OF_WS = 'sbx-own';
const deps = { sandboxWorkspace: async (id: string) => (id === SANDBOX_OF_WS ? WS : id === 'sbx-other' ? OTHER : null) };
const projectPat: WorkspaceCredential = { workspaceId: WS, sessionBound: false };
const sessionPat: WorkspaceCredential = { workspaceId: WS, sessionBound: true };

/** A concrete request path for a manifest pattern: every `:param` and `*` gets a value. */
function concrete(pattern: string, id = WS): string {
  return pattern
    .replace(/:(projectId|workspaceId)\b/g, id)
    .replace(/:[A-Za-z_]+/g, 'x')
    .replace(/\*/g, 'x');
}

/** The methods a manifest `ALL` route stands for. */
const methodsOf = (method: string) => (method === 'ALL' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [method]);

describe('every manifest route has a binding', () => {
  test(`all ${routes.length} routes resolve to an explicit rule`, () => {
    const missing: string[] = [];
    for (const r of routes) {
      for (const method of methodsOf(r.method)) {
        if (!bindingFor(method, concrete(r.path))) missing.push(`${method} ${r.path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('aliases bind by pattern: /v1/workspaces/:workspaceId/* = /v1/projects/:projectId/*', () => {
  const projectRoutes = routes.filter((r) => r.path.startsWith('/v1/projects/:projectId'));

  test(`${projectRoutes.length} project routes get the same verdict under the workspace alias`, async () => {
    const diffs: string[] = [];
    for (const r of projectRoutes) {
      const alias = r.path.replace('/v1/projects/:projectId', '/v1/workspaces/:workspaceId');
      const sub = alias.split('/')[4];
      // An account subtree collapses into the same alias path (design.md §4): administration wins there.
      if (sub && (WORKSPACE_ADMIN_SUBTREES as readonly string[]).includes(sub)) continue;
      if (sub === 'audit' && alias !== '/v1/workspaces/:workspaceId/audit') continue;
      for (const method of methodsOf(r.method)) {
        for (const id of [WS, OTHER]) {
          for (const cred of [projectPat, sessionPat]) {
            const a = await workspaceFenceVerdict(method, concrete(r.path, id), cred, deps);
            const b = await workspaceFenceVerdict(method, concrete(alias, id), cred, deps);
            if (a.allowed !== b.allowed) diffs.push(`${method} ${r.path} (${id === WS ? 'own' : 'other'})`);
          }
        }
      }
    }
    expect(diffs).toEqual([]);
  });

  test('the account administration aliases are refused, even for the own workspace', async () => {
    for (const sub of [...WORKSPACE_ADMIN_SUBTREES, 'audit/events']) {
      const v = await workspaceFenceVerdict('GET', `/v1/workspaces/${WS}/${sub}`, sessionPat, deps);
      expect({ sub, ...v }).toMatchObject({ sub, allowed: false, check: 'account-level-route' });
    }
  });
});

describe('the cases the old per-route allowlist decided keep their verdict', () => {
  const cases: Array<[method: string, path: string, cred: WorkspaceCredential, expected: true | string]> = [
    // none
    ['GET', '/v1/accounts/me', projectPat, true],
    ['GET', '/v1/me', projectPat, true],
    ['GET', '/v1/skills', projectPat, true],
    ['GET', '/v1/skills/kortix-system/file', projectPat, true],
    ['GET', '/v1/runtime-assets/cli', projectPat, true],
    ['GET', '/v1/runtime-assets', projectPat, 'default-deny'],
    ['POST', '/v1/feedback', projectPat, true],
    ['GET', '/v1/feedback', projectPat, 'default-deny'],
    // own session only
    ['POST', '/v1/platform/boot-timeline', sessionPat, true],
    ['POST', '/v1/platform/boot-timeline', projectPat, 'default-deny'],
    ['POST', '/v1/platform/runtime-projection', sessionPat, true],
    ['POST', '/v1/chrome/attach', sessionPat, true],
    ['POST', '/v1/chrome/release', sessionPat, true],
    ['POST', '/v1/chrome/attach', projectPat, 'default-deny'],
    ['GET', '/v1/chrome/connections', sessionPat, true],
    ['GET', '/v1/chrome/connections', projectPat, 'default-deny'],
    ['DELETE', '/v1/chrome/connections', sessionPat, 'default-deny'],
    // ambient, handler-bound
    ['GET', '/v1/usage/cost-summary', projectPat, true],
    ['GET', '/v1/usage/cost-by-project', projectPat, true],
    ['GET', '/v1/usage', projectPat, 'default-deny'],
    ['GET', '/v1/capture/me/timeline', sessionPat, true],
    ['POST', '/v1/capture/me/timeline', sessionPat, 'default-deny'],
    ['GET', '/v1/projects/current', projectPat, true],
    ['PATCH', '/v1/projects/current', projectPat, 'cross-project'],
    // drives
    ['GET', '/v1/drives', projectPat, true],
    ['PUT', `/v1/drives/d/files/content`, projectPat, true],
    // administration
    ['GET', '/v1/accounts', projectPat, 'account-level-route'],
    ['GET', `/v1/accounts/${WS}/members`, sessionPat, 'account-level-route'],
    ['GET', '/v1/accounts/me/devices', projectPat, 'account-level-route'],
    ['POST', '/v1/accounts/tokens', sessionPat, 'account-level-route'],
    // path
    ['GET', `/v1/projects/${WS}`, projectPat, true],
    ['POST', `/v1/projects/${WS}/sessions`, sessionPat, true],
    ['GET', `/v1/projects/${OTHER}/sessions`, sessionPat, 'cross-project'],
    ['GET', `/v1/connectors/projects/${WS}/catalog`, sessionPat, true],
    ['GET', `/v1/connectors/projects/${OTHER}/catalog`, sessionPat, 'cross-project'],
    ['GET', '/v1/connectors/catalog', sessionPat, 'default-deny'],
    ['GET', `/v1/workspaces/${WS}`, sessionPat, true],
    ['GET', `/v1/workspaces/${OTHER}`, sessionPat, 'cross-project'],
    ['GET', `/v1/workspaces/${WS}/audit`, sessionPat, true],
    // lists
    ['GET', '/v1/projects', projectPat, 'project-list'],
    ['GET', '/v1/workspaces', projectPat, 'project-list'],
    ['GET', '/v1/projects/', projectPat, 'default-deny'],
    // sandbox proxy
    ['GET', `/v1/p/${SANDBOX_OF_WS}/8000/kortix/health`, sessionPat, true],
    ['GET', '/v1/p/sbx-other/8000/kortix/health', sessionPat, 'foreign-sandbox'],
    ['GET', '/v1/p/sbx-unknown/8000/x', sessionPat, 'foreign-sandbox'],
    ['GET', '/v1/p/auth/x', sessionPat, 'default-deny'],
    // account and platform surfaces
    ['GET', '/v1/billing/account-state', projectPat, 'default-deny'],
    ['POST', '/v1/router/chat/completions', sessionPat, 'default-deny'],
    ['GET', '/v1/admin/api/accounts', sessionPat, 'default-deny'],
    // unlisted
    ['GET', '/v1/not-a-route', projectPat, 'default-deny'],
    ['GET', '/v1/projectsfoo', projectPat, 'default-deny'],
  ];

  for (const [method, path, cred, expected] of cases) {
    test(`${method} ${path} (${cred.sessionBound ? 'session' : 'project'} PAT) → ${expected === true ? 'allowed' : expected}`, async () => {
      const v = await workspaceFenceVerdict(method, path, cred, deps);
      if (expected === true) expect(v).toEqual({ allowed: true });
      else expect(v).toMatchObject({ allowed: false, check: expected });
    });
  }
});
