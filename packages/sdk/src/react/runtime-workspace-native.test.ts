import { beforeEach, describe, expect, mock, test } from 'bun:test';
// A box that serves the session-log actions answers the checkout facts natively
// (`GET /kortix/runtime/workspace`): no `/project/current` or `/path` read.
const RUNTIME = 'http://api.test/v1/p/sbx_1/8000';
const paths: string[] = [];
const compatibility: string[] = [];
const realActive = await import('../core/session/server-store/active');
mock.module('../core/session/server-store/active', () => ({ ...realActive, getActiveRuntimeUrl: () => RUNTIME }));
const realAuth = await import('../core/http/auth');
mock.module('../core/http/auth', () => ({
  ...realAuth,
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname.replace('/v1/p/sbx_1/8000', '');
    paths.push(path);
    if (path === '/kortix/health') return Response.json({ capabilities: ['runtime.actions.v1'] });
    if (path === '/kortix/runtime/workspace') return Response.json({ directory: '/workspace', home: '/home/kortix', vcs: 'git', default_branch: 'main' });
    return Response.json({ error: `unexpected ${path}` }, { status: 404 });
  },
}));
mock.module('../core/runtime/client', () => ({
  getClient: () => ({
    project: { current: async () => (compatibility.push('project.current'), { data: { worktree: '/old' } }) },
    path: { get: async () => (compatibility.push('path.get'), { data: { directory: '/old' } }) },
  }),
}));
const { __resetRuntimeActionsMemo } = await import('../core/session/runtime-actions');
const { getRuntimePathInfo, getRuntimeProjectInfo } = await import('./runtime-actions');

beforeEach(() => {
  paths.length = 0;
  compatibility.length = 0;
  __resetRuntimeActionsMemo();
});

describe('the checkout facts on a box that serves the session-log actions', () => {
  test('project info: the workspace route answers the worktree and the VCS', async () => {
    expect(await getRuntimeProjectInfo()).toMatchObject({ worktree: '/workspace', vcs: 'git' });
    expect(paths).toEqual(['/kortix/health', '/kortix/runtime/workspace']);
    expect(compatibility).toEqual([]);
  });

  test('path info: the workspace route answers the directory and the home', async () => {
    expect(await getRuntimePathInfo()).toMatchObject({ directory: '/workspace', worktree: '/workspace', home: '/home/kortix' });
    expect(compatibility).toEqual([]);
  });
});
