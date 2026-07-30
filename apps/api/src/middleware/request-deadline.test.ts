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
    '/v1/projects/00000000-0000-4000-a000-000000000001/marketplace/install',
    '/v1/projects/00000000-0000-4000-a000-000000000001/registry/install',
    '/v1/projects/00000000-0000-4000-a000-000000000001/marketplace/update',
    '/v1/projects/00000000-0000-4000-a000-000000000001/marketplace/update-all',
    '/v1/projects/00000000-0000-4000-a000-000000000001/registry/update',
  ])('exempts install/update route %s', (path) => {
    expect(isExempt(ctx(path))).toBe(true);
  });

  test.each([
    '/v1/marketplace/items',
    '/v1/projects/00000000-0000-4000-a000-000000000001/registry',
  ])('does not exempt bounded route %s', (path) => {
    expect(isExempt(ctx(path))).toBe(false);
  });

  test('exempts only POST requests to the exact ACP JSON-RPC route shape', () => {
    const path =
      '/v1/projects/00000000-0000-4000-a000-000000000001/sessions/00000000-0000-4000-a000-000000000002/acp';
    expect(isExempt(ctx(path, 'POST'))).toBe(true);
    expect(isExempt(ctx(path, 'GET'))).toBe(false);
    expect(
      isExempt(
        ctx('/v1/projects/00000000-0000-4000-a000-000000000001/acp', 'POST'),
      ),
    ).toBe(false);
    expect(
      isExempt(
        ctx(
          '/v1/projects/00000000-0000-4000-a000-000000000001/sessions/00000000-0000-4000-a000-000000000002/acp/extra',
          'POST',
        ),
      ),
    ).toBe(false);
  });

  test.each([
    '/v1/projects/00000000-0000-4000-a000-000000000001/commit-push',
    '/v1/projects/00000000-0000-4000-a000-000000000001/provision',
  ])('leaves existing exemption %s unchanged', (path) => {
    expect(isExempt(ctx(path))).toBe(true);
  });
});
