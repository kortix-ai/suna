import { beforeEach, expect, mock, test } from 'bun:test';

const calls: string[] = [];
let refreshError: Error | null = null;
let writeError: Error | null = null;
let token: string | null = 'old-token';
let hasSession = true;

const sdk = await import('@kortix/sdk');

mock.module('@kortix/sdk', () => ({
  ...sdk,
  updateUserMetadata: async (input: { data: Record<string, unknown> }, accessToken: string) => {
    calls.push(`write:${input.data.locale}:${accessToken}`);
    if (writeError) throw writeError;
    return { user: { user_metadata: input.data } };
  },
}));
mock.module('@/lib/auth-token', () => ({
  getSupabaseAccessToken: async () => token,
}));
mock.module('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: {
    refreshSession: async () => {
      calls.push('refresh');
      return { data: { session: hasSession ? { access_token: 'refreshed-token' } : null }, error: refreshError };
    },
  } }),
}));

const { updateProfileMetadata, NotSignedInError } = await import('./update-profile');

beforeEach(() => {
  calls.length = 0;
  refreshError = null;
  writeError = null;
  token = 'old-token';
  hasSession = true;
});

test('refreshes session claims after saving German and English preferences', async () => {
  await updateProfileMetadata({ locale: 'de' });
  await updateProfileMetadata({ locale: 'en' });
  expect(calls).toEqual(['write:de:old-token', 'refresh', 'write:en:old-token', 'refresh']);
});

test('does not report success if refreshed claims cannot be persisted', async () => {
  refreshError = new Error('refresh failed');
  await expect(updateProfileMetadata({ locale: 'de' })).rejects.toThrow('refresh failed');
});

test('does not report success when refresh returns no session', async () => {
  hasSession = false;
  await expect(updateProfileMetadata({ locale: 'de' })).rejects.toBeInstanceOf(NotSignedInError);
});

test('does not refresh after a failed metadata write', async () => {
  writeError = new Error('write failed');
  await expect(updateProfileMetadata({ locale: 'de' })).rejects.toThrow('write failed');
  expect(calls).toEqual(['write:de:old-token']);
});

test('does not write or refresh without an authenticated session', async () => {
  token = null;
  await expect(updateProfileMetadata({ locale: 'de' })).rejects.toBeInstanceOf(NotSignedInError);
  expect(calls).toEqual([]);
});
