/** Admin routes: sync, per-connector settings and policies, and project policies. */
import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { areValidConditions, isValidMatcher, normalizeConditions } from '../policy';
import type { ConnectorRouterDeps, ProjectPolicyView } from '../router';
import {
  CrudOkSchema,
  OpaqueSchema,
  ProjectParam,
  ProjectSlugParam,
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
      summary: "Read a connector's tool-call policies",
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OpaqueSchema, 'Connector policies'),
        ...errors(403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.getConnectorPolicies)
        return featureNotSupportedResponse(c, 'connector_policies_read');
      const result = await deps.getConnectorPolicies(projectId, slug);
      if (!result) return c.json({ error: 'connector not found' }, 404);
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
      summary: "Replace a connector's tool-call policies",
      ...auth,
      request: {
        params: ProjectSlugParam,
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
      const result = await deps.setConnectorPolicies(projectId, admin.accountId, slug, policies);
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
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
