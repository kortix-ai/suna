import { describe, expect, test } from 'bun:test';
import { refreshWarmSessionWorkspace } from './warm-session-workspace';

const project = {
  projectId: 'project-1',
  repoUrl: 'https://git.example.test/project-1.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

describe('refreshWarmSessionWorkspace', () => {
  test('skips when the warm session has no active sandbox', async () => {
    let resolved = false;
    const result = await refreshWarmSessionWorkspace(project, 'session-1', {
      loadActiveSandbox: async () => null,
      resolveBaseSha: async () => {
        throw new Error('base SHA must not resolve without an active sandbox');
      },
      resolveIngress: async () => {
        resolved = true;
        return { url: 'https://sandbox.test', headers: {} };
      },
      fetch: globalThis.fetch,
    });

    expect(result).toEqual({ status: 'skipped' });
    expect(resolved).toBe(false);
  });

  test('refreshes the active workspace to the latest base without restarting OpenCode', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const baseSha = 'a'.repeat(40);
    const resolvedProjects: typeof project[] = [];
    const result = await refreshWarmSessionWorkspace(project, 'session-1', {
      loadActiveSandbox: async () => ({
        externalId: 'external-1',
        serviceKey: 'service-key',
      }),
      resolveBaseSha: async (input) => {
        resolvedProjects.push(input);
        return baseSha;
      },
      resolveIngress: async () => ({
        url: 'https://sandbox.test/',
        headers: { 'X-Provider-Token': 'provider-key' },
      }),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            ok: true,
            repo: {
              before: { commit: 'before-sha' },
              after: { commit: 'after-sha' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    expect(resolvedProjects).toEqual([project]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `https://sandbox.test/kortix/refresh?base=1&base_sha=${baseSha}&restart=0`,
    );
    expect(new Headers(requests[0]?.init.headers).get('authorization')).toBe(
      'Bearer service-key',
    );
    expect(new Headers(requests[0]?.init.headers).get('x-provider-token')).toBe(
      'provider-key',
    );
    expect(result).toEqual({
      status: 'updated',
      before_sha: 'before-sha',
      after_sha: 'after-sha',
    });
  });

  test('returns failed without rejecting when the daemon refresh fails', async () => {
    const result = await refreshWarmSessionWorkspace(project, 'session-1', {
      loadActiveSandbox: async () => ({
        externalId: 'external-1',
        serviceKey: 'service-key',
      }),
      resolveBaseSha: async () => 'a'.repeat(40),
      resolveIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
      fetch: async () => new Response('refresh already running', { status: 409 }),
    });

    expect(result).toEqual({
      status: 'failed',
      error: 'workspace refresh failed: 409 refresh already running',
    });
  });
});
