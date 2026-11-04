import { expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

// KRTX-3239: a path whose percent-encoding does not decode (`/%ff`, an overlong
// `/%c0%af`, a cut-off `/%e2%82`) reached the router, which answered a bare 500
// (`/pricing/%c0%af` on kortix.com) or a 200 "Page not found" page (`/%ff`).
// No route can match it: it is a bad request.
test('a path with a malformed percent-encoding answers 400 before routing', async () => {
  for (const path of ['/%ff', '/%c0%afpricing', '/%e2%82', '/pricing/%c0%af', '/a/%ff/b', '/de/%ff', '/projects/%c0%af']) {
    const response = await middleware(new NextRequest(`http://localhost:3000${path}`));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Bad request');
  }
});

test('a path with a valid percent-encoding is routed as before', async () => {
  for (const path of ['/%E2%82%AC', '/%c3%a9t%c3%a9', '/%25', '/pricing']) {
    const response = await middleware(new NextRequest(`http://localhost:3000${path}`));
    expect(response.status).not.toBe(400);
  }
});
