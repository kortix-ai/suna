import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * KRTX-2316: opening the app used to read one sessions page per project
 * (151 requests for a member of 150 projects) to pick a "default sandbox" no
 * screen needs: a thread binds its own session's sandbox when it connects. A
 * signed-in cold start of the sandbox provider sends no session request.
 */

// react-test-renderer ships no types.
const { act, create } = require('react-test-renderer') as {
  act: (fn: () => Promise<void> | void) => Promise<void>;
  create: (element: React.ReactElement) => { unmount: () => void };
};

const requests: string[] = [];
const PROJECTS = Array.from({ length: 150 }, (_, index) => ({
  project_id: `p-${index}`,
  account_id: 'a-1',
  name: `Project ${index}`,
  updated_at: '2026-10-01T00:00:00.000Z',
}));

mock.module('@/lib/projects/projects-client', () => ({
  listProjectsForAccount: async () => {
    requests.push('GET /projects');
    return PROJECTS;
  },
  listProjectSessions: async (projectId: string) => {
    requests.push(`GET /projects/${projectId}/sessions`);
    return [];
  },
}));
mock.module('@/contexts/AuthContext', () => ({
  useAuthContext: () => ({ isAuthenticated: true, mfaRequired: false, isLoading: false }),
}));
mock.module('@/components/session/SessionRuntime', () => ({
  SessionRuntimeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
mock.module('@/hooks/useRuntimeStream', () => ({ useRuntimeStream: () => {} }));
mock.module('@/lib/session/disclosure-store', () => ({
  useDisclosureStore: { getState: () => ({ clear: () => {} }) },
}));
mock.module('@/lib/logger', () => ({ log: { log: () => {}, warn: () => {}, error: () => {} } }));

let SandboxProvider: typeof import('./SandboxContext').SandboxProvider;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  SandboxProvider = (await import('./SandboxContext')).SandboxProvider;
});

let tree: { unmount: () => void } | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

test('a signed-in cold start sends no session request', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    tree = create(
      React.createElement(QueryClientProvider, { client }, React.createElement(SandboxProvider, null, null)),
    );
  });
  // Let any query the provider started run to its end.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(requests).toEqual([]);
});
