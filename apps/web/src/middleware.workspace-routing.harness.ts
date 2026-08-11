import { mock } from 'bun:test';
import { NextRequest } from 'next/server';

let authenticatedUser: { id: string } | null = null;

mock.module('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: authenticatedUser },
        error: null,
      }),
    },
  }),
}));

mock.module('@/lib/maintenance-store', () => ({
  getMaintenanceConfig: async () => ({ level: 'none' }),
}));

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

const { middleware } = await import('./middleware');

const workspaceRedirect = await middleware(
  new NextRequest('http://localhost/projects/w1/sessions/s1?x=1'),
);

const unauthenticatedWorkspace = await middleware(
  new NextRequest('http://localhost/workspaces/w1?x=1'),
);
const unauthenticatedLocation = new URL(unauthenticatedWorkspace.headers.get('location')!);

authenticatedUser = { id: 'user-1' };
const authenticatedWorkspace = await middleware(
  new NextRequest('http://localhost/workspaces/w1?x=1'),
);

console.log(
  JSON.stringify({
    workspaceRedirect: {
      status: workspaceRedirect.status,
      location: workspaceRedirect.headers.get('location'),
    },
    unauthenticatedWorkspace: {
      status: unauthenticatedWorkspace.status,
      pathname: unauthenticatedLocation.pathname,
      redirect: unauthenticatedLocation.searchParams.get('redirect'),
    },
    authenticatedWorkspace: {
      status: authenticatedWorkspace.status,
      rewrite: authenticatedWorkspace.headers.get('x-middleware-rewrite'),
    },
  }),
);
