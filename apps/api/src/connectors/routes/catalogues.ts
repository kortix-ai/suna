/** Catalogue browse routes: Discover (integrations.sh), easy-connect toolkits, Pipedream apps. */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { featureDisabledBody } from '../../feature-flags/gate';
import { auth, errors, json } from '../../openapi';
import type { ConnectorRouterDeps } from '../router';
import { OpaqueSchema, ProjectParam, featureNotSupportedResponse } from './shared';

export function registerDiscoverRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  // ── Admin: browse direct connector surfaces ───────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/discover/connectors',
      tags: ['connector'],
      summary: 'Browse the integrations.sh catalogue',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({
          q: z.string().optional(),
          cursor: z.string().optional(),
          /** A browse-section key from `/discover/sections`. */
          category: z.string().optional(),
          limit: z.coerce.number().int().positive().max(96).optional(),
        }),
      },
      responses: {
        200: json(OpaqueSchema, 'Direct connector catalogue page'),
        ...errors(403, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      // Flag gate AFTER authz: a non-admin still learns nothing.
      if (!(await deps.featureFlagEnabled(projectId, 'connectors_api_discover'))) {
        return c.json(featureDisabledBody('connectors_api_discover'), 403);
      }
      if (!deps.listDiscoverConnectors) return c.json({ error: 'catalogue unavailable' }, 502);
      const limit = Number(c.req.query('limit'));
      try {
        return c.json(
          await deps.listDiscoverConnectors({
            q: c.req.query('q') || undefined,
            cursor: c.req.query('cursor') || undefined,
            category: c.req.query('category') || undefined,
            ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          }),
        );
      } catch (error) {
        return c.json({ error: (error as Error).message || 'catalogue unavailable' }, 502);
      }
    },
  );

  // ── Admin: the Discover browse page, one request ─────────────────────────
  // Sections grouped from the complete integrations.sh index, so each heading
  // states its section's real size instead of how many cards one page held.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/discover/sections',
      tags: ['connector'],
      summary: 'Browse the integrations.sh catalogue by category',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({
          perCategory: z.coerce.number().int().positive().max(24).optional(),
          maxCategories: z.coerce.number().int().positive().max(40).optional(),
        }),
      },
      responses: {
        200: json(OpaqueSchema, 'Direct connector catalogue sections'),
        ...errors(403, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      // Flag gate AFTER authz: a non-admin still learns nothing.
      if (!(await deps.featureFlagEnabled(projectId, 'connectors_api_discover'))) {
        return c.json(featureDisabledBody('connectors_api_discover'), 403);
      }
      if (!deps.listDiscoverSections) return c.json({ error: 'catalogue unavailable' }, 502);
      const perCategory = Number(c.req.query('perCategory'));
      const maxCategories = Number(c.req.query('maxCategories'));
      try {
        return c.json(
          await deps.listDiscoverSections({
            ...(Number.isFinite(perCategory) && perCategory > 0 ? { perCategory } : {}),
            ...(Number.isFinite(maxCategories) && maxCategories > 0 ? { maxCategories } : {}),
          }),
        );
      } catch (error) {
        return c.json({ error: (error as Error).message || 'catalogue unavailable' }, 502);
      }
    },
  );
}

export function registerDiscoverDetailRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/discover/connectors/detail',
      tags: ['connector'],
      summary: 'Resolve the surfaces for an integrations.sh catalogue record',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({ id: z.string().min(1) }),
      },
      responses: {
        200: json(OpaqueSchema, 'Connector surface detail'),
        ...errors(403, 404, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      // Flag gate AFTER authz: a non-admin still learns nothing.
      if (!(await deps.featureFlagEnabled(projectId, 'connectors_api_discover'))) {
        return c.json(featureDisabledBody('connectors_api_discover'), 403);
      }
      if (!deps.getDiscoverConnector) return c.json({ error: 'catalogue unavailable' }, 502);
      try {
        return c.json(await deps.getDiscoverConnector(c.req.query('id')));
      } catch (error) {
        const message = (error as Error).message || 'catalogue unavailable';
        return c.json({ error: message }, message === 'Connector not found' ? 404 : 502);
      }
    },
  );
}

export function registerConnectCatalogueRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  // ── Admin: browse the configured easy-connect toolkit catalogue ─────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connect/toolkits',
      tags: ['connector'],
      summary: 'Browse the configured easy-connect toolkit catalogue',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({
          q: z.string().optional(),
          category: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().positive().max(100).optional(),
        }),
      },
      responses: { 200: json(OpaqueSchema, 'Easy-connect toolkit page'), ...errors(403, 501) },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.listConnectToolkits) return featureNotSupportedResponse(c, 'connect_toolkits');
      const limit = Number(c.req.query('limit'));
      const result = await deps.listConnectToolkits(projectId, {
        q: c.req.query('q') || undefined,
        category: c.req.query('category') || undefined,
        cursor: c.req.query('cursor') || undefined,
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      });
      return result ? c.json(result) : featureNotSupportedResponse(c, 'connect_toolkits');
    },
  );

  // ── Admin: the easy-connect browse page, one request ─────────────────────
  // The Composio counterpart of `/pipedream/sections`. Sections are grouped from
  // the complete catalogue, so each heading states its category's real size
  // instead of how many toolkits one loaded page happened to hold.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connect/sections',
      tags: ['connector'],
      summary: 'Browse the easy-connect toolkit catalogue by category',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({
          perCategory: z.coerce.number().int().positive().max(24).optional(),
          maxCategories: z.coerce.number().int().positive().max(40).optional(),
        }),
      },
      responses: {
        200: json(OpaqueSchema, 'Easy-connect catalogue sections'),
        ...errors(403, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.listConnectSections) return featureNotSupportedResponse(c, 'connect_toolkits');
      const perCategory = Number(c.req.query('perCategory'));
      const maxCategories = Number(c.req.query('maxCategories'));
      const result = await deps.listConnectSections(projectId, {
        ...(Number.isFinite(perCategory) && perCategory > 0 ? { perCategory } : {}),
        ...(Number.isFinite(maxCategories) && maxCategories > 0 ? { maxCategories } : {}),
      });
      return result ? c.json(result) : featureNotSupportedResponse(c, 'connect_toolkits');
    },
  );

  // ── Admin: legacy Pipedream app catalogue (rollback only) ────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/pipedream/apps',
      tags: ['connector'],
      summary: 'Browse the Pipedream app catalogue',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({
          q: z.string().optional(),
          /** A category key from the same response's `categories` facet. */
          category: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().positive().max(100).optional(),
        }),
      },
      responses: {
        200: json(OpaqueSchema, 'Pipedream apps page'),
        ...errors(403, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.listPipedreamApps) return featureNotSupportedResponse(c, 'pipedream_apps');
      const limit = Number(c.req.query('limit'));
      const result = await deps.listPipedreamApps({
        q: c.req.query('q') || undefined,
        category: c.req.query('category') || undefined,
        cursor: c.req.query('cursor') || undefined,
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      });
      return c.json(result);
    },
  );

  // ── Admin: the browse page, one request ──────────────────────────────────
  // A fixed top slice of each of the largest categories. Exists so the
  // Discovery sections are a complete, stable view of each category instead of
  // a bucketing of whichever pages happened to have loaded — which is what made
  // sections grow and reflow while the user was reading them.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/pipedream/sections',
      tags: ['connector'],
      summary: 'Browse the Pipedream catalogue by category',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({
          perCategory: z.coerce.number().int().positive().max(24).optional(),
          maxCategories: z.coerce.number().int().positive().max(40).optional(),
        }),
      },
      responses: {
        200: json(OpaqueSchema, 'Pipedream catalogue sections'),
        ...errors(403, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.listPipedreamSections) return featureNotSupportedResponse(c, 'pipedream_apps');
      const perCategory = Number(c.req.query('perCategory'));
      const maxCategories = Number(c.req.query('maxCategories'));
      const result = await deps.listPipedreamSections({
        ...(Number.isFinite(perCategory) && perCategory > 0 ? { perCategory } : {}),
        ...(Number.isFinite(maxCategories) && maxCategories > 0 ? { maxCategories } : {}),
      });
      return c.json(result);
    },
  );

  // ── Whether easy-connect (Pipedream) is configured on this deployment ─────
  // Deployment-global capability flag (no project context) so the UI can hide or
  // disable the "Easy Connect" surface up front instead of letting the user open
  // it and hit a 501. `listPipedreamApps` is only wired when pipedreamConfigured(),
  // so its presence is an exact proxy.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/connect-status',
      tags: ['connector'],
      summary: 'Whether an easy-connect provider is configured on this deployment',
      ...auth,
      responses: {
        200: json(
          z.object({ configured: z.boolean(), provider: z.string().nullable(), providers: z.array(z.string()).optional() }),
          'Connect provider status',
        ),
        ...errors(401),
      },
    }),
    async (c: any) => {
      const result = deps.connectStatus
        ? await deps.connectStatus()
        : { configured: !!deps.listPipedreamApps, provider: deps.listPipedreamApps ? 'pipedream' : null };
      return c.json(result);
    },
  );
}
