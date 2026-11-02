// Regression guard for the project-level trigger kill-switch route.
//
// `PATCH /projects/:projectId/triggers/activation` (pause/resume all of a
// project's triggers) is a STATIC route that lives in the same namespace as the
// per-trigger `PATCH /projects/:projectId/triggers/:slug` route. OpenAPIHono
// matches routes in registration order, so if the `:slug` route is registered
// first it captures `activation` as a slug — the activation handler is shadowed
// and the request 404s ("no trigger named 'activation'"). That silently breaks
// the entire pause feature: the CLI `kortix triggers pause/resume`, the web
// toggle, and the only way to stop a repo deployed to two control planes from
// double-firing its crons.
//
// This shipped broken once (the activation route was declared AFTER `:slug`),
// so these tests lock the invariant from two angles:
//   1. behavioural — prove the bug exists with `:slug`-first and is fixed with
//      `activation`-first, using a real OpenAPIHono router;
//   2. structural — assert the real triggers.ts registers `activation` BEFORE `:slug`.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

type Order = 'slug-first' | 'activation-first';

function buildRouter(order: Order): OpenAPIHono {
  const app = new OpenAPIHono();
  const slugRoute = createRoute({
    method: 'patch',
    path: '/{projectId}/triggers/{slug}',
    request: { params: z.object({ projectId: z.string(), slug: z.string() }) },
    responses: { 200: { description: 'ok' } },
  });
  const activationRoute = createRoute({
    method: 'patch',
    path: '/{projectId}/triggers/activation',
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: { description: 'ok' } },
  });
  const slugHandler = (c: any) => c.json({ handler: 'slug', slug: c.req.param('slug') });
  const activationHandler = (c: any) => c.json({ handler: 'activation' });
  // Registration order is the whole point of this test.
  if (order === 'slug-first') {
    app.openapi(slugRoute, slugHandler);
    app.openapi(activationRoute, activationHandler);
  } else {
    app.openapi(activationRoute, activationHandler);
    app.openapi(slugRoute, slugHandler);
  }
  return app;
}

async function patch(app: OpenAPIHono, path: string): Promise<{ handler: string; slug?: string }> {
  const res = await app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return (await res.json()) as { handler: string; slug?: string };
}

describe('trigger activation route ordering', () => {
  test('activation-first: /triggers/activation reaches the activation handler', async () => {
    const app = buildRouter('activation-first');
    expect(await patch(app, '/p1/triggers/activation')).toEqual({ handler: 'activation' });
  });

  test('activation-first: a real slug still reaches the per-trigger handler', async () => {
    const app = buildRouter('activation-first');
    expect(await patch(app, '/p1/triggers/error-sweep')).toEqual({ handler: 'slug', slug: 'error-sweep' });
  });

  test('slug-first reproduces the shadowing bug (activation captured as a slug)', async () => {
    // Documents WHY order matters — declaring `:slug` first shadows the static
    // route, which is the exact regression this file guards against.
    const app = buildRouter('slug-first');
    expect(await patch(app, '/p1/triggers/activation')).toEqual({ handler: 'slug', slug: 'activation' });
  });

  test('triggers.ts registers the static activation route BEFORE the :slug routes', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'projects', 'routes', 'triggers.ts'),
      'utf8',
    );
    // Quote-agnostic (triggers.ts may use single or double quotes after formatting).
    const activationIdx = source.indexOf('/{projectId}/triggers/activation');
    const slugIdx = source.indexOf('/{projectId}/triggers/{slug}');
    expect(activationIdx).toBeGreaterThan(-1);
    expect(slugIdx).toBeGreaterThan(-1);
    // If this fails, the activation kill-switch is shadowed and unreachable —
    // move the activation route above the `:slug` routes in triggers.ts.
    expect(activationIdx).toBeLessThan(slugIdx);
  });
});

// The runtime-trigger routes (`routes/runtime-triggers.ts`) live under
// `/triggers/all` and `/triggers/runtime…` and register AFTER the `:slug`
// routes. Each has a method + segment count no `:slug` route has, so a
// kortix.yaml trigger named `all` or `runtime` shadows nothing, and no slug
// needs reserving. This router registers both sets in the real order.
describe('runtime trigger routes vs kortix.yaml slugs', () => {
  const route = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    createRoute({ method, path, responses: { 200: { description: 'ok' } } });
  const app = new OpenAPIHono();
  for (const [method, path] of [
    ['patch', '/{projectId}/triggers/{slug}'],
    ['delete', '/{projectId}/triggers/{slug}'],
    ['post', '/{projectId}/triggers/{slug}/fire'],
    ['get', '/{projectId}/triggers/{slug}/runs'],
    ['post', '/{projectId}/triggers/{slug}/runs/{run_id}/replay'],
    ['get', '/{projectId}/triggers/all'],
    ['post', '/{projectId}/triggers/runtime'],
    ['patch', '/{projectId}/triggers/runtime/{id}'],
    ['delete', '/{projectId}/triggers/runtime/{id}'],
    ['post', '/{projectId}/triggers/runtime/{id}/run'],
  ] as const) {
    app.openapi(route(method, path), (c: any) => c.json({ path }));
  }
  const hit = async (method: string, path: string) =>
    ((await (await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' })).json()) as { path: string }).path;

  test('a slug named `runtime` or `all` still reaches the kortix.yaml routes', async () => {
    expect(await hit('PATCH', '/p1/triggers/runtime')).toBe('/{projectId}/triggers/{slug}');
    expect(await hit('DELETE', '/p1/triggers/all')).toBe('/{projectId}/triggers/{slug}');
    expect(await hit('POST', '/p1/triggers/runtime/fire')).toBe('/{projectId}/triggers/{slug}/fire');
    expect(await hit('GET', '/p1/triggers/runtime/runs')).toBe('/{projectId}/triggers/{slug}/runs');
  });

  test('the runtime routes reach their own handlers', async () => {
    expect(await hit('GET', '/p1/triggers/all')).toBe('/{projectId}/triggers/all');
    expect(await hit('POST', '/p1/triggers/runtime')).toBe('/{projectId}/triggers/runtime');
    expect(await hit('PATCH', '/p1/triggers/runtime/trigger.0123456789ab')).toBe('/{projectId}/triggers/runtime/{id}');
    expect(await hit('DELETE', '/p1/triggers/runtime/trigger.0123456789ab')).toBe('/{projectId}/triggers/runtime/{id}');
    expect(await hit('POST', '/p1/triggers/runtime/trigger.0123456789ab/run')).toBe('/{projectId}/triggers/runtime/{id}/run');
  });
});
