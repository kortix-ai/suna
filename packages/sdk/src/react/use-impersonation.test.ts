import { describe, expect, test } from 'bun:test';
import {
  ADMIN_IMPERSONATE_ACTIVE_PATH,
  ADMIN_IMPERSONATE_PATH,
  adminImpersonateRevokePath,
  useAdminImpersonate,
  useImpersonation,
  useStopImpersonation,
  type AdminImpersonateResponse,
} from './use-impersonation';

describe('act-as wire contract', () => {
  // The three paths are the entire server contract these hooks depend on, so
  // they are pinned here rather than inside a rendered hook.
  test('mint, revoke and active-list paths match the admin router', () => {
    expect(ADMIN_IMPERSONATE_PATH).toBe('/admin/api/impersonate');
    expect(ADMIN_IMPERSONATE_ACTIVE_PATH).toBe('/admin/api/impersonate/active');
    expect(adminImpersonateRevokePath('grant-1')).toBe('/admin/api/impersonate/grant-1');
  });

  test('a grant id is URL-encoded, so a malformed one cannot reshape the path', () => {
    expect(adminImpersonateRevokePath('../accounts')).toBe(
      '/admin/api/impersonate/..%2Faccounts',
    );
  });

  test('the hooks are exported as hooks', () => {
    expect(typeof useAdminImpersonate).toBe('function');
    expect(typeof useStopImpersonation).toBe('function');
    expect(typeof useImpersonation).toBe('function');
  });

  test('the mint response type carries the server-chosen expiry', () => {
    const response: AdminImpersonateResponse = {
      grant_id: 'g',
      account_id: 'a',
      account_name: null,
      expires_at: '2026-08-11T13:00:00.000Z',
    };
    expect(response.expires_at).toBe('2026-08-11T13:00:00.000Z');
  });
});
