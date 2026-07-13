import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let templateExists = false;
let builderCalls: Array<{ method: string; args: unknown[] }> = [];
let buildCalls: Array<{ template: unknown; name: string; opts: Record<string, unknown> }> = [];

const builder = {
  fromDockerfile(path: string) {
    builderCalls.push({ method: 'fromDockerfile', args: [path] });
    return builder;
  },
  setStartCmd(command: string, ready: string) {
    builderCalls.push({ method: 'setStartCmd', args: [command, ready] });
    return builder;
  },
};

const FakeTemplate = Object.assign(
  (opts?: Record<string, unknown>) => {
    builderCalls.push({ method: 'Template', args: [opts] });
    return builder;
  },
  {
    build: async (template: unknown, name: string, opts: Record<string, unknown>) => {
      buildCalls.push({ template, name, opts });
      (opts.onBuildLogs as ((entry: { message: string }) => void) | undefined)?.({
        message: 'template ready',
      });
      return { templateId: 'tpl-1', buildId: 'build-1', name, alias: name, tags: [] };
    },
    exists: async () => templateExists,
  },
);

mock.module('e2b', () => ({
  Template: FakeTemplate,
  waitForURL: (url: string) => `wait-for:${url}`,
}));
mock.module('../../config', () => ({
  config: { E2B_API_KEY: 'e2b-test-key' },
}));
mock.module('../build-context', () => ({
  DEFAULT_CPU: 2,
  DEFAULT_MEMORY_GB: 4,
  KORTIX_ENTRYPOINT: '/usr/local/bin/kortix-entrypoint',
  stageBuildContext: async () => ({
    contextDir: '/tmp/kortix-e2b-adapter-test',
    composedPath: '/tmp/kortix-e2b-adapter-test/Dockerfile',
  }),
}));

const originalFetch = globalThis.fetch;
const { e2bProvider } = await import('./e2b');

beforeEach(() => {
  templateExists = false;
  builderCalls = [];
  buildCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('E2B template adapter', () => {
  test('builds the shared staged Dockerfile without snapshotting a tokenless runtime process', async () => {
    const logs: string[] = [];

    await e2bProvider.buildSnapshot(
      {
        snapshotName: 'kortix-e2b-template',
        slug: 'default',
        image: 'ubuntu:24.04',
        entrypoint: ['/usr/local/bin/kortix-entrypoint'],
        spec: { cpu: 4, memoryGb: 8, diskGb: 20 },
      },
      { onLine: (line) => logs.push(line) },
    );

    expect(builderCalls).toEqual([
      { method: 'Template', args: [{ fileContextPath: '/tmp/kortix-e2b-adapter-test' }] },
      { method: 'fromDockerfile', args: ['/tmp/kortix-e2b-adapter-test/Dockerfile'] },
    ]);
    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0]).toMatchObject({
      name: 'kortix-e2b-template',
      opts: { apiKey: 'e2b-test-key', cpuCount: 4, memoryMB: 8192 },
    });
    expect(logs).toEqual(['template ready']);
  });

  test('reports a ready E2B template through the common snapshot state contract', async () => {
    templateExists = true;
    expect(await e2bProvider.getSnapshotState('kortix-e2b-template')).toBe('active');
  });

  test('lists and deletes only the matching E2B template identity', async () => {
    const requests: Array<{ url: string; method: string; apiKey: string | null }> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        apiKey: new Headers(init?.headers).get('X-API-KEY'),
      });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json([
        {
          templateID: 'tpl-target',
          names: ['team/kortix-e2b-template:default'],
          aliases: [],
          buildStatus: 'ready',
        },
        {
          templateID: 'tpl-other',
          names: ['team/unrelated:default'],
          aliases: [],
          buildStatus: 'ready',
        },
      ]);
    }) as unknown as typeof fetch;

    expect(await e2bProvider.listSnapshots()).toEqual([
      { name: 'kortix-e2b-template' },
      { name: 'unrelated' },
    ]);
    await e2bProvider.deleteSnapshot('kortix-e2b-template');

    expect(requests.at(-1)).toEqual({
      url: 'https://api.e2b.dev/templates/tpl-target',
      method: 'DELETE',
      apiKey: 'e2b-test-key',
    });
  });
});
