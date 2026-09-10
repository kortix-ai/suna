import { expect, test } from 'bun:test';
import { sessionAllowsAllPermissions } from './session-permissions';

test('session mode restores from server rules and follows rule order', () => {
  const all = { permission: '*', pattern: '*', action: 'allow' } as const;
  const deny = { permission: 'bash', pattern: '*', action: 'deny' } as const;
  expect(sessionAllowsAllPermissions(undefined)).toBeUndefined();
  expect(sessionAllowsAllPermissions([])).toBe(false);
  expect(sessionAllowsAllPermissions([all])).toBe(true);
  expect(sessionAllowsAllPermissions([all, deny])).toBe(false);
  expect(sessionAllowsAllPermissions([deny, all])).toBe(true);
  expect(sessionAllowsAllPermissions([{ ...all, pattern: '/workspace/*' }])).toBe(false);
  expect(sessionAllowsAllPermissions([all, { ...deny, action: 'ask' }])).toBe(false);
});
