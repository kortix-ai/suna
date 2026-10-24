/** Catalogue browse routes: Discover (integrations.sh, or everything under connectors_v2), easy-connect toolkits, Pipedream apps. */
import { withDirectIds, withDirectMcpUrls } from '../connect-direct-twins';
import { CatalogInstallError, catalogInstallDraft } from '../catalog-install';
import type { ConnectorCatalogDetail } from '../connector-catalog';
import { allowedSourceValidationResponse } from './admin';
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { featureDisabledBody } from '../../feature-flags/gate';
import { auth, errors, json } from '../../openapi';
import type { ConnectorRouterDeps } from '../router';
import { OpaqueSchema, ProjectParam, featureNotSupportedResponse } from './shared';

const OneClickParam = z.enum(['1', 'true', '0', 'false']).optional();
const oneClickQuery = (c: { req: { query(name: string): string | undefined } }) =>
  ['1', 'true'].includes(c.req.query('oneClick') ?? '');

const KINDS = ['mcp', 'openapi', 'graphql', 'composio', 'channel'] as const;
/** `kind=mcp,composio`: only the apps that connect one of these ways. */
const KindParam = z
  .string()
  .regex(new RegExp(`^(${KINDS.join('|')})(,(${KINDS.join('|')}))*$`))
  .optional();
const kindsQuery = (c: { req: { query(name: string): string | undefined } }) => {
  const kinds = (c.req.query('kind') ?? '').split(',').filter(Boolean) as (typeof KINDS)[number][];
  return kinds.length ? { kinds } : {};
};

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
          /** `1`: only the apps that connect with nothing to set up. */
          oneClick: OneClickParam,
          kind: KindParam,
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
      const catalogue = await discoverCatalogue(deps, projectId);
      if (!catalogue) return c.json(featureDisabledBody('connectors_api_discover'), 403);
      if (!deps.listDiscoverConnectors) return c.json({ error: 'catalogue unavailable' }, 502);
      const limit = Number(c.req.query('limit'));
      try {
        return c.json(
          await deps.listDiscoverConnectors({
            catalogue,
            q: c.req.query('q') || undefined,
            cursor: c.req.query('cursor') || undefined,
            category: c.req.query('category') || undefined,
            ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
            ...(oneClickQuery(c) ? { oneClick: true } : {}),
            ...kindsQuery(c),
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
          oneClick: OneClickParam,
          kind: KindParam,
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
      const catalogue = await discoverCatalogue(deps, projectId);
      if (!catalogue) return c.json(featureDisabledBody('connectors_api_discover'), 403);
      if (!deps.listDiscoverSections) return c.json({ error: 'catalogue unavailable' }, 502);
      const perCategory = Number(c.req.query('perCategory'));
      const maxCategories = Number(c.req.query('maxCategories'));
      try {
        return c.json(
          await deps.listDiscoverSections({
            catalogue,
            ...(Number.isFinite(perCategory) && perCategory > 0 ? { perCategory } : {}),
            ...(Number.isFinite(maxCategories) && maxCategories > 0 ? { maxCategories } : {}),
            ...(oneClickQuery(c) ? { oneClick: true } : {}),
            ...kindsQuery(c),
          }),
        );
      } catch (error) {
        return c.json({ error: (error as Error).message || 'catalogue unavailable' }, 502);
      }
    },
  );
}

export function registerDiscoverDetailRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  registerDiscoverToolsAndInstallRoutes(app, deps);
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
      const catalogue = await discoverCatalogue(deps, projectId);
      if (!catalogue) return c.json(featureDisabledBody('connectors_api_discover'), 403);
      if (!deps.getDiscoverConnector) return c.json({ error: 'catalogue unavailable' }, 502);
      try {
        return c.json(await deps.getDiscoverConnector(c.req.query('id'), catalogue));
      } catch (error) {
        const message = (error as Error).message || 'catalogue unavailable';
        return c.json({ error: message }, message === 'Connector not found' ? 404 : 502);
      }
    },
  );
}

const InstallBody = z.object({
  id: z.string().min(1).openapi({ description: 'Catalogue id, e.g. kortix:linear or composio:gmail.' }),
  way: z.string().optional().openapi({ description: 'A variant id from the detail. Default: the recommended way.' }),
  name: z.string().optional().openapi({ description: 'Display name. Default: the app name.' }),
  slug: z.string().optional().openapi({ description: 'Slug in kortix.yaml. Default: from the name.' }),
});

function registerDiscoverToolsAndInstallRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  // ── Admin: what one way to connect an app can do, before install ─────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/discover/connectors/tools',
      tags: ['connector'],
      summary: 'List the tools one way to connect a catalogue app offers',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({
          id: z.string().min(1),
          /** A variant id from the detail; default: the recommended one. */
          way: z.string().optional(),
        }),
      },
      responses: { 200: json(OpaqueSchema, 'Tools'), ...errors(403, 404, 502) },
    }),
    async (c: Context) => {
      const projectId = c.req.param('projectId') ?? '';
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      const catalogue = await discoverCatalogue(deps, projectId);
      if (!catalogue) return c.json(featureDisabledBody('connectors_api_discover'), 403);
      if (!deps.getDiscoverConnector || !deps.discoverConnectorTools) return c.json({ error: 'catalogue unavailable' }, 502);
      let detail: ConnectorCatalogDetail;
      try {
        detail = (await deps.getDiscoverConnector(c.req.query('id') ?? '', catalogue)) as ConnectorCatalogDetail;
      } catch (error) {
        const message = (error as Error).message || 'catalogue unavailable';
        return c.json({ error: message }, message === 'Connector not found' ? 404 : 502);
      }
      const wayId = c.req.query('way');
      const way = wayId
        ? detail.variants.find((variant) => variant.id === wayId)
        : (detail.variants.find((variant) => variant.recommended) ?? detail.variants[0]);
      if (!way) return c.json({ error: wayId ? `no way "${wayId}"` : 'no way to connect' }, 404);
      try {
        const tools = await deps.discoverConnectorTools(way);
        return c.json({ way: { id: way.id, kind: way.kind, name: way.name }, ...tools });
      } catch (error) {
        return c.json({ error: `could not read the tools: ${(error as Error).message}` }, 502);
      }
    },
  );

  // ── Admin: install one way to connect an app as a connector profile ──────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/discover/install',
      tags: ['connector'],
      summary: 'Install a catalogue app as a connector profile',
      description:
        'Adds the connector profile (its kortix.yaml entry) for one way to connect the app: `way` by id, else the recommended one. Accounts, who may use them and tool rules are set on the profile afterwards.',
      ...auth,
      request: {
        params: ProjectParam,
        body: {
          content: {
            'application/json': {
              schema: InstallBody,
            },
          },
        },
      },
      responses: { 200: json(OpaqueSchema, 'Installed'), ...errors(400, 403, 404, 409, 501, 502) },
    }),
    async (c: Context) => {
      const projectId = c.req.param('projectId') ?? '';
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      const catalogue = await discoverCatalogue(deps, projectId);
      if (!catalogue) return c.json(featureDisabledBody('connectors_api_discover'), 403);
      if (!deps.getDiscoverConnector || !deps.createConnector) return featureNotSupportedResponse(c, 'connector_create');
      const parsed = InstallBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'pass `id`, and optionally `way`, `name` and `slug`' }, 400);
      const body = parsed.data;
      let detail: ConnectorCatalogDetail;
      try {
        detail = (await deps.getDiscoverConnector(body.id, catalogue)) as ConnectorCatalogDetail;
      } catch (error) {
        const message = (error as Error).message || 'catalogue unavailable';
        return c.json({ error: message }, message === 'Connector not found' ? 404 : 502);
      }
      let built: ReturnType<typeof catalogInstallDraft>;
      try {
        built = catalogInstallDraft(detail, body);
      } catch (error) {
        if (error instanceof CatalogInstallError) return c.json({ error: error.message }, 400);
        throw error;
      }
      const { draft, way } = built;
      try {
        // Best effort, as on the web: a server that cannot be probed now still
        // installs, and its sign-in or credential is set on the profile later.
        if (way.kind !== 'composio' && !draft.auth && deps.discoverConnectorAuth) {
          const discovery = await deps.discoverConnectorAuth(projectId, draft).catch((err: unknown) => {
            if (allowedSourceValidationResponse(c, err)) throw err;
            return null;
          });
          if (discovery?.recommended) draft.auth = discovery.recommended;
        }
        let result = await deps.createConnector(projectId, admin.accountId, draft, admin.userId);
        // A default slug the project already uses: one more try with a suffix.
        if (!result.ok && result.status === 409 && !body.slug) {
          draft.slug = `${draft.slug}-${Math.random().toString(36).slice(2, 8)}`;
          result = await deps.createConnector(projectId, admin.accountId, draft, admin.userId);
        }
        if (!result.ok) return c.json(result.body ?? { error: result.error }, result.status as 400 | 403 | 409 | 502);
        const oauth = way.kind === 'composio' || (way.kind === 'mcp' && way.oneClick === true);
        const credential = (draft.auth as { type?: string } | undefined)?.type;
        return c.json({
          ok: true,
          slug: draft.slug,
          name: draft.name,
          provider: draft.provider,
          way: { id: way.id, kind: way.kind, name: way.name, oneClick: way.oneClick === true },
          sync: result.sync,
          next: oauth ? 'connect' : credential && credential !== 'none' ? 'credential' : 'ready',
        });
      } catch (err) {
        const validation = allowedSourceValidationResponse(c, err);
        if (validation) return c.json(await validation.json(), 400);
        throw err;
      }
    },
  );
}

/**
 * Which catalogue Discover serves: for a `connectors_v2` project, Kortix's MCP
 * apps, integrations.sh and the managed toolkits as one (`connectors/mcp-apps.ts`);
 * integrations.sh alone behind
 * `connectors_api_discover`, else none.
 */
async function discoverCatalogue(
  deps: ConnectorRouterDeps,
  projectId: string,
): Promise<'kortix' | 'integrations' | null> {
  if (await deps.featureFlagEnabled(projectId, 'connectors_v2')) return 'kortix';
  return (await deps.featureFlagEnabled(projectId, 'connectors_api_discover')) ? 'integrations' : null;
}

/**
 * Each managed app with `directMcpUrl` (its hosted MCP server, which Install
 * offers first) and, for a project with the API/MCP catalogue on, `directId`
 * (the same app's catalogue id). A lookup failure leaves the listing as it was.
 */
async function withCatalogTwins(
  deps: ConnectorRouterDeps,
  projectId: string,
  result: unknown,
): Promise<unknown> {
  let out = result;
  try {
    if (deps.catalogDirectMcpUrls) out = withDirectMcpUrls(out, await deps.catalogDirectMcpUrls());
  } catch {
    /* listing without MCP URLs */
  }
  if (!deps.catalogDirectIds) return out;
  try {
    if (!(await deps.featureFlagEnabled(projectId, 'connectors_api_discover'))) return out;
    return withDirectIds(out, await deps.catalogDirectIds());
  } catch {
    return out;
  }
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
      return result
        ? c.json(await withCatalogTwins(deps, projectId, result))
        : featureNotSupportedResponse(c, 'connect_toolkits');
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
      return result
        ? c.json(await withCatalogTwins(deps, projectId, result))
        : featureNotSupportedResponse(c, 'connect_toolkits');
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
          z.object({
            configured: z.boolean(),
            provider: z.string().nullable(),
            providers: z.array(z.string()).optional(),
          }),
          'Connect provider status',
        ),
        ...errors(401),
      },
    }),
    async (c: any) => {
      const result = deps.connectStatus
        ? await deps.connectStatus()
        : {
            configured: !!deps.listPipedreamApps,
            provider: deps.listPipedreamApps ? 'pipedream' : null,
          };
      return c.json(result);
    },
  );
}
