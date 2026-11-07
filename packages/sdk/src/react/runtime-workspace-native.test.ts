import { beforeEach, describe, expect, mock, test } from 'bun:test';
// The box answers the checkout facts natively (`GET /kortix/runtime/workspace`,
// `runtime.actions.v1`): no `/project/current` or `/path` read.
const RUNTIME = 'http://api.test/v1/p/sbx_1/8000';
const paths: string[] = [];
const realActive = await import('../core/session/server-store/active');
mock.module('../core/session/server-store/active', () => ({ ...realActive, getActiveRuntimeUrl: () => RUNTIME }));
const realAuth = await import('../core/http/auth');
mock.module('../core/http/auth', () => ({
  ...realAuth,
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname.replace('/v1/p/sbx_1/8000', '');
    paths.push(path);
    if (path === '/kortix/runtime/workspace') return Response.json({ directory: '/workspace', home: '/home/kortix', vcs: 'git', default_branch: 'main' });
    return Response.json({ error: `unexpected ${path}` }, { status: 404 });
  },
}));
const { getRuntimePathInfo, getRuntimeWorkspaceInfo } = await import('./runtime-actions');

beforeEach(() => {
  paths.length = 0;
});

describe('the checkout facts', () => {
  test('project info: the workspace route answers the worktree and the VCS', async () => {
    expect(await getRuntimeWorkspaceInfo()).toMatchObject({ worktree: '/workspace', vcs: 'git' });
    expect(paths).toEqual(['/kortix/runtime/workspace']);
  });

  test('path info: the workspace route answers the directory and the home', async () => {
    expect(await getRuntimePathInfo()).toMatchObject({ directory: '/workspace', worktree: '/workspace', home: '/home/kortix' });
    expect(paths).toEqual(['/kortix/runtime/workspace']);
  });
});
