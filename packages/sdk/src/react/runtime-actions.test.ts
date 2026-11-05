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
}));

const actions = await import('./runtime-actions');

describe('runtime actions', () => {
  beforeEach(() => calls.splice(0));

  // The project and path facts read the workspace route (runtime-workspace-native.test.ts).
  test('owns runtime file operations', async () => {
    expect(await actions.readRuntimeTextFile('src/index.ts')).toBe('content');
    expect(calls).toContainEqual(['file.read', { path: 'src/index.ts' }]);
  });

});
