/**
 * Normalizers: turn each provider source into a uniform NormalizedAction[].
 *
 * Pure transforms over an already-fetched spec/doc/tool-list — no network, no
 * deps — so they're fully unit-testable. Fetching (URL → doc, MCP listTools)
 * lives in the sync layer; these just normalize. Risk is derived from the
 * source's own semantics, the executor.sh insight (see executor-reference.md §4).
 */
import type {
  ActionBinding,
  HttpRouteSpec,
  McpToolLike,
  NormalizedAction,
  PipedreamActionLike,
  Risk,
} from './types';

/* ─── shared helpers ─────────────────────────────────────────────────────── */

/** HTTP method → risk. GET/HEAD/OPTIONS read; DELETE destructive; rest write. */
function riskForMethod(method: string): Risk {
  const m = method.toLowerCase();
  if (m === 'get' || m === 'head' || m === 'options') return 'read';
  if (m === 'delete') return 'destructive';
  return 'write';
}

/** Turn an arbitrary string into a safe dotted path segment. */
function seg(s: string): string {
  return s
    .replace(/\{([^}]+)\}/g, '$1') // {id} → id
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

function dedupePaths(actions: NormalizedAction[]): NormalizedAction[] {
  const seen = new Map<string, number>();
  for (const a of actions) {
    const n = seen.get(a.path) ?? 0;
    if (n > 0) a.path = `${a.path}_${n + 1}`;
    seen.set(a.path, n + 1);
  }
  return actions;
}

/* ─── OpenAPI ────────────────────────────────────────────────────────────── */

const OPENAPI_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

/**
 * Normalize an OpenAPI 3 document (already parsed from JSON/YAML). Resolves
 * local `#/components/...` $refs (cycle-guarded). Each operation → one action.
 */
export function normalizeOpenApi(doc: any): NormalizedAction[] {
  if (!doc || typeof doc !== 'object' || !doc.paths) return [];
  const server = firstServerUrl(doc);
  const actions: NormalizedAction[] = [];

  for (const [pathTemplate, pathItem] of Object.entries(doc.paths as Record<string, any>)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathLevelParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of OPENAPI_METHODS) {
      const op = (pathItem as any)[method];
      if (!op || typeof op !== 'object') continue;

      const relPath = op.operationId
        ? seg(String(op.operationId))
        : [seg(pathTemplate) || 'root', method].filter(Boolean).join('.');

      const params = [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => deref(doc, p))
        .filter((p) => p && typeof p === 'object');

      const inputSchema = buildOpenApiInput(doc, params, op.requestBody);
      const outputSchema = buildOpenApiOutput(doc, op.responses);

      const binding: ActionBinding = { kind: 'openapi', method: method.toUpperCase(), path: pathTemplate, server };
      actions.push({
        path: relPath || `${method}`,
        name: op.summary ? String(op.summary) : relPath,
        description: String(op.summary || op.description || `${method.toUpperCase()} ${pathTemplate}`),
        inputSchema,
        outputSchema,
        risk: riskForMethod(method),
        binding,
      });
    }
  }
  return dedupePaths(actions);
}

function firstServerUrl(doc: any): string | null {
  if (Array.isArray(doc.servers) && doc.servers[0]?.url) return String(doc.servers[0].url);
  return null;
}

function buildOpenApiInput(doc: any, params: any[], requestBody: any): Record<string, unknown> | null {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of params) {
    if (!p?.name) continue;
    properties[p.name] = {
      ...(deref(doc, p.schema) ?? { type: 'string' }),
      ...(p.description ? { description: String(p.description) } : {}),
      'x-in': p.in,
    };
    if (p.required) required.push(p.name);
  }

  const body = deref(doc, requestBody);
  if (body?.content) {
    const json = body.content['application/json'] ?? Object.values(body.content)[0];
    const bodySchema = deref(doc, (json as any)?.schema);
    if (bodySchema) {
      properties.body = bodySchema;
      if (body.required) required.push('body');
    }
  }

  if (Object.keys(properties).length === 0) return null;
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function buildOpenApiOutput(doc: any, responses: any): Record<string, unknown> | null {
  if (!responses || typeof responses !== 'object') return null;
  const ok = responses['200'] ?? responses['201'] ?? responses['2XX'] ?? responses.default;
  const resolved = deref(doc, ok);
  const content = resolved?.content;
  if (!content) return null;
  const json = content['application/json'] ?? Object.values(content)[0];
  const schema = deref(doc, (json as any)?.schema);
  return schema ?? null;
}

/** Resolve `$ref` (only `#/...` local refs) recursively, cycle-guarded. */
function deref(doc: any, node: any, seen: Set<string> = new Set()): any {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) return {};
    seen.add(ref);
    const target = resolvePointer(doc, ref.slice(2).split('/'));
    return deref(doc, target, seen);
  }
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, new Set(seen)));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(doc, v, new Set(seen));
  return out;
}

function resolvePointer(doc: any, parts: string[]): any {
  let cur = doc;
  for (const raw of parts) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/* ─── GraphQL (introspection) ────────────────────────────────────────────── */

/**
 * Normalize a GraphQL introspection result (`{ __schema: {...} }` or the inner
 * `__schema`). Query fields → read, Mutation fields → write.
 */
export function normalizeGraphql(introspection: any): NormalizedAction[] {
  const schema = introspection?.__schema ?? introspection?.data?.__schema ?? introspection;
  if (!schema || !Array.isArray(schema.types)) return [];

  const byName = new Map<string, any>();
  for (const t of schema.types) if (t?.name) byName.set(t.name, t);

  const actions: NormalizedAction[] = [];
  const roots: Array<['query' | 'mutation', string | undefined]> = [
    ['query', schema.queryType?.name],
    ['mutation', schema.mutationType?.name],
  ];

  for (const [operation, typeName] of roots) {
    if (!typeName) continue;
    const type = byName.get(typeName);
    if (!type || !Array.isArray(type.fields)) continue;
    for (const field of type.fields) {
      if (!field?.name) continue;
      actions.push({
        path: `${operation}.${seg(field.name)}`,
        name: field.name,
        description: String(field.description || `${operation} ${field.name}`),
        inputSchema: graphqlArgsSchema(field.args),
        outputSchema: { type: 'object', 'x-graphql-type': typeRefName(field.type) },
        risk: operation === 'query' ? 'read' : 'write',
        binding: { kind: 'graphql', operation, field: field.name },
      });
    }
  }
  return dedupePaths(actions);
}

function graphqlArgsSchema(args: any[]): Record<string, unknown> | null {
  if (!Array.isArray(args) || args.length === 0) return null;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of args) {
    if (!a?.name) continue;
    const nonNull = a.type?.kind === 'NON_NULL';
    properties[a.name] = { type: 'string', 'x-graphql-type': typeRefName(a.type) };
    if (nonNull) required.push(a.name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function typeRefName(t: any): string {
  let cur = t;
  while (cur && cur.ofType) cur = cur.ofType;
  return cur?.name ?? 'Unknown';
}

/* ─── MCP ────────────────────────────────────────────────────────────────── */

/** Normalize an MCP `listTools` result. Honors readOnlyHint / destructiveHint. */
export function normalizeMcp(tools: McpToolLike[]): NormalizedAction[] {
  if (!Array.isArray(tools)) return [];
  const actions: NormalizedAction[] = tools
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => ({
      path: seg(t.name),
      name: t.name,
      description: String(t.description || t.name),
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? null,
      outputSchema: (t.outputSchema as Record<string, unknown>) ?? null,
      risk: riskForMcp(t),
      binding: { kind: 'mcp', tool: t.name } as ActionBinding,
    }));
  return dedupePaths(actions);
}

function riskForMcp(t: McpToolLike): Risk {
  if (t.annotations?.destructiveHint) return 'destructive';
  if (t.annotations?.readOnlyHint) return 'read';
  return 'write';
}

/* ─── HTTP (declared routes) ─────────────────────────────────────────────── */

/** Normalize declared HTTP routes (provider=http). */
export function normalizeHttp(routes: HttpRouteSpec[]): NormalizedAction[] {
  if (!Array.isArray(routes)) return [];
  const actions: NormalizedAction[] = routes
    .filter((r) => r && r.name && r.method && r.path)
    .map((r) => ({
      path: seg(r.name),
      name: r.name,
      description: String(r.description || `${r.method.toUpperCase()} ${r.path}`),
      inputSchema: r.inputSchema ?? null,
      outputSchema: r.outputSchema ?? null,
      risk: r.risk ?? riskForMethod(r.method),
      binding: { kind: 'http', method: r.method.toUpperCase(), path: r.path } as ActionBinding,
    }));
  return dedupePaths(actions);
}

/* ─── Pipedream ──────────────────────────────────────────────────────────── */

/** Normalize Pipedream Connect actions for an app into the catalog. */
export function normalizePipedream(actions: PipedreamActionLike[], app: string): NormalizedAction[] {
  if (!Array.isArray(actions)) return [];
  const out: NormalizedAction[] = actions
    .filter((a) => a && typeof a.key === 'string' && a.key)
    .map((a) => {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of a.params ?? []) {
        // Skip the account-selector prop. Pipedream names it after the app slug
        // (type "app"), not literally "app" — filter by type, not name, so it
        // never surfaces as a fillable arg. (The catalog fetch strips it too;
        // this is the second line of defence.)
        if (!p?.name || p.type === 'app') continue;
        properties[p.name] = { type: pdType(p.type), ...(p.description ? { description: p.description } : {}) };
        if (p.required) required.push(p.name);
      }
      return {
        // tool path = action key minus the app prefix (e.g. gmail-send-email → send_email)
        path: seg(a.key.startsWith(`${app}-`) ? a.key.slice(app.length + 1) : a.key),
        name: a.name,
        description: String(a.description || a.name),
        inputSchema: Object.keys(properties).length ? { type: 'object', properties, ...(required.length ? { required } : {}) } : null,
        outputSchema: null,
        // Pipedream actions mutate by default; treat as write (the policy layer can refine).
        risk: 'write' as Risk,
        binding: { kind: 'pipedream', app, actionKey: a.key } as ActionBinding,
      };
    });
  // Every Pipedream connector also gets a generic `request` tool that proxies
  // to ANY endpoint of the app's API (Connect Proxy). This is what makes a
  // Pipedream connector behave like an openapi/http one — the agent can reach
  // the complete API surface, not just the curated actions above. Listed last
  // so dedupePaths keeps a real action named `request` if one ever collides.
  out.push(pipedreamProxyAction(app));
  return dedupePaths(out);
}

/** The synthetic catch-all `request` action backing the Connect Proxy. */
function pipedreamProxyAction(app: string): NormalizedAction {
  return {
    path: 'request',
    name: `${app} API request`,
    description:
      `Make an authenticated request to ANY ${app} API endpoint via the Pipedream Connect ` +
      `proxy (the credential is injected server-side). Use this for anything the named ` +
      `actions don't cover. Provide the full target URL and HTTP method; include a JSON ` +
      `body for writes. Example: method="POST", url="https://api.github.com/repos/{owner}/{repo}/issues/{n}/comments", body={"body":"..."}.`,
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, or DELETE.' },
        url: { type: 'string', description: `Absolute target API URL for ${app} (e.g. https://api.github.com/...).` },
        body: { type: 'object', description: 'Optional JSON request body for POST/PUT/PATCH.' },
        headers: { type: 'object', description: 'Optional extra request headers (auth is added automatically).' },
      },
      required: ['method', 'url'],
    },
    outputSchema: null,
    // Catch-all can do anything up to and including deletes; treat as write so
    // it's gated under risk-mode policies. Pin tighter with a connector policy.
    risk: 'write' as Risk,
    binding: { kind: 'pipedream_proxy', app } as ActionBinding,
  };
}

function pdType(t: string): string {
  if (t.includes('integer') || t.includes('number')) return 'number';
  if (t.includes('boolean')) return 'boolean';
  if (t.includes('[]') || t.includes('array')) return 'array';
  if (t.includes('object')) return 'object';
  return 'string';
}

/* ─── dispatch ───────────────────────────────────────────────────────────── */

import type { ConnectorProvider } from '../projects/connectors';

/** Source material a connector needs normalized, by provider. */
type NormalizeInput =
  | { provider: 'openapi'; doc: any }
  | { provider: 'graphql'; introspection: any }
  | { provider: 'mcp'; tools: McpToolLike[] }
  | { provider: 'http'; routes: HttpRouteSpec[] }
  | { provider: 'pipedream'; actions: PipedreamActionLike[]; app: string };

export function normalize(input: NormalizeInput): NormalizedAction[] {
  switch (input.provider) {
    case 'openapi':
      return normalizeOpenApi(input.doc);
    case 'graphql':
      return normalizeGraphql(input.introspection);
    case 'mcp':
      return normalizeMcp(input.tools);
    case 'pipedream':
      return normalizePipedream(input.actions, input.app);
    case 'http':
      return normalizeHttp(input.routes);
    default:
      return [];
  }
}
