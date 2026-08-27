import { beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: Array<[string, unknown?]> = [];

const client = {
  project: {
    current: async () => ({ data: { worktree: '/workspace' } }),
  },
  path: {
    get: async () => ({ data: { directory: '/workspace', worktree: '/workspace' } }),
  },
  file: {
    read: async (input: unknown) => {
      calls.push(['file.read', input]);
      return { data: 'content' };
    },
  },
  provider: {
    auth: async () => ({ data: { openai: [{ type: 'api', label: 'API key' }] } }),
    oauth: {
      authorize: async (input: unknown) => {
        calls.push(['provider.oauth.authorize', input]);
        return { data: { method: 'code', url: 'https://auth.example.test' } };
      },
      callback: async (input: unknown) => {
        calls.push(['provider.oauth.callback', input]);
        return { data: true };
      },
    },
  },
  auth: {
    set: async (input: unknown) => {
      calls.push(['auth.set', input]);
      return { data: true };
    },
  },
  global: {
    dispose: async () => {
      calls.push(['global.dispose']);
      return { data: true };
    },
    config: {
      get: async () => ({ data: { provider: {} } }),
      update: async (input: unknown) => {
        calls.push(['global.config.update', input]);
        return { data: { provider: {} } };
      },
    },
  },
  app: {
    log: async (input: unknown) => {
      calls.push(['app.log', input]);
      return { data: true };
    },
  },
};

mock.module('../core/runtime/client', () => ({
  getClient: () => client,
}))

// getRuntimeProjectInfo / getRuntimeConfig now read the daemon `/kortix/opencode/*`
// passthroughs. Delegate to the same `client` mock's data.
mock.module('../core/runtime/daemon-read', () => ({
  readDaemonOpencode: async (path: string) => {
    if (path === 'project-current') {
      calls.push(['project.current']);
      return (await client.project.current()).data;
    }
    if (path === 'config') return (await client.global.config.get()).data;
    return undefined;
  },
}));;

const actions = await import('./runtime-actions');

describe('runtime actions', () => {
  beforeEach(() => calls.splice(0));

  test('owns runtime project, path, and file operations', async () => {
    expect((await actions.getRuntimeProjectInfo()).worktree).toBe('/workspace');
    expect((await actions.getRuntimePathInfo()).directory).toBe('/workspace');
    expect(await actions.readRuntimeTextFile('src/index.ts')).toBe('content');
    expect(calls).toContainEqual(['file.read', { path: 'src/index.ts' }]);
  });

  test('owns provider authentication and refresh operations', async () => {
    expect(await actions.getRuntimeProviderAuthMethods()).toHaveProperty('openai');
    await actions.authorizeRuntimeProvider('openai', 1);
    await actions.completeRuntimeProviderOAuth('openai', 1, 'CODE');
    await actions.setRuntimeProviderApiKey('openai', 'secret');
    await actions.refreshRuntimeConfiguration();

    expect(calls).toContainEqual([
      'provider.oauth.authorize',
      { providerID: 'openai', method: 1 },
    ]);
    expect(calls).toContainEqual([
      'provider.oauth.callback',
      { providerID: 'openai', method: 1, code: 'CODE' },
    ]);
    expect(calls).toContainEqual([
      'auth.set',
      { providerID: 'openai', auth: { type: 'api', key: 'secret' } },
    ]);
    expect(calls).toContainEqual(['global.dispose']);
  });
});
