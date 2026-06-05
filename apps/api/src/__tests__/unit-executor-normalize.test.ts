/**
 * Normalizer tests — spec/doc/tool-list → NormalizedAction[] with risk derived
 * from source semantics. Pure transforms; no network.
 */
import { describe, expect, test } from 'bun:test';
import {
  normalize,
  normalizeGraphql,
  normalizeHttp,
  normalizeMcp,
  normalizeOpenApi,
  namespacePath,
  riskForMethod,
} from '../executor/normalize';

describe('riskForMethod', () => {
  test('GET/HEAD read, DELETE destructive, others write', () => {
    expect(riskForMethod('get')).toBe('read');
    expect(riskForMethod('HEAD')).toBe('read');
    expect(riskForMethod('delete')).toBe('destructive');
    expect(riskForMethod('post')).toBe('write');
    expect(riskForMethod('PUT')).toBe('write');
    expect(riskForMethod('patch')).toBe('write');
  });
});

describe('normalizeOpenApi', () => {
  const doc = {
    openapi: '3.0.0',
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          summary: 'List pets',
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
          responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/PetList' } } } } },
        },
        post: {
          operationId: 'createPet',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
          responses: { '201': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
        },
      },
      '/pets/{petId}': {
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        get: { operationId: 'getPet', responses: { '200': {} } },
        delete: { operationId: 'deletePet', responses: { '204': {} } },
      },
    },
    components: {
      schemas: {
        Pet: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['name'] },
        PetList: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
      },
    },
  };

  const actions = normalizeOpenApi(doc);
  const byPath = Object.fromEntries(actions.map((a) => [a.path, a]));

  test('one action per operation, risk by method', () => {
    expect(actions).toHaveLength(4);
    expect(byPath.listpets!.risk).toBe('read');
    expect(byPath.createpet!.risk).toBe('write');
    expect(byPath.getpet!.risk).toBe('read');
    expect(byPath.deletepet!.risk).toBe('destructive');
  });

  test('binding carries method/path/server', () => {
    expect(byPath.createpet!.binding).toEqual({ kind: 'openapi', method: 'POST', path: '/pets', server: 'https://api.example.com/v1' });
    expect(byPath.deletepet!.binding).toMatchObject({ method: 'DELETE', path: '/pets/{petId}' });
  });

  test('input merges params + body, $ref resolved inline', () => {
    const create = byPath.createpet!;
    expect((create.inputSchema as any).properties.body).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['name'],
    });
    // path-level param inherited onto operations
    expect((byPath.getpet!.inputSchema as any).properties.petId).toMatchObject({ type: 'string', 'x-in': 'path' });
  });

  test('output $ref (array of $ref) resolved', () => {
    const out = byPath.listpets!.outputSchema as any;
    expect(out.type).toBe('array');
    expect(out.items).toEqual({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['name'] });
  });

  test('handles missing operationId by deriving from method+path', () => {
    const a = normalizeOpenApi({ paths: { '/health': { get: { responses: {} } } } });
    expect(a).toHaveLength(1);
    expect(a[0]!.path).toContain('health');
    expect(a[0]!.risk).toBe('read');
  });

  test('empty / malformed doc → []', () => {
    expect(normalizeOpenApi(null)).toEqual([]);
    expect(normalizeOpenApi({})).toEqual([]);
  });
});

describe('normalizeGraphql', () => {
  const introspection = {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      types: [
        {
          name: 'Query',
          fields: [
            { name: 'user', description: 'Get a user', args: [{ name: 'id', type: { kind: 'NON_NULL', ofType: { name: 'ID' } } }], type: { name: 'User' } },
          ],
        },
        {
          name: 'Mutation',
          fields: [
            { name: 'createUser', args: [{ name: 'input', type: { kind: 'NON_NULL', ofType: { name: 'UserInput' } } }], type: { name: 'User' } },
          ],
        },
      ],
    },
  };

  test('query = read, mutation = write; args → input', () => {
    const actions = normalizeGraphql(introspection);
    const byPath = Object.fromEntries(actions.map((a) => [a.path, a]));
    expect(byPath['query.user']!.risk).toBe('read');
    expect(byPath['mutation.createuser']!.risk).toBe('write');
    expect((byPath['query.user']!.inputSchema as any).required).toEqual(['id']);
    expect(byPath['query.user']!.binding).toEqual({ kind: 'graphql', operation: 'query', field: 'user' });
  });

  test('accepts bare __schema and {data:{__schema}}', () => {
    expect(normalizeGraphql(introspection.__schema)).toHaveLength(2);
    expect(normalizeGraphql({ data: introspection })).toHaveLength(2);
    expect(normalizeGraphql(null)).toEqual([]);
  });
});

describe('normalizeMcp', () => {
  test('honors readOnlyHint / destructiveHint, default write', () => {
    const actions = normalizeMcp([
      { name: 'search', annotations: { readOnlyHint: true } },
      { name: 'delete_page', annotations: { destructiveHint: true } },
      { name: 'create_page' },
    ]);
    const byPath = Object.fromEntries(actions.map((a) => [a.path, a]));
    expect(byPath.search!.risk).toBe('read');
    expect(byPath.delete_page!.risk).toBe('destructive');
    expect(byPath.create_page!.risk).toBe('write');
    expect(byPath.search!.binding).toEqual({ kind: 'mcp', tool: 'search' });
  });
});

describe('normalizeHttp', () => {
  test('derives risk from method, honors explicit risk override', () => {
    const actions = normalizeHttp([
      { name: 'list users', method: 'get', path: '/users' },
      { name: 'purge', method: 'post', path: '/purge', risk: 'destructive' },
    ]);
    const byPath = Object.fromEntries(actions.map((a) => [a.path, a]));
    expect(byPath.list_users!.risk).toBe('read');
    expect(byPath.list_users!.binding).toEqual({ kind: 'http', method: 'GET', path: '/users' });
    expect(byPath.purge!.risk).toBe('destructive');
  });
});

describe('dispatch + namespacing', () => {
  test('normalize() routes by provider', () => {
    expect(normalize({ provider: 'openapi', doc: { paths: { '/x': { get: { responses: {} } } } } })).toHaveLength(1);
    const pd = normalize({ provider: 'pipedream', app: 'gmail', actions: [{ key: 'gmail-send-email', name: 'Send Email' }] });
    expect(pd[0]!.binding).toEqual({ kind: 'pipedream', app: 'gmail', actionKey: 'gmail-send-email' });
    expect(pd[0]!.path).toBe('send_email');
  });

  test('the account-selector prop (type "app", named after the slug) is stripped from the schema', () => {
    // Pipedream returns the connection prop named after the app slug, not "app".
    const pd = normalize({
      provider: 'pipedream',
      app: 'gmail',
      actions: [{
        key: 'gmail-find-email',
        name: 'Find Email',
        params: [
          { name: 'gmail', type: 'app', required: true },          // the account selector — must NOT surface
          { name: 'q', type: 'string', required: false },
          { name: 'withTextPayload', type: 'boolean', required: true },
        ],
      }],
    });
    const find = pd.find((a) => a.path === 'find_email')!;
    const props = (find.inputSchema as any).properties;
    expect(props.gmail).toBeUndefined();                          // selector gone
    expect(props.q).toBeDefined();
    expect(props.withTextPayload).toBeDefined();
    expect((find.inputSchema as any).required).toEqual(['withTextPayload']); // gmail not required either
  });

  test('every pipedream connector gets a generic `request` (Connect Proxy) tool', () => {
    const pd = normalize({ provider: 'pipedream', app: 'github', actions: [{ key: 'github-create-issue', name: 'Create Issue' }] });
    const request = pd.find((a) => a.path === 'request');
    expect(request).toBeDefined();
    expect(request!.binding).toEqual({ kind: 'pipedream_proxy', app: 'github' });
    expect(request!.inputSchema).toMatchObject({ required: ['method', 'url'] });
    // present even when the app exposes no curated actions at all
    const empty = normalize({ provider: 'pipedream', app: 'github', actions: [] });
    expect(empty.some((a) => a.path === 'request')).toBe(true);
  });

  test('namespacePath prefixes the connector slug', () => {
    expect(namespacePath('stripe', 'charges.create')).toBe('stripe.charges.create');
  });

  test('duplicate relative paths get de-duped', () => {
    const actions = normalizeMcp([{ name: 'do-thing' }, { name: 'do_thing' }]);
    expect(new Set(actions.map((a) => a.path)).size).toBe(2);
  });
});
