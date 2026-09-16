import { beforeEach, expect, mock, test } from 'bun:test';

const queryModule = await import('@tanstack/react-query');
let auth: { user: { id: string } | null; isLoading: boolean };
let query: { data: { isAdmin: boolean; role?: string } | undefined; isLoading: boolean };
let captured: Record<string, any>;

mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => auth }));
mock.module('@tanstack/react-query', () => ({
  ...queryModule,
  useQuery: (options: Record<string, any>) => {
    captured = options;
    return query;
  },
}));

const { useAdminRole } = await import('./use-admin-role');

beforeEach(() => {
  auth = { user: null, isLoading: true };
  query = { data: undefined, isLoading: false };
  captured = {};
});

test('auth hydration keeps the admin gate loading before the role query can start', () => {
  expect(useAdminRole().isLoading).toBe(true);
  expect(captured.enabled).toBe(false);
});

test('a caller cannot enable the role probe before the user is known', () => {
  useAdminRole({ enabled: true });
  expect(captured.enabled).toBe(false);
});

test('a known user waits for the role probe and then receives the admin verdict', () => {
  auth = { user: { id: 'admin-user' }, isLoading: false };
  query.isLoading = true;
  expect(useAdminRole().isLoading).toBe(true);
  expect(captured.queryKey).toEqual(['admin-role', 'admin-user']);
  expect(captured.enabled).toBe(true);
  query = { data: { isAdmin: true, role: 'super_admin' }, isLoading: false };
  expect(useAdminRole().data).toEqual({ isAdmin: true, role: 'super_admin' });
  expect(useAdminRole().isLoading).toBe(false);
});

test('a resolved anonymous identity stops loading without starting a role probe', () => {
  auth.isLoading = false;
  expect(useAdminRole().isLoading).toBe(false);
  expect(captured.enabled).toBe(false);
});

test('an explicit disabled probe remains disabled for an authenticated user', () => {
  auth = { user: { id: 'admin-user' }, isLoading: false };
  useAdminRole({ enabled: false });
  expect(captured.enabled).toBe(false);
});
