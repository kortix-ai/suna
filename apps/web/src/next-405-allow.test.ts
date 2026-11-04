import { expect, test } from 'bun:test';
import { AppRouteRouteModule } from 'next/dist/server/route-modules/app-route/module.compiled';

// KRTX-3380 (pentest http.contract): a bare 405 breaks RFC 9110 §15.5.6.
// Next serves App Route handlers from dist/compiled/next-server/app-route*.js
// (what module.compiled selects at runtime), patched by patches/next@16.4.2.patch.
// This drives that exact bundle: build a route module around a userland
// module, then resolve the handler Next would run for a method.
// Next's RouteKind is an ambient const enum (unusable under isolatedModules),
// so the definition is parsed from JSON instead of naming RouteKind.APP_ROUTE.
const definition = JSON.parse(
  '{"kind":"APP_ROUTE","page":"/x","pathname":"/x","filename":"route","bundlePath":"app/x/route"}',
);

async function resolve(
  handlers: Partial<Record<'GET' | 'POST' | 'DELETE', () => Response>>,
  method: string,
) {
  const routeModule = new AppRouteRouteModule({
    userland: () => ({ generateStaticParams: undefined, ...handlers }),
    definition,
    distDir: '.next',
    relativeProjectDir: '',
    resolvedPagePath: 'app/x/route.ts',
    nextConfigOutput: undefined,
  });
  await routeModule.ensureUserland();
  return routeModule['resolveHandler'](method);
}

test('an unimplemented method answers 405 naming the methods the route supports', async () => {
  const res = (await resolve({ GET: () => new Response('ok') }, 'POST'))();
  expect(res.status).toBe(405);
  // Includes the methods Next auto-implements: HEAD from GET, and OPTIONS.
  expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
});

test('the 405 Allow list reflects exactly the userland handlers', async () => {
  const res = (
    await resolve(
      {
        POST: () => new Response('created', { status: 201 }),
        DELETE: () => new Response(null, { status: 204 }),
      },
      'GET',
    )
  )();
  expect(res.status).toBe(405);
  expect(res.headers.get('allow')).toBe('DELETE, OPTIONS, POST');
});

test('the auto-implemented OPTIONS still answers 204 with Allow', async () => {
  const res = (await resolve({ GET: () => new Response('ok') }, 'OPTIONS'))();
  expect(res.status).toBe(204);
  expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
});
