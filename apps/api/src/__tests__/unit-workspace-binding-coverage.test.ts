/**
 * The credential fence has ONE rule over ONE table
 * (`middleware/workspace-binding.ts`). This file fails when:
 *   - a route in `tests/spec/routes.generated.json` has no binding (an unlisted
 *     route would answer 403 to every workspace-bound credential at runtime);
 *   - a `/v1/workspaces/:workspaceId/*` alias binds differently from the
 *     `/v1/projects/:projectId/*` route it aliases;
 *   - a workspace key loses its own workspace (administration included) or
 *     reaches another one.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WORKSPACE_BINDINGS,
  bindingFor,
  compileBindingPattern,
  workspaceFenceVerdict,
  type WorkspaceCredential,
} from '../middleware/workspace-binding';

const MANIFEST = join(import.meta.dir, '..', '..', '..', '..', 'tests', 'spec', 'routes.generated.json');
const routes = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { routes: Array<{ method: string; path: string }> }).routes;

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SANDBOX_OF_WS = 'sbx-own';
const LEGACY_ACCOUNT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_OF_WS = '44444444-4444-4444-8444-444444444444';
const deps = {
  sandboxWorkspace: async (id: string) => (id === SANDBOX_OF_WS ? WS : id === 'sbx-other' ? OTHER : null),
  accountWorkspace: async (id: string) => (id === ACCOUNT_OF_WS ? WS : id === LEGACY_ACCOUNT ? ('ambiguous' as const) : null),
};
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

  test('a workspace key administers its own workspace and no other (one rule, no admin wall)', async () => {
    const subtrees = ['iam/groups', 'members', 'invites', 'tokens', 'branding', 'automations', 'capture', 'audit/events'];
    for (const sub of subtrees) {
      for (const prefix of ['/v1/workspaces', '/v1/accounts']) {
        expect(await workspaceFenceVerdict('GET', `${prefix}/${WS}/${sub}`, projectPat, deps)).toEqual({ allowed: true });
        expect(await workspaceFenceVerdict('GET', `${prefix}/${WS}/${sub}`, sessionPat, deps)).toEqual({ allowed: true });
        expect(await workspaceFenceVerdict('GET', `${prefix}/${OTHER}/${sub}`, projectPat, deps)).toMatchObject({
          allowed: false,
          check: 'cross-workspace',
        });
      }
    }
  });
});

describe('the fence decides each credential × route class', () => {
  const cases: Array<[method: string, path: string, cred: WorkspaceCredential, expected: true | string, ids?: string[]]> = [
    // none
    ['GET', '/v1/accounts/me', projectPat, true],
    ['GET', '/v1/me', projectPat, true],
    ['GET', '/v1/skills', projectPat, true],
    ['GET', '/v1/skills/kortix-system/file', projectPat, true],
    ['GET', '/v1/runtime-assets/cli', projectPat, true],
    ['GET', '/v1/runtime-assets', projectPat, 'platform-route'],
    ['POST', '/v1/feedback', projectPat, true],
    ['GET', '/v1/feedback', projectPat, 'person-route'],
    // own session only
    ['POST', '/v1/platform/boot-timeline', sessionPat, true],
    ['POST', '/v1/platform/boot-timeline', projectPat, 'platform-route'],
    ['POST', '/v1/platform/runtime-projection', sessionPat, true],
    ['POST', '/v1/chrome/attach', sessionPat, true],
    ['POST', '/v1/chrome/release', sessionPat, true],
    ['POST', '/v1/chrome/attach', projectPat, 'platform-route'],
    ['GET', '/v1/chrome/connections', sessionPat, true],
    ['GET', '/v1/chrome/connections', projectPat, 'platform-route'],
    ['DELETE', '/v1/chrome/connections', sessionPat, 'person-route'],
    // ambient, handler-bound
    ['GET', '/v1/usage/cost-summary', projectPat, true],
    ['GET', '/v1/usage/cost-by-project', projectPat, true],
    ['GET', '/v1/usage', projectPat, 'person-route'],
    ['GET', '/v1/capture/me/timeline', sessionPat, true],
    ['POST', '/v1/capture/me/timeline', sessionPat, 'person-route'],
    ['GET', '/v1/projects/current', projectPat, true],
    ['PATCH', '/v1/projects/current', projectPat, 'cross-workspace'],
    // drives
    ['GET', '/v1/drives', projectPat, true],
    ['PUT', `/v1/drives/d/files/content`, projectPat, true],
    // the workspace list: a bound key lists its one workspace; creating one is a person's act
    ['GET', '/v1/projects', projectPat, true],
    ['GET', '/v1/workspaces', projectPat, true],
    // POST /v1/workspaces passes the fence; the handler refuses every bound key (new_workspace_requires_person, WS-ROUTE-9).
    ['POST', '/v1/workspaces', projectPat, true],
    ['POST', '/v1/projects', projectPat, 'person-route'],
    ['GET', '/v1/projects/', projectPat, 'default-deny'],
    // the person's own surfaces
    ['GET', '/v1/accounts', projectPat, 'person-route'],
    ['POST', '/v1/accounts', projectPat, 'person-route'],
    ['GET', '/v1/accounts/me/devices', projectPat, 'person-route'],
    ['POST', '/v1/accounts/tokens', sessionPat, 'person-route'],
    ['GET', '/v1/me/tokens', projectPat, 'person-route'],
    ['POST', '/v1/invites/x/accept', projectPat, 'person-route'],
    ['GET', '/v1/account/deletion-plan', projectPat, 'person-route'],
    // legacy account paths: either id, through the bijection
    ['GET', `/v1/accounts/${WS}/members`, sessionPat, true],
    ['GET', `/v1/accounts/${ACCOUNT_OF_WS}/members`, sessionPat, true],
    ['GET', `/v1/accounts/${ACCOUNT_OF_WS.toUpperCase()}/members`, sessionPat, true],
    ['GET', `/v1/accounts/${OTHER}/members`, sessionPat, 'cross-workspace'],
    ['GET', `/v1/accounts/${LEGACY_ACCOUNT}/members`, projectPat, 'account-wider-than-workspace'],
    ['GET', `/v1/workspaces/${ACCOUNT_OF_WS}/members`, projectPat, true],
    // path
    ['GET', `/v1/projects/${WS}`, projectPat, true],
    ['GET', `/v1/projects/${WS.toUpperCase()}`, projectPat, true],
    ['POST', `/v1/projects/${WS}/sessions`, sessionPat, true],
    ['GET', `/v1/projects/${OTHER}/sessions`, sessionPat, 'cross-workspace'],
    ['GET', `/v1/connectors/projects/${WS}/catalog`, sessionPat, true],
    ['GET', `/v1/connectors/projects/${OTHER}/catalog`, sessionPat, 'cross-workspace'],
    ['GET', '/v1/connectors/catalog', sessionPat, 'platform-route'],
    ['GET', `/v1/workspaces/${WS}`, sessionPat, true],
    ['GET', `/v1/workspaces/${OTHER}`, sessionPat, 'cross-workspace'],
    ['GET', `/v1/workspaces/${WS}/audit`, sessionPat, true],
    ['POST', `/v1/workspaces/${WS}/restore`, projectPat, true],
    ['POST', `/v1/workspaces/${WS}/setup`, projectPat, true],
    // sandbox proxy
    ['GET', `/v1/p/${SANDBOX_OF_WS}/8000/kortix/health`, sessionPat, true],
    ['GET', '/v1/p/sbx-other/8000/kortix/health', sessionPat, 'foreign-sandbox'],
    ['GET', '/v1/p/sbx-unknown/8000/x', sessionPat, 'foreign-sandbox'],
    ['GET', '/v1/p/auth/x', sessionPat, 'person-route'],
    // billing: the workspace is a param
    ['GET', '/v1/billing/account-state', projectPat, true],
    ['GET', '/v1/billing/account-state', projectPat, true, [WS]],
    ['GET', '/v1/billing/account-state', projectPat, true, [ACCOUNT_OF_WS]],
    ['GET', '/v1/billing/account-state', projectPat, 'cross-workspace', [OTHER]],
    ['GET', '/v1/billing/account-state', projectPat, 'account-wider-than-workspace', [LEGACY_ACCOUNT]],
    ['POST', '/v1/billing/create-checkout-session', projectPat, 'cross-workspace', [WS, OTHER]],
    ['POST', '/v1/billing/cron/trial-expiry', projectPat, 'platform-route'],
    ['POST', '/v1/billing/account/request-deletion', projectPat, 'person-route'],
    // platform
    ['POST', '/v1/router/chat/completions', sessionPat, 'platform-route'],
    ['GET', '/v1/admin/api/accounts', sessionPat, 'platform-route'],
    // unlisted
    ['GET', '/v1/not-a-route', projectPat, 'default-deny'],
    ['GET', '/v1/projectsfoo', projectPat, 'default-deny'],
  ];

  for (const [method, path, cred, expected, ids] of cases) {
    test(`${method} ${path}${ids ? ` ${JSON.stringify(ids)}` : ''} (${cred.sessionBound ? 'session' : 'project'} key) → ${expected === true ? 'allowed' : expected}`, async () => {
      const v = await workspaceFenceVerdict(method, path, cred, deps, ids ? { ids } : undefined);
      if (expected === true) expect(v).toEqual({ allowed: true });
      else expect(v).toMatchObject({ allowed: false, check: expected });
    });
  }
});

describe('a key of a split_pending workspace never reaches the shared account rows', () => {
  const splitDeps = { ...deps, workspaceSplitPending: async (id: string) => id === WS };
  test('account families answer account-wider-than-workspace; the workspace own routes pass', async () => {
    for (const path of [`/v1/workspaces/${WS}/members`, `/v1/workspaces/${WS}/iam/groups`, `/v1/accounts/${WS}/members`, `/v1/workspaces/${WS}/tokens`]) {
      expect(await workspaceFenceVerdict('GET', path, projectPat, splitDeps)).toMatchObject({ allowed: false, check: 'account-wider-than-workspace' });
    }
    for (const path of [`/v1/workspaces/${WS}`, `/v1/workspaces/${WS}/sessions`, `/v1/workspaces/${WS}/audit`]) {
      expect(await workspaceFenceVerdict('GET', path, projectPat, splitDeps)).toEqual({ allowed: true });
    }
  });
});

describe('path bindings read a param their pattern declares', () => {
  // scripts/codemods/workspace-route-params.ts renames `:projectId` in every
  // route literal, this table included. A path binding that names a param its
  // pattern no longer has would refuse every workspace PAT as cross-project.
  test('every path rule names one of its pattern params', () => {
    const broken = WORKSPACE_BINDINGS.filter(
      (rule) => rule.binding.kind === 'path' && !compileBindingPattern(rule.pattern).params.includes(rule.binding.param),
    ).map((rule) => rule.pattern);
    expect(broken).toEqual([]);
  });

  test('a workspace PAT reaches its own workspace under both names, and no other', async () => {
    for (const prefix of ['/v1/projects', '/v1/workspaces', '/v1/connectors/projects', '/v1/connectors/workspaces']) {
      expect(await workspaceFenceVerdict('GET', `${prefix}/${WS}/sessions`, projectPat, deps)).toEqual({ allowed: true });
      expect((await workspaceFenceVerdict('GET', `${prefix}/${OTHER}/sessions`, projectPat, deps)).allowed).toBe(false);
    }
  });
});
