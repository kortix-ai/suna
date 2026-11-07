/**
 * Shared OpenAPI wiring for the Kortix API.
 *
 * Every sub-router is an `OpenAPIHono` created via `makeOpenApiApp()` so it (a)
 * contributes typed route definitions to the spec and (b) shares one validation
 * error contract. Routes are defined with `createRoute()` + zod; the spec is
 * served at /v1/openapi.json and rendered by Scalar at /v1/docs.
 */
import { WORKSPACE_LEGACY_REPLACEMENTS, workspaceAliasOf } from '@kortix/shared/workspace-routes';
import { OpenAPIHono, z, type RouteConfig } from '@hono/zod-openapi';
import { ErrorEnvelopeSchema } from '@kortix/api-contract';
import type { Env } from 'hono';
import { Scalar } from '@scalar/hono-api-reference';
import { PUBLIC_OPERATIONS } from '../shared/openapi-public-operations';
import { computeEtag, etagMatches } from '../shared/http-cache';

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
 * An optional text query parameter, documented. A repeated key reads as its
 * first value, as `c.req.query()` reads it. The handler validates the value.
 */
export const queryText = (description: string) =>
  z.preprocess((value) => (Array.isArray(value) ? value[0] : value), z.string().optional()).openapi({ description });

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

/**
 * Request body that DOCUMENTS its fields in the spec but does not validate them.
 * For routes whose handler owns validation (its own 400 messages, aliases,
 * coercions): the spec lists `shape` (what LLMs and SDK readers see) and runtime
 * still accepts any JSON object with every key kept, exactly as the plain
 * `z.record(z.string(), z.any())` body did. Non-object bodies are still rejected.
 */
export const lenientBody = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).passthrough().or(z.record(z.string(), z.any()));

/** Mark an operation as requiring a bearer token. */
export const auth: Pick<RouteConfig, 'security'> = { security: [{ bearerAuth: [] }] };

/**
 * Single validation-error contract for every typed route. Zod failures (bad body,
 * params, query) become a consistent 400 envelope instead of per-route ad-hoc shapes.
 */
export function defaultHook(result: { success: boolean; error?: { issues: readonly unknown[] } }, c: any) {
  if (!result.success) {
    return c.json(
      { error: true, message: 'Validation failed', status: 400, ...boundedIssues(result.error?.issues) },
      400,
    );
  }
}

/** The most validation issues one response lists (KRTX-3419). */
export const RESPONSE_ISSUE_LIMIT = 20;
/** The most issues kept per union branch. */
const UNION_BRANCH_ISSUE_LIMIT = 3;
/** Serialized bytes of `issues` past which no further issue is added. */
const RESPONSE_ISSUE_BYTES = 16 * 1024;

/**
 * Zod nests a failing union branch's WHOLE issue list in one `invalid_union`
 * issue (zod 4: `errors`, one issue list per branch), so a union over an array
 * kept every element error in a single issue. Each branch becomes
 * `{ issues: <first 3>, issue_count }` under `union_errors`.
 */
function compactIssue(issue: unknown): unknown {
  if (!issue || typeof issue !== 'object') return issue;
  const record = issue as { code?: unknown; errors?: unknown };
  if (record.code !== 'invalid_union' || !Array.isArray(record.errors)) return issue;
  const { errors: branches, ...rest } = record;
  return {
    ...rest,
    union_errors: (branches as unknown[]).map((branch) =>
      boundedIssues(Array.isArray(branch) ? branch : [], UNION_BRANCH_ISSUE_LIMIT),
    ),
  };
}

/**
 * A response's `issues`: the first 20 (union branches compacted, about 16 KB at
 * most past the first issue), plus `issue_count` with the total. Zod reports one
 * issue per failing array element, so the whole list let a 1.5 MB request
 * answer 68 MB. `unit-bounded-issues-guard` keeps every response on it.
 */
export function boundedIssues<T>(
  issues: readonly T[] | undefined,
  limit = RESPONSE_ISSUE_LIMIT,
): { issues: T[]; issue_count: number } {
  const all = issues ?? [];
  const kept: T[] = [];
  let bytes = 0;
  for (const issue of all.slice(0, limit)) {
    const compact = compactIssue(issue) as T;
    bytes += JSON.stringify(compact)?.length ?? 0;
    if (kept.length > 0 && bytes > RESPONSE_ISSUE_BYTES) break;
    kept.push(compact);
  }
  return { issues: kept, issue_count: all.length };
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

/** Give every listed public operation `security: []`, the OpenAPI "no auth" marker. */
export function markPublicOperations<T extends { paths?: Record<string, unknown> }>(
  doc: T,
  publicOperations: ReadonlySet<string> = PUBLIC_OPERATIONS,
): T {
  if (!doc.paths) return doc;
  const paths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(doc.paths)) {
    const marked: Record<string, unknown> = {};
    for (const [method, operation] of Object.entries(item as Record<string, unknown>)) {
      const op = operation as Record<string, unknown>;
      marked[method] =
        !op.security && publicOperations.has(`${method} ${path}`) ? { ...op, security: [] } : operation;
    }
    paths[path] = marked;
  }
  return { ...doc, paths };
}

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

const OPENAPI_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * Mark every legacy workspace name (`/v1/projects/{workspaceId}/…`,
 * `/v1/accounts/{workspaceId}/iam/…`, `/v1/accounts/me`, …) whose canonical
 * `/v1/workspaces/…` operation exists: `deprecated: true` and
 * `x-kortix-alias-of: "<METHOD> <canonical path>"`. The legacy names stay
 * served permanently; the spec points readers and generators at one name.
 *
 * A legacy route with its own meaning (`WORKSPACE_LEGACY_REPLACEMENTS`:
 * `GET /v1/projects`, `/v1/accounts`, `/v1/accounts/tokens`, …) is no alias:
 * it gets `deprecated: true` and `x-kortix-replaced-by: "<METHOD> <canonical
 * path>"`, the route a client calls instead.
 * Pure + exported for unit tests. Returns a shallow-cloned doc.
 */
export function markWorkspaceAliases<T extends { paths?: object }>(doc: T): T {
  if (!doc.paths) return doc;
  const all = doc.paths as Record<string, Record<string, unknown>>;
  const has = (method: string, routing: string) => Boolean(all[routingToOpenApiPath(routing)]?.[method.toLowerCase()]);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, item] of Object.entries(all)) {
    const routing = openApiToRoutingPath(path);
    const marked: Record<string, unknown> = { ...item };
    let changed = false;
    for (const method of OPENAPI_METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op) continue;
      const canonicalRouting = workspaceAliasOf(method, routing, has);
      const replacement = WORKSPACE_LEGACY_REPLACEMENTS[`${method.toUpperCase()} ${routing}`];
      if (!canonicalRouting && replacement) {
        const [rMethod, rRouting] = replacement.split(' ') as [string, string];
        const replacedBy = `${rMethod} ${routingToOpenApiPath(rRouting)}`;
        changed = true;
        marked[method] = {
          ...op,
          deprecated: true,
          'x-kortix-replaced-by': replacedBy,
          description: `Legacy route with its own meaning, served permanently. Use \`${replacedBy}\`.${
            typeof op.description === 'string' && op.description ? `\n\n${op.description}` : ''
          }`,
        };
        continue;
      }
      if (!canonicalRouting) continue;
      const canonical = routingToOpenApiPath(canonicalRouting);
      changed = true;
      marked[method] = {
        ...op,
        deprecated: true,
        'x-kortix-alias-of': `${method.toUpperCase()} ${canonical}`,
        description: `Legacy name of \`${method.toUpperCase()} ${canonical}\`, served permanently.${
          typeof op.description === 'string' && op.description ? `\n\n${op.description}` : ''
        }`,
      };
    }
    paths[path] = changed ? marked : item;
  }
  return { ...doc, paths };
}

/** `{name}` → `:name`, whole segments only. */
export function openApiToRoutingPath(path: string): string {
  return path.replace(/(^|\/)\{([^}]+)\}/g, '$1:$2');
}

/** `:name` → `{name}`, whole segments only: `/policies:bulk-delete` is a custom verb, not a param. */
export function routingToOpenApiPath(path: string): string {
  return path.replace(/(^|\/):([A-Za-z0-9_]+)/g, '$1{$2}');
}

/** Canonical workspace prefixes: the only paths that publish `{workspaceId}`. */
const CANONICAL_WORKSPACE_PATH = /^\/(v1\/workspaces|v1\/me|v1\/invites|v1\/connectors\/workspaces|v1\/webhooks\/workspaces|scim\/v2\/workspaces)(\/|$)/;

/** The id name a legacy path published before Workspaces: account paths say `accountId`, every other `projectId`. */
function legacyIdName(path: string): string {
  return /^\/(v1|scim\/v2)\/accounts\//.test(path) ? 'accountId' : 'projectId';
}

function renamePathParams(params: unknown, to: string): unknown {
  if (!Array.isArray(params)) return params;
  return params.map((param) =>
    param && typeof param === 'object' && (param as { in?: string }).in === 'path' && (param as { name?: string }).name === 'workspaceId'
      ? { ...param, name: to }
      : param,
  );
}

/**
 * Publish every legacy path with the parameter names it had before
 * Workspaces: `/v1/projects/{projectId}/…`, `/v1/connectors/projects/{projectId}/…`,
 * `/v1/webhooks/…/{projectId}`, `/v1/accounts/{accountId}/…`,
 * `/scim/v2/accounts/{accountId}/…`. The route templates name the id
 * `:workspaceId` everywhere, but a client generated from the older spec names
 * its arguments after the published names, so they stay. Canonical paths keep
 * `{workspaceId}`. Run after markWorkspaceAliases, which maps legacy keys to
 * canonical ones by the template name. Pure + exported for unit tests.
 */
export function restoreLegacyParamNames<T extends { paths?: object }>(doc: T): T {
  if (!doc.paths) return doc;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
    if (CANONICAL_WORKSPACE_PATH.test(path) || !path.includes('{workspaceId}')) {
      paths[path] = item;
      continue;
    }
    const to = legacyIdName(path);
    const renamed: Record<string, unknown> = { ...item };
    if ('parameters' in item) renamed.parameters = renamePathParams(item.parameters, to);
    for (const method of OPENAPI_METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (op) renamed[method] = { ...op, parameters: renamePathParams(op.parameters, to) };
      if (op && op.parameters === undefined) delete (renamed[method] as Record<string, unknown>).parameters;
    }
    paths[path.replaceAll('{workspaceId}', `{${to}}`)] = renamed;
  }
  return { ...doc, paths };
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
  //
  // Built once, lazily, then cached: the document is ~1 MB of JSON and every
  // `/v1/docs` page load, SDK codegen and MCP client fetch asked for a fresh
  // copy (973 KB, no ETag, no Cache-Control — pentest 2026-10-22). It cannot
  // change at runtime: routes are registered before the first request, and the
  // registry is frozen at that point. Revalidation is answered with a 304.
  let cachedSpec: { body: string; etag: string } | undefined;
  app.get('/v1/openapi.json', (c) => {
    if (!cachedSpec) {
      const body = JSON.stringify(
        markPublicOperations(restoreLegacyParamNames(markWorkspaceAliases(filterSpecPaths(buildSpec(version))))),
      );
      cachedSpec = { body, etag: computeEtag(body) };
    }
    c.header('ETag', cachedSpec.etag);
    c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    if (etagMatches(c.req.header('if-none-match'), cachedSpec.etag)) {
      return c.body(null, 304);
    }
    return c.body(cachedSpec.body, 200, { 'Content-Type': 'application/json' });
  });

  function buildSpec(specVersion: string) {
    return app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: {
        title: 'Kortix API',
        version: specVersion,
        description:
          'The Kortix platform REST API — typed schemas via @hono/zod-openapi. ' +
          'For application code, prefer the TypeScript SDK (`@kortix/sdk`), which wraps ' +
          'this API and the session runtime behind ' +
          'one session-scoped client — ' +
          'docs at https://kortix.com/docs/sdk.',
      },
      // Relative: it resolves against the URL the client fetched this document
      // from. The request origin the API sees behind the edge router is an
      // internal host, which the spec must not publish (KRTX-2949).
      servers: [{ url: '/' }],
      tags: [
        {
          name: 'workspaces',
          description:
            'The canonical workspace API. A workspace is one company’s Kortix: its members, roles, billing, secrets, agents and sessions. Its id is `workspace_id` (equal to `project_id`). Canonical paths take the workspace id only; an account id, an unknown id or a workspace you cannot read answers 404 `workspace_not_found`. The legacy `/v1/projects` and `/v1/accounts/{accountId}` names stay served permanently and accept either id.',
        },
      ],
    });
  }

  app.get('/v1/docs', Scalar({ url: '/v1/openapi.json', pageTitle: 'Kortix API' }));
}
