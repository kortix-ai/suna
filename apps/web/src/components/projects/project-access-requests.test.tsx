import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '@kortix/sdk';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const win = new Window();
const globals = { window: win, document: win.document, navigator: win.navigator,
  HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node,
  IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'synthetic-member' }, isLoading: false }) }));
mock.module('@/lib/auth/use-signed-out-redirect', () => ({ useSignedOutRedirect: () => {} }));
mock.module('next/navigation', () => ({ useParams: () => ({ sessionId: 'synthetic-session' }), useRouter: () => ({ replace: () => {} }), usePathname: () => '/projects/synthetic-project' }));
mock.module('@/hooks/admin/use-admin-role', () => ({ useAdminRole: () => ({ data: { isAdmin: false } }) }));
mock.module('@/lib/onboarding/use-app-home', () => ({ useAppHome: () => '/projects' }));
mock.module('@/features/auth/auth-card-shell', () => ({ AuthFrame: ({ children }: { children: React.ReactNode }) => children }));
mock.module('@/features/auth/auth-primitives', () => ({
  Rise: ({ children }: { children: React.ReactNode }) => children,
  StepHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  ErrorStrip: () => null,
}));
const { ProjectAccessBoundary } = await import('./project-access-boundary');
configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'synthetic-token' });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let client: QueryClient | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  document.body.innerHTML = '';
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  mock.restore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  win.happyDOM.abort();
});

test.each([403, 404])('denied project (%s) makes only the access request, including on a session URL', async status => {
  const urls: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json({ message: 'Access denied' }, { status });
  }, { preconnect: originalFetch.preconnect });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client = queryClient;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<QueryClientProvider client={queryClient}><ProjectAccessBoundary projectId="synthetic-project"><p>Project contents</p></ProjectAccessBoundary></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(container.textContent).not.toContain('Project contents');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/projects');
  expect(urls).toEqual(['http://test.local/projects/synthetic-project']);
});

test('authorized project waits for access, then warms shell and session reads', async () => {
  const urls: string[] = [];
  let grant: (() => void) | undefined;
  const access = new Promise<void>(resolve => { grant = resolve; });
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url === 'http://test.local/projects/synthetic-project') {
      await access;
      return Response.json({ project_id: 'synthetic-project', account_id: 'synthetic-account' });
    }
    return Response.json({});
  }, { preconnect: originalFetch.preconnect });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client = queryClient;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<QueryClientProvider client={queryClient}><ProjectAccessBoundary projectId="synthetic-project"><p>Project contents</p></ProjectAccessBoundary></QueryClientProvider>));
  expect(urls).toEqual(['http://test.local/projects/synthetic-project']);
  expect(container.textContent).not.toContain('Project contents');
  await act(async () => { grant?.(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(container.textContent).toContain('Project contents');
  expect(urls).toContain('http://test.local/projects/synthetic-project/detail');
  expect(urls).toContain('http://test.local/projects/synthetic-project/sessions/synthetic-session/snapshot?transcript=40');
});
