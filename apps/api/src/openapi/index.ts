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

/**
 * A response's `issues`: the first 20, plus `issue_count` with the total. Zod
 * reports one issue per failing array element, so the whole list let a 1.5 MB
 * request answer 68 MB. `unit-bounded-issues-guard` keeps every response on it.
 */
export function boundedIssues<T>(issues: readonly T[] | undefined): { issues: T[]; issue_count: number } {
  const all = issues ?? [];
  return { issues: all.slice(0, RESPONSE_ISSUE_LIMIT), issue_count: all.length };
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
      const body = JSON.stringify(filterSpecPaths(buildSpec(version)));
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
          'this API and OpenCode REST sessions behind ' +
          'one session-scoped client — ' +
          'docs at https://kortix.com/docs/sdk.',
      },
      // Relative: it resolves against the URL the client fetched this document
      // from. The request origin the API sees behind the edge router is an
      // internal host, which the spec must not publish (KRTX-2949).
      servers: [{ url: '/' }],
    });
  }

  app.get('/v1/docs', Scalar({ url: '/v1/openapi.json', pageTitle: 'Kortix API' }));
}
