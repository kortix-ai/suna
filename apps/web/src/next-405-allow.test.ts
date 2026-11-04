import { expect, test } from 'bun:test';
// The patched helper (see patches/next@16.4.2.patch) is next's own
// auto-implementations for App Route handlers: the module every bare-405
// kortix.com route response came from (KRTX-3380, pentest http.contract).
// The runtime contract is a bag of zero-arg handlers returning Responses.
const { autoImplementMethods } = (await import(
  'next/dist/server/route-modules/app-route/helpers/auto-implement-methods'
)) as unknown as {
  autoImplementMethods: (handlers: unknown) => Record<string, () => Response>;
};

test('an unimplemented method answers 405 naming the methods the route supports', () => {
  const methods = autoImplementMethods({
    GET: () => new Response('ok'),
  });

  const res = methods.POST();
  expect(res.status).toBe(405);
  // RFC 9110 §15.5.6: the 405 carries Allow, including the methods next
  // auto-implements (HEAD from GET, OPTIONS with its own Allow list).
  expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
});

test('the 405 Allow list reflects exactly the userland handlers', () => {
  const methods = autoImplementMethods({
    POST: () => new Response('created', { status: 201 }),
    DELETE: () => new Response(null, { status: 204 }),
  });

  const res = methods.GET();
  expect(res.status).toBe(405);
  expect(res.headers.get('allow')).toBe('DELETE, OPTIONS, POST');
});

test('the auto-implemented OPTIONS still answers 204 with Allow', () => {
  const methods = autoImplementMethods({
    GET: () => new Response('ok'),
  });

  const res = methods.OPTIONS();
  expect(res.status).toBe(204);
  expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
});
