/**
 * The public OpenAPI spec (/v1/openapi.json) must NOT advertise internal
 * routers. admin/ops are runtime-gated but their typed route DEFINITIONS still
 * merge into the shared registry via app.route() — so without filtering, the
 * spec published admin credit-debit / tier-change / ops shapes to anyone.
 * These tests pin both the pure filter and the end-to-end served document.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { describe, expect, test } from 'bun:test';
import {
  INTERNAL_SPEC_PREFIXES,
  filterSpecPaths,
  makeOpenApiApp,
  mountOpenApiDocs,
} from '../openapi';

describe('filterSpecPaths', () => {
  test('drops internal prefixes and everything beneath them', () => {
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/v1/admin': {},
        '/v1/admin/api/accounts/{id}/credits/debit': {},
        '/v1/ops/overview': {},
        '/v1/projects/{id}': {},
        '/scim/v2/accounts/{accountId}/Users': {},
      },
    };
    const out = filterSpecPaths(doc);
    expect(Object.keys(out.paths).sort()).toEqual([
      '/scim/v2/accounts/{accountId}/Users', // SCIM stays public (RFC-7644)
      '/v1/projects/{id}',
    ]);
  });

  test('respects the prefix boundary — a sibling like /v1/administrators is kept', () => {
    const out = filterSpecPaths({ paths: { '/v1/administrators': {}, '/v1/admin/x': {} } });
    expect(Object.keys(out.paths)).toEqual(['/v1/administrators']);
  });

  test('is a no-op when there are no paths, and never mutates the input', () => {
    // Typed with the optional `paths` so it satisfies the helper's constraint
    // (a real OpenAPI doc has many more fields); asserts the no-paths early return.
    const noPaths: { openapi: string; paths?: Record<string, unknown> } = { openapi: '3.1.0' };
    expect(filterSpecPaths(noPaths)).toEqual({ openapi: '3.1.0' });
    const input = { paths: { '/v1/admin': {}, '/v1/projects': {} } };
    filterSpecPaths(input);
    expect(Object.keys(input.paths)).toContain('/v1/admin'); // input untouched
  });

  test('the internal prefix list covers admin + ops (and NOT scim)', () => {
    expect([...INTERNAL_SPEC_PREFIXES]).toEqual(['/v1/admin', '/v1/ops']);
  });
});

describe('mountOpenApiDocs — served spec excludes internal routers', () => {
  test('/v1/openapi.json omits an /v1/admin route but keeps a public route', async () => {
    const app = makeOpenApiApp();

    const publicRoute = createRoute({
      method: 'get',
      path: '/v1/projects/{id}',
      responses: { 200: { description: 'ok' } },
    });
    app.openapi(publicRoute, (c: any) => c.json({}));

    const admin = makeOpenApiApp();
    const adminRoute = createRoute({
      method: 'post',
      path: '/api/accounts/{id}/credits/debit',
      responses: { 200: { description: 'ok' } },
    });
    admin.openapi(adminRoute, (c: any) => c.json({}));
    app.route('/v1/admin', admin);

    mountOpenApiDocs(app, 'test');

    const res = await app.request('/v1/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths);
    expect(paths).toContain('/v1/projects/{id}');
    expect(paths.some((p) => p.startsWith('/v1/admin'))).toBe(false);
  });
});
