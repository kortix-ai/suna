import { describe, expect, test } from 'bun:test';
import { isExempt } from './request-deadline';

function ctx(path: string, method = 'POST') {
  return {
    req: {
      header: () => undefined,
      path,
      method,
    },
  } as never;
}

describe('requestDeadline exemptions', () => {
  test.each([
    '/v1/projects/00000000-0000-4000-a000-000000000001/registry/install',
    '/v1/projects/00000000-0000-4000-a000-000000000001/registry/update',
  ])('exempts install/update route %s', (path) => {
    expect(isExempt(ctx(path))).toBe(true);
  });

  test.each([
    '/v1/projects/00000000-0000-4000-a000-000000000001/registry',
    '/v1/subprojects',
  ])('does not exempt bounded route %s', (path) => {
    expect(isExempt(ctx(path))).toBe(false);
  });

  test.each([
    '/v1/projects/00000000-0000-4000-a000-000000000001/commit-push',
    '/v1/projects/00000000-0000-4000-a000-000000000001/provision',
  ])('leaves existing exemption %s unchanged', (path) => {
    expect(isExempt(ctx(path))).toBe(true);
  });
});

/**
 * The streaming secret relay must NOT be bounded by the 25 s deadline.
 *
 * This is one of two edits that are easy to forget and fail almost silently:
 * without the exemption every relay over 25 s dies with a 503
 * `request_deadline` (the sibling edit is `server.timeout(req, 0)` in index.ts,
 * without which Bun cuts the socket with an empty reply the LB turns into a
 * CORS-less 502). `/v1/projects` is not an exempt PREFIX, so nothing else here
 * covers these routes.
 */
describe('requestDeadline exempts the streaming secret relay', () => {
  const project = '/v1/projects/00000000-0000-4000-a000-000000000001';

  test.each([
    `${project}/secrets/STRIPE_KEY/relay`,
    `${project}/secrets/STRIPE_KEY/relay/ws-ticket`,
  ])('exempts %s', (path) => {
    expect(isExempt(ctx(path))).toBe(true);
  });

  test('still bounds the buffered broker route, which cannot stream', () => {
    // /broker is capped at 1 MiB / 5 MiB and answers in one shot, so it has no
    // business outliving the deadline.
    expect(isExempt(ctx(`${project}/secrets/STRIPE_KEY/broker`))).toBe(false);
  });

  test('the fragment is specific enough not to catch unrelated routes', () => {
    // `EXEMPT_FRAGMENTS` matches with `path.includes()`, so a fragment that is
    // too generic silently un-bounds half the API.
    for (const path of [
      `${project}/secrets`,
      `${project}/sessions`,
      '/v1/accounts/relayed-billing',
    ]) {
      expect(isExempt(ctx(path))).toBe(false);
    }
  });
});
