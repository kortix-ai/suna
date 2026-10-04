import { describe, expect, test } from 'bun:test';
import { accountsRouter } from '../http/accounts/core/app';
import { registerMemberRoutes } from '../http/accounts/core/members';

// A non-UUID :userId reached the uuid column query and surfaced as a
// 500 `22P02 invalid input syntax for type uuid`. The route schema must
// reject it as a 400 before any handler or DB access runs.
registerMemberRoutes();

describe('members/:userId param validation', () => {
  for (const method of ['DELETE', 'PATCH']) {
    test(`${method} with a non-UUID userId returns 400`, async () => {
      const res = await accountsRouter.request(
        '/00000000-0000-4000-8000-000000000001/members/not-a-uuid',
        {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'PATCH' ? JSON.stringify({ role: 'member' }) : undefined,
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toBe('Validation failed');
    });
  }
});
