import { configureKortix } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, jest, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'synthetic-user' }, isLoading: false }),
}));
mock.module('@/lib/auth/use-signed-out-redirect', () => ({ useSignedOutRedirect: () => {} }));
mock.module('@kortix/ui/internal/hooks/admin/use-admin-role', () => ({ useAdminRole: () => ({ data: null }) }));
mock.module('@kortix/ui/internal/lib/onboarding/use-app-home', () => ({ useAppHome: () => '/' }));
mock.module('next/navigation', () => ({
  usePathname: () => '/projects/deleted-project',
  useParams: () => ({ sessionId: 'synthetic-session' }),
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, { raw: (key: string) => key, rich: (key: string) => key }),
}));
const { ProjectAccessBoundary } = await import('./project-access-boundary');
let tree: ReactTestRenderer | undefined;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
  client.clear();
  jest.useRealTimers();
});

test('a deleted project settles once and stays quiet across a cached revisit', async () => {
  jest.useFakeTimers();
  const urls: string[] = [];
  const reports: unknown[] = [];
  configureKortix({
    backendUrl: 'http://api.test/v1',
    getToken: async () => 'synthetic-token',
    onError: (error) => {
      reports.push(error);
    },
    fetch: async (url) => {
      urls.push(String(url));
      return Response.json({ message: 'Not found' }, { status: 404 });
    },
  });
  const mount = async () => {
    await act(async () => {
      tree = create(
        createElement(
          QueryClientProvider,
          { client },
          <ProjectAccessBoundary projectId="deleted-project">
            PRIVATE PROJECT CONTENT
          </ProjectAccessBoundary>,
        ),
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(JSON.stringify(tree?.toJSON())).toContain('projectAccessBoundary.notFoundHeading');
    expect(JSON.stringify(tree?.toJSON())).not.toContain('PRIVATE PROJECT CONTENT');
  };
  await mount();
  await act(async () => {
    jest.advanceTimersByTime(120_000);
  });
  await act(async () => tree?.unmount());
  await mount();
  expect(urls).toEqual(['http://api.test/v1/projects/deleted-project']);
  expect(reports).toHaveLength(0);
});

test('a transient failure retries on revisit and successful access starts shell reads', async () => {
  jest.useFakeTimers();
  const urls: string[] = [];
  let recovered = false;
  configureKortix({
    backendUrl: 'http://api.test/v1',
    getToken: async () => 'synthetic-token',
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/recovering-project')) {
        return recovered
          ? Response.json({ id: 'recovering-project' })
          : Response.json({ message: 'Unavailable' }, { status: 500 });
      }
      return Response.json({ message: 'Not found' }, { status: 404 });
    },
  });
  const mount = async () => {
    await act(async () => {
      tree = create(
        <QueryClientProvider client={client}>
          <ProjectAccessBoundary projectId="recovering-project">
            HEALTHY PROJECT
          </ProjectAccessBoundary>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
  };
  await mount();
  expect(urls).toHaveLength(1);
  expect(JSON.stringify(tree?.toJSON())).toContain('projectAccessBoundary.errorHeading');
  await act(async () => tree?.unmount());
  recovered = true;
  await mount();
  expect(JSON.stringify(tree?.toJSON())).toContain('HEALTHY PROJECT');
  expect(urls.filter((url) => url.endsWith('/recovering-project'))).toHaveLength(2);
  expect(urls.some((url) => url.endsWith('/recovering-project/detail'))).toBe(true);
});

test('a forbidden project offers access request without speculative reads', async () => {
  jest.useFakeTimers();
  const urls: string[] = [];
  configureKortix({
    backendUrl: 'http://api.test/v1',
    getToken: async () => 'synthetic-token',
    fetch: async (url) => {
      urls.push(String(url));
      return Response.json({ message: 'Forbidden' }, { status: 403 });
    },
  });
  await act(async () => {
    tree = create(
      <QueryClientProvider client={client}>
        <ProjectAccessBoundary projectId="private-project">
          PRIVATE PROJECT CONTENT
        </ProjectAccessBoundary>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(100);
  });
  expect(JSON.stringify(tree?.toJSON())).toContain('projectAccessBoundary.privateHeading');
  expect(JSON.stringify(tree?.toJSON())).not.toContain('PRIVATE PROJECT CONTENT');
  expect(urls).toEqual(['http://api.test/v1/projects/private-project']);
});
