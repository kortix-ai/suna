/**
 * Shared OpenAPI wiring for the Kortix API.
 *
 * Every sub-router is an `OpenAPIHono` created via `makeOpenApiApp()` so it (a)
 * contributes typed route definitions to the spec and (b) shares one validation
 * error contract. Routes are defined with `createRoute()` + zod; the spec is
 * served at /v1/openapi.json and rendered by Scalar at /v1/docs.
 */
import { OpenAPIHono, z, type RouteConfig } from '@hono/zod-openapi';
import { ErrorEnvelopeSchema } from '@kortix/api-contract';
import type { Env } from 'hono';
import { Scalar } from '@scalar/hono-api-reference';

/** Permissive error envelope — matches the platform's `{error,message,status}` 404 shape. */
export const ErrorSchema = ErrorEnvelopeSchema.openapi('Error');

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  402: 'Payment required',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  410: 'Gone',
  429: 'Rate limited',
  500: 'Server error',
  501: 'Not implemented',
  502: 'Bad gateway',
  503: 'Service unavailable',
};

/** A JSON response entry for a createRoute `responses` map. */
export const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

/**
 * Standard error responses for the given status codes, keyed for `responses`.
 * Generic over the literal codes so the keys stay literal (e.g. `401`, not
 * `number`) — zod-openapi's typed handler needs the literal status union, so a
 * widened `Record<number,…>` would break `c.json(body, 401)` handler typing.
 */
export const errors = <C extends number>(...codes: C[]): { [K in C]: ReturnType<typeof json> } =>
  Object.fromEntries(
    codes.map((c) => [c, json(ErrorSchema, STATUS_TEXT[c] ?? 'Error')]),
  ) as unknown as {
    [K in C]: ReturnType<typeof json>;
  };

/** Mark an operation as requiring a bearer token. */
export const auth: Pick<RouteConfig, 'security'> = { security: [{ bearerAuth: [] }] };

/**
 * Single validation-error contract for every typed route. Zod failures (bad body,
 * params, query) become a consistent 400 envelope instead of per-route ad-hoc shapes.
 */
function defaultHook(result: { success: boolean; error?: { issues: unknown } }, c: any) {
  if (!result.success) {
    return c.json(
      { error: true, message: 'Validation failed', status: 400, issues: result.error?.issues },
      400,
    );
  }
}

/** Create an OpenAPIHono sub-app with the shared error contract. */
export function makeOpenApiApp<E extends Env = Env>() {
  return new OpenAPIHono<E>({ defaultHook });
}

/**
 * Route prefixes whose schemas are INTERNAL and must not appear in the public
 * spec. These routers are runtime-gated (admin: supabaseAuth + requireAdmin;
 * ops: platform-admin) but `app.route()` still merges their typed definitions
 * into the shared registry, so `getOpenAPI31Document` would otherwise publish
 * admin credit-debit / tier-change / ops shapes to anyone hitting
 * /v1/openapi.json. SCIM (`/scim/v2`) is deliberately NOT here — it's an
 * RFC-7644 standard surface IdP admins legitimately introspect.
 */
export const INTERNAL_SPEC_PREFIXES = ['/v1/admin', '/v1/ops'] as const;

/**
 * Drop any path whose key equals an internal prefix or sits under it
 * (`prefix + '/'`). Pure + exported for unit tests. The `+ '/'` boundary keeps
 * a sibling like `/v1/administrators` from being swept by the `/v1/admin`
 * prefix. Returns a shallow-cloned doc; the input is not mutated.
 */
export function filterSpecPaths<T extends { paths?: Record<string, unknown> }>(
  doc: T,
  prefixes: readonly string[] = INTERNAL_SPEC_PREFIXES,
): T {
  if (!doc.paths) return doc;
  const kept: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(doc.paths)) {
    const internal = prefixes.some((p) => path === p || path.startsWith(`${p}/`));
    if (!internal) kept[path] = item;
  }
  return { ...doc, paths: kept };
}

const PROJECT_SPEC_PREFIX = '/v1/projects';
const WORKSPACE_SPEC_PREFIX = '/v1/workspaces';
const WORKSPACE_FIELD_NAMES: Readonly<Record<string, string>> = {
  project_id: 'workspace_id',
  project_role: 'workspace_role',
  effective_project_role: 'effective_workspace_role',
  project: 'workspace',
  projects: 'workspaces',
};

function workspaceSchemaName(name: string): string {
  const replaced = name.replaceAll('Projects', 'Workspaces').replaceAll('Project', 'Workspace');
  return replaced === name ? `Workspace${name}` : replaced;
}

function workspaceHumanText(value: string): string {
  return value
    .replaceAll('Projects', 'Workspaces')
    .replaceAll('projects', 'workspaces')
    .replaceAll('Project', 'Workspace')
    .replaceAll('project', 'workspace');
}

function collectSchemaReferences(
  value: unknown,
  schemas: Record<string, unknown>,
  names: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const child of value) collectSchemaReferences(child, schemas, names);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  const ref = record.$ref;
  const prefix = '#/components/schemas/';
  if (typeof ref === 'string' && ref.startsWith(prefix)) {
    const name = ref.slice(prefix.length);
    if (!names.has(name)) {
      names.add(name);
      collectSchemaReferences(schemas[name], schemas, names);
    }
  }
  for (const child of Object.values(record)) collectSchemaReferences(child, schemas, names);
}

function toWorkspaceSpecValue(
  value: unknown,
  schemaNames: ReadonlyMap<string, string>,
  parentKey?: string,
  parent?: Record<string, unknown>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => toWorkspaceSpecValue(child, schemaNames, parentKey, parent));
  }
  if (typeof value === 'string') {
    if (parentKey === '$ref') {
      const prefix = '#/components/schemas/';
      if (value.startsWith(prefix)) {
        const name = value.slice(prefix.length);
        return `${prefix}${schemaNames.get(name) ?? name}`;
      }
      return value;
    }
    if (parentKey === 'required') return WORKSPACE_FIELD_NAMES[value] ?? value;
    if (parentKey === 'tags' && value === 'projects') return 'workspaces';
    if (parentKey === 'name' && parent?.in === 'path' && value === 'projectId') {
      return 'workspaceId';
    }
    if (parentKey === 'summary' || parentKey === 'description' || parentKey === 'title') {
      return workspaceHumanText(value);
    }
    if (parentKey === 'dashboard_url') return value.replace('/projects/', '/workspaces/');
    return value;
  }
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    const workspaceKey = WORKSPACE_FIELD_NAMES[key] ?? key;
    if (workspaceKey !== key && Object.hasOwn(source, workspaceKey)) continue;
    target[workspaceKey] = toWorkspaceSpecValue(child, schemaNames, workspaceKey, source);
  }
  return target;
}

/**
 * Publish the canonical Workspace namespace without removing the Project API.
 *
 * Runtime mounts the same handlers at both prefixes. The OpenAPI registry does
 * not duplicate a sub-router's definitions when that sub-router is mounted a
 * second time, so the served document needs the same compatibility projection
 * as the runtime response middleware. Project paths and schemas remain intact
 * for existing integrations; Workspace paths use canonical parameter and JSON
 * field names.
 */
export function addWorkspaceCompatibilityPaths<
  T extends {
    paths?: Record<string, any>;
    components?: { schemas?: Record<string, unknown>; [key: string]: unknown };
  },
>(doc: T): T {
  if (!doc.paths) return doc;

  const schemas = doc.components?.schemas ?? {};
  const referencedSchemas = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    if (path === PROJECT_SPEC_PREFIX || path.startsWith(`${PROJECT_SPEC_PREFIX}/`)) {
      collectSchemaReferences(item, schemas, referencedSchemas);
    }
  }

  const schemaNames = new Map<string, string>();
  const reservedNames = new Set(Object.keys(schemas));
  for (const name of referencedSchemas) {
    let candidate = workspaceSchemaName(name);
    if (reservedNames.has(candidate) || [...schemaNames.values()].includes(candidate)) {
      candidate = `WorkspaceCompatibility${name}`;
    }
    schemaNames.set(name, candidate);
    reservedNames.add(candidate);
  }

  const workspacePaths: Record<string, any> = {};
  for (const [path, item] of Object.entries(doc.paths)) {
    if (path !== PROJECT_SPEC_PREFIX && !path.startsWith(`${PROJECT_SPEC_PREFIX}/`)) continue;
    const workspacePath = path
      .replace(PROJECT_SPEC_PREFIX, WORKSPACE_SPEC_PREFIX)
      .replaceAll('{projectId}', '{workspaceId}');
    if (Object.hasOwn(doc.paths, workspacePath)) continue;
    workspacePaths[workspacePath] = toWorkspaceSpecValue(item, schemaNames) as any;
  }
  // JSON object order is presentation order in Scalar. Put the canonical
  // namespace first, while retaining every legacy Project path unchanged.
  const paths = { ...workspacePaths, ...doc.paths };

  if (!doc.components?.schemas || referencedSchemas.size === 0) {
    return { ...doc, paths };
  }

  const workspaceSchemas: Record<string, unknown> = {};
  for (const name of referencedSchemas) {
    const workspaceName = schemaNames.get(name);
    if (!workspaceName || schemas[name] === undefined) continue;
    workspaceSchemas[workspaceName] = toWorkspaceSpecValue(schemas[name], schemaNames);
  }

  return {
    ...doc,
    paths,
    components: {
      ...doc.components,
      schemas: { ...schemas, ...workspaceSchemas },
    },
  };
}

/** Register security + serve the spec (/v1/openapi.json) and Scalar UI (/v1/docs). */
export function mountOpenApiDocs(app: OpenAPIHono<any, any, any>, version: string): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description:
      'Supabase user JWT, or a Kortix token: PAT (`kortix_pat_…`), API key (`kortix_…`), service account (`kortix_sa_…`), or (LLM Gateway inference routes only) a project gateway key (`kortix_gw_…`).',
  });

  // Serve the same document `doc31` would (getOpenAPI31Document is exactly what
  // doc31 delegates to) but with the internal-router paths stripped, so the
  // public spec never advertises admin/ops endpoints.
  app.get('/v1/openapi.json', (c) => {
    const document = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: {
        title: 'Kortix API',
        version,
        description:
          'The Kortix platform REST API — typed schemas via @hono/zod-openapi. ' +
          'For application code, prefer the TypeScript SDK (`@kortix/sdk`), which wraps ' +
          'this API and OpenCode REST sessions behind ' +
          'one session-scoped client — ' +
          'docs at https://kortix.com/docs/sdk.',
      },
      servers: [{ url: new URL(c.req.url).origin }],
    });
    return c.json(addWorkspaceCompatibilityPaths(filterSpecPaths(document)));
  });

  app.get('/v1/docs', Scalar({ url: '/v1/openapi.json', pageTitle: 'Kortix API' }));
}
