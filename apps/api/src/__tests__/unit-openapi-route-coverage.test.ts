/**
 * The published spec is the route table. Every concrete route the app serves
 * (each `app.routes` handler, `.all()` passthroughs included, `use()`
 * middleware excluded) is in the OpenAPI document, or matches one entry below
 * with the reason it is not REST. Admin and ops routes count as documented:
 * they are registered, and `/v1/openapi.json` filters them on purpose.
 */
import { describe, expect, test } from 'bun:test';
import { app } from '../index';

const EXCLUDED: Array<{ route: RegExp; reason: string }> = [
  { route: /^ALL \/v1\/(llm|llm-gateway)\/\*$/, reason: 'LLM gateway bridge; its ingress routes are documented with registerPath' },
  { route: /^ALL \/v1\/router\/[a-z0-9]+(\/\*)?$/, reason: 'third-party provider API passthrough' },
  { route: /^(ALL|GET|OPTIONS) \/v1\/p\//, reason: 'sandbox preview and public-share proxy: bytes of a sandbox port' },
  { route: /^POST \/internal\/gateway\//, reason: 'internal RPC between the LLM gateway and the API' },
  { route: /^GET \/\.well-known\//, reason: 'OAuth/OIDC discovery documents (RFC 8414, RFC 9728)' },
  { route: /^GET (\/v1)?\/health\/(live|ready)$|^GET \/metrics$/, reason: 'orchestrator probes and Prometheus scrape' },
  { route: /^GET \/v1\/(openapi\.json|docs)$/, reason: 'the spec and its reader' },
  { route: /^HEAD \/v1\/runtime-assets\//, reason: 'HEAD twin of a documented GET' },
  { route: /^GET \/v1\/(connectors\/oauth2|webhooks\/teams\/oauth)\/callback$/, reason: 'OAuth browser redirect, not called by a client' },
  { route: /^POST \/v1\/webhooks\/teams\//, reason: 'Microsoft Bot Framework activity webhook' },
  { route: /^(GET|POST|DELETE) \/v1\/mcp$/, reason: 'MCP streamable-HTTP endpoint, described by the MCP protocol' },
];

type Doc = { paths: Record<string, Record<string, { requestBody?: unknown }>> };

const served = await (await app.request('http://localhost/v1/openapi.json')).json() as Doc;
const registered = (app as unknown as { getOpenAPI31Document(c: object): Doc }).getOpenAPI31Document({
  openapi: '3.1.0',
  info: { title: 'Kortix API', version: 'test' },
});

const documented = new Set<string>();
for (const doc of [served, registered])
  for (const [path, item] of Object.entries(doc.paths))
    for (const method of Object.keys(item))
      documented.add(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`);

const routes = new Set<string>();
for (const r of (app as unknown as { routes: Array<{ method: string; path: string; handler: Function }> }).routes) {
  // `use()` middleware is listed as `ALL` with `(c, next)`; an `.all()` handler takes `(c)`.
  if (r.method === 'ALL' && r.handler.length >= 2) continue;
  routes.add(`${r.method} ${r.path}`);
}

/** Every string `enum` member anywhere in the document. */
function enumMembers(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const v of node) enumMembers(v, out);
  else if (node && typeof node === 'object')
    for (const [key, value] of Object.entries(node))
      if (key === 'enum' && Array.isArray(value)) out.push(...value.filter((v): v is string => typeof v === 'string'));
      else enumMembers(value, out);
  return out;
}

describe('OpenAPI route coverage', () => {
  test('every served route is documented or excluded with a reason', () => {
    const undocumented = [...routes].filter((r) => !documented.has(r) && !EXCLUDED.some((e) => e.route.test(r)));
    expect(undocumented.sort()).toEqual([]);
  });

  test('every exclusion still matches a served route', () => {
    const unused = EXCLUDED.filter((e) => ![...routes].some((r) => !documented.has(r) && e.route.test(r)));
    expect(unused.map((e) => e.reason)).toEqual([]);
  });

  test('no enum member is a comma-joined list', () => {
    expect(enumMembers(served).filter((member) => member.includes(','))).toEqual([]);
  });
});
