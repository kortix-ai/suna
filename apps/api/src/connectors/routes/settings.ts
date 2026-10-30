/** Admin routes: sync, per-connector settings and policies, and project policies. */
import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { policySetNameError } from '@kortix/manifest-schema';
import { auth, errors, json } from '../../openapi';
import { areValidConditions, isValidMatcher, normalizeConditions } from '../policy';
import type { ConnectorRouterDeps, ProjectPolicyView } from '../router';
import { POLICY_SET_TEMPLATES, isPolicySetTemplate, templatePolicies } from '../policy-templates';
import {
  CrudOkSchema,
  OpaqueSchema,
  ProjectParam,
  PolicySetQuery,
  ProjectSlugParam,
  ProjectSlugPolicySetParam,
  SyncResultSchema,
  featureNotSupportedResponse,
} from './shared';

export function registerConnectorSettingsRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  // ── Admin: re-materialize from kortix.yaml ───────────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors/sync',
      tags: ['connector'],
      summary: 'Re-materialize connectors from kortix.yaml',
      ...auth,
      request: { params: ProjectParam },
      responses: {
        200: json(SyncResultSchema, 'Sync result'),
        ...errors(403),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      const result = await deps.syncConnectors(projectId, admin.accountId);
      return c.json(result);
    },
  );

  // ── Admin: connector credential mode — restricted to a `shared`-only no-op.
  // `per_user` (each member brings their own) was removed 2026-07-05.
  // The route stays for back-compat callers but only ever accepts `shared` now.
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/credential-mode',
      tags: ['connector'],
      summary: "Set a connector's credential mode (shared only — per_user was removed)",
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Mode updated'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setCredentialMode)
        return featureNotSupportedResponse(c, 'connector_credential_mode');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const mode = body?.mode;
      if (mode !== 'shared') {
        return c.json(
          {
            error:
              mode === 'per_user'
                ? 'per_user credential mode was removed — connectors are always shared now'
                : 'mode must be "shared"',
          },
          400,
        );
      }
      const result = await deps.setCredentialMode(projectId, admin.accountId, slug, mode);
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );

  // ── Admin: connector authorization strategy ────────────────────────────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/authorization-strategy',
      tags: ['connector'],
      summary: "Set a connector's connection strategy",
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Authorization strategy updated'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      // DEPRECATED NO-OP. The connector-level authorization strategy is retired:
      // an account is shared or private per CONNECTION (`owner_type`), and both
      // kinds can exist on one connector. The route stays, and stays a 200, so
      // an older CLI or web build that still calls it is not broken by a 404 or
      // a 501 — it simply changes nothing. The body is not even read: there is
      // no value it could carry that would mean anything.
      void slug;
      return c.json({
        ok: true,
        deprecated: true,
        note:
          'Connector authorization strategy is retired. An account is shared or private ' +
          'per connection — connect one with owner "project" or "me" instead.',
      });
    },
  );

  // ── Admin: toggle a connector's `sensitive` flag (reads gate too) ─────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/sensitive',
      tags: ['connector'],
      summary: "Toggle a connector's sensitive flag (gate reads too)",
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Sensitive flag updated'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setSensitive) return featureNotSupportedResponse(c, 'connector_sensitive');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      if (typeof body?.sensitive !== 'boolean') {
        return c.json({ error: 'sensitive must be a boolean' }, 400);
      }
      const result = await deps.setSensitive(projectId, admin.accountId, slug, body.sensitive);
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );

  // ── Admin: rename a connector (display label) ────────────────────────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/name',
      tags: ['connector'],
      summary: 'Rename a connector (display label)',
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Renamed'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setConnectorName) return featureNotSupportedResponse(c, 'connector_rename');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name.trim()) return c.json({ error: '`name` is required' }, 400);
      const result = await deps.setConnectorName(projectId, admin.accountId, slug, name);
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );

  // ── Admin: read a connector's per-tool/per-pattern policies ──────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connectors/{slug}/policies',
      tags: ['connector'],
      summary: "Read a connector's tool-call policies (base rules, or one policy set's)",
      ...auth,
      request: { params: ProjectSlugParam, query: PolicySetQuery },
      responses: {
        200: json(OpaqueSchema, 'Connector policies'),
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.getConnectorPolicies)
        return featureNotSupportedResponse(c, 'connector_policies_read');
      const policySet = policySetQueryOf(c);
      if (policySet && 'error' in policySet) return c.json(policySet, 400);
      const result = await deps.getConnectorPolicies(projectId, slug, policySet?.name ?? null);
      if (!result) return c.json({ error: 'connector not found' }, 404);
      if ('error' in result) return c.json(result, 404);
      return c.json(result);
    },
  );

  // ── Admin: read a connector's definition (for editing the connection) ────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connectors/{slug}/config',
      tags: ['connector'],
      summary: "Read a connector's connection config (provider, url, auth, …)",
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OpaqueSchema, 'Connector config'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.getConnectorConfig) return featureNotSupportedResponse(c, 'connector_config_read');
      const result = await deps.getConnectorConfig(projectId, slug);
      if (!result) return c.json({ error: 'connector not found' }, 404);
      return c.json(result);
    },
  );

  // ── Admin: replace a connector's policies (write-through to kortix.yaml) ──
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/policies',
      tags: ['connector'],
      summary: "Replace a connector's tool-call policies (base rules, or one policy set's)",
      ...auth,
      request: {
        params: ProjectSlugParam,
        query: PolicySetQuery,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Policies updated'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setConnectorPolicies)
        return featureNotSupportedResponse(c, 'connector_policies_write');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const policies = Array.isArray(body?.policies) ? body.policies : null;
      if (!policies) return c.json({ error: '`policies` must be an array' }, 400);
      const policySet = policySetQueryOf(c);
      if (policySet && 'error' in policySet) return c.json(policySet, 400);
      const result = await deps.setConnectorPolicies(projectId, admin.accountId, slug, policies, policySet?.name ?? null);
      return crudResponse(c, result);
    },
  );

  registerConnectorPolicySetRoutes(app, deps);
  registerRulesReadModelRoutes(app, deps);
}

/** Who uses which connector under which rules (`agent-rules-matrix.ts`). */
function registerRulesReadModelRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connectors/{slug}/agents',
      tags: ['connector'],
      summary: 'Every agent: may it use this connector, and under which rule set',
      ...auth,
      request: { params: ProjectSlugParam },
      responses: { 200: json(OpaqueSchema, 'Agents of a connector'), ...errors(403, 404, 501) },
    }),
    async (c: Context) => {
      const projectId = c.req.param('projectId')!;
      const slug = c.req.param('slug')!;
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.getRulesMatrix) return featureNotSupportedResponse(c, 'connector_rules_matrix');
      const matrix = await deps.getRulesMatrix(projectId);
      const connector = matrix?.connectors.find((row) => row.slug === slug);
      if (!matrix || !connector) return c.json({ error: 'connector not found', code: 'connector_not_found' }, 404);
      return c.json({
        slug,
        policy_sets: connector.policy_sets,
        agents: matrix.agents.map(({ agent, cells }) => ({ agent, ...cells[slug]! })),
      });
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/rules-matrix',
      tags: ['connector'],
      summary: 'Every connector × every agent: granted, and the rule set it runs under',
      ...auth,
      request: { params: ProjectParam },
      responses: { 200: json(OpaqueSchema, 'Rules matrix'), ...errors(403, 404, 501) },
    }),
    async (c: Context) => {
      const projectId = c.req.param('projectId')!;
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.getRulesMatrix) return featureNotSupportedResponse(c, 'connector_rules_matrix');
      const matrix = await deps.getRulesMatrix(projectId);
      if (!matrix) return c.json({ error: 'project not found' }, 404);
      return c.json(matrix);
    },
  );
}

/** `?policy_set=<name>`: absent/empty/`base` = the base rules. */
function policySetQueryOf(c: Context): { name: string } | { error: string; code: string } | null {
  const raw = c.req.query('policy_set');
  if (typeof raw !== 'string' || !raw.trim() || raw.trim() === 'base') return null;
  const name = raw.trim();
  const problem = policySetNameError(name);
  return problem ? { error: problem, code: 'invalid_policy_set_name' } : { name };
}

function crudResponse(
  c: Context,
  result: { ok: true; sync?: unknown } | { ok: false; error: string; status: number; body?: Record<string, unknown> },
  extra: Record<string, unknown> = {},
) {
  if (!result.ok) {
    return c.json(result.body ?? { error: result.error }, result.status as 400 | 404 | 409 | 502);
  }
  return c.json({ ok: true, sync: result.sync, ...extra }, 200);
}

/**
 * Policy sets: named rule sets on one connector (`connectors[].policy_sets`)
 * that an agent is given with `agents.<a>.policy_sets`. These routes own the
 * set itself (create, description, rename, delete, list). Its RULES are
 * written only through `PUT .../policies?policy_set=<name>`. Every write
 * commits kortix.yaml on the default branch, then syncs.
 */
function registerConnectorPolicySetRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connectors/{slug}/policy-sets',
      tags: ['connector'],
      summary: "List a connector's policy sets, with their rules and the agents using each",
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OpaqueSchema, 'Policy sets'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: Context) => {
      const projectId = c.req.param('projectId')!;
      const slug = c.req.param('slug')!;
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.listConnectorPolicySets) return featureNotSupportedResponse(c, 'connector_policy_sets');
      const result = await deps.listConnectorPolicySets(projectId, slug);
      if (!result) return c.json({ error: 'connector not found', code: 'connector_not_found' }, 404);
      return c.json(result);
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/policy-sets/{name}',
      tags: ['connector'],
      summary: 'Create a policy set, or change its description',
      ...auth,
      request: {
        params: ProjectSlugPolicySetParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(OpaqueSchema, 'Policy set saved'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: Context) => {
      const projectId = c.req.param('projectId')!;
      const slug = c.req.param('slug')!;
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.upsertConnectorPolicySet) return featureNotSupportedResponse(c, 'connector_policy_sets');
      let body: any = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      if (body?.policies !== undefined || body?.rules !== undefined) {
        return c.json(
          {
            error: 'set rules through PUT .../policies?policy_set=<name>',
            code: 'use_policies_route',
          },
          400,
        );
      }
      if (body?.template !== undefined && !isPolicySetTemplate(body.template)) {
        return c.json(
          { error: `\`template\` must be one of: ${POLICY_SET_TEMPLATES.join(', ')}`, code: 'invalid_template' },
          400,
        );
      }
      const description =
        body?.description === undefined ? undefined : typeof body.description === 'string' ? body.description : null;
      const name = c.req.param('name')!;
      // A template writes the set and its rules in one commit: one rule per
      // tool that is not likely a read. Applying it replaces the set's rules.
      let rules: ReturnType<typeof templatePolicies> | undefined;
      if (isPolicySetTemplate(body?.template)) {
        const connector = (await deps.listConnectors(projectId, admin.userId, { includeSchemas: false })).find(
          (row) => row.slug === slug,
        );
        rules = templatePolicies(body.template, connector?.actions ?? [], connector?.provider);
      }
      const result = await deps.upsertConnectorPolicySet(projectId, admin.accountId, slug, name, description, rules);
      return crudResponse(
        c,
        result,
        result.ok
          ? { created: result.created ?? false, ...(rules ? { template: body.template, rules: rules.length } : {}) }
          : {},
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/policy-sets/{name}/name',
      tags: ['connector'],
      summary: 'Rename a policy set and every agent assignment of it, in one commit',
      ...auth,
      request: {
        params: ProjectSlugPolicySetParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(OpaqueSchema, 'Policy set renamed'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: Context) => {
      const projectId = c.req.param('projectId')!;
      const slug = c.req.param('slug')!;
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.renameConnectorPolicySet) return featureNotSupportedResponse(c, 'connector_policy_sets');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const to = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!to) return c.json({ error: '`name` is required', code: 'invalid_policy_set_name' }, 400);
      const result = await deps.renameConnectorPolicySet(projectId, admin.accountId, slug, c.req.param('name')!, to);
      return crudResponse(c, result);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/projects/{projectId}/connectors/{slug}/policy-sets/{name}',
      tags: ['connector'],
      summary: 'Delete a policy set (409 policy_set_in_use while an agent uses it)',
      ...auth,
      request: { params: ProjectSlugPolicySetParam },
      responses: {
        200: json(OpaqueSchema, 'Policy set deleted'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: Context) => {
      const projectId = c.req.param('projectId')!;
      const slug = c.req.param('slug')!;
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.deleteConnectorPolicySet) return featureNotSupportedResponse(c, 'connector_policy_sets');
      const result = await deps.deleteConnectorPolicySet(projectId, admin.accountId, slug, c.req.param('name')!);
      return crudResponse(c, result);
    },
  );
}

export function registerProjectPolicyRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  // ── Admin: read project policies (top-level [[policies]] + [policy]) ────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/policies',
      tags: ['connector'],
      summary: 'Read project policies and default mode',
      ...auth,
      request: { params: ProjectParam },
      responses: {
        200: json(OpaqueSchema, 'Project policies view'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.getProjectPolicies) return featureNotSupportedResponse(c, 'project_policies_read');
      const result = await deps.getProjectPolicies(projectId);
      if (!result) return c.json({ error: 'project not found' }, 404);
      return c.json(result);
    },
  );

  // ── Admin: replace project policies (write-through to kortix.yaml) ──────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/policies',
      tags: ['connector'],
      summary: 'Replace project policies and default mode',
      ...auth,
      request: {
        params: ProjectParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Policies replaced'),
        ...errors(400, 403, 409, 501, 502),
      },
    }),
    // Manual parse kept: original does per-policy validation with indexed error
    // messages (`policy #N: ...`) and tolerates a partial/missing body.
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setProjectPolicies) return featureNotSupportedResponse(c, 'project_policies_write');

      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }

      const rawPolicies = Array.isArray(body?.policies) ? body.policies : [];
      const policies: ProjectPolicyView[] = [];
      for (let i = 0; i < rawPolicies.length; i++) {
        const p = rawPolicies[i];
        const match = typeof p?.match === 'string' ? p.match.trim() : '';
        const action = typeof p?.action === 'string' ? p.action.trim() : '';
        if (!match) return c.json({ error: `policy #${i + 1}: \`match\` is required` }, 400);
        if (action !== 'always_run' && action !== 'require_approval' && action !== 'block') {
          return c.json({ error: `policy #${i + 1}: invalid \`action\` "${action}"` }, 400);
        }
        // Reject an invalid matcher at WRITE time. An unparseable pattern
        // compiles to a never-match, so a broken `block` rule would look saved
        // while silently protecting nothing.
        if (!isValidMatcher(match)) {
          return c.json(
            {
              error: `policy #${i + 1}: invalid \`match\` pattern "${match}"`,
              code: 'INVALID_MATCHER',
            },
            400,
          );
        }
        if (p?.conditions !== undefined && p?.conditions !== null) {
          if (!areValidConditions(p.conditions)) {
            return c.json(
              {
                error: `policy #${i + 1}: invalid \`conditions\` — each needs \`arg\` (a dot path, not __proto__/constructor/prototype) and \`match\` (glob or /regex/), with optional boolean \`negate\``,
                code: 'INVALID_CONDITIONS',
              },
              400,
            );
          }
          policies.push({ match, action, conditions: normalizeConditions(p.conditions) });
          continue;
        }
        policies.push({ match, action });
      }
      const defaultMode = body?.defaultMode === 'risk' ? 'risk' : 'allow_all';

      const result = await deps.setProjectPolicies(
        projectId,
        admin.accountId,
        policies,
        defaultMode,
      );
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );
}
