import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realRuntimeClient from '../../core/runtime/client';
import * as realKeys from './keys';

let runtimeReady = true;
mock.module('./keys', () => ({
  ...realKeys,
  useOpenCodeRuntimeReady: () => runtimeReady,
}));

let runtimeState = {
  sandboxId: 'worker-1' as string | null,
  dataRuntimeKind: 'environment' as 'worker' | 'environment' | null,
  workspaceUrl: 'https://environment.example.test' as string | null,
  workspaceSandboxId: 'environment-1' as string | null,
};
mock.module('../use-current-runtime', () => ({
  useCurrentRuntime: (selector: (state: typeof runtimeState) => unknown) => selector(runtimeState),
}));

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));

const calls: string[] = [];
const workspaceClient = {
  project: {
    list: async () => {
      calls.push('project.list');
      return { data: [] };
    },
    current: async () => {
      calls.push('project.current');
      return { data: { id: 'project-1', worktree: '/workspace' } };
    },
  },
  path: {
    get: async () => {
      calls.push('path.get');
      return { data: { directory: '/workspace', worktree: '/workspace' } };
    },
  },
};
mock.module('../../core/runtime/client', () => ({
  ...realRuntimeClient,
  getClient: () => {
    throw new Error('project reads must not use the Pi control runtime');
  },
  getWorkspaceClient: () => workspaceClient,
}));

const { useOpenCodeCurrentProject, useOpenCodePathInfo, useOpenCodeProjects } = await import(
  './projects'
);

type QueryConfig = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  enabled: boolean;
};

beforeEach(() => {
  calls.splice(0);
  runtimeReady = true;
  runtimeState = {
    sandboxId: 'worker-1',
    dataRuntimeKind: 'environment',
    workspaceUrl: 'https://environment.example.test',
    workspaceSandboxId: 'environment-1',
  };
});

describe('workspace project hooks', () => {
  test('read project and path data from the environment client', async () => {
    const projects = useOpenCodeProjects() as unknown as QueryConfig;
    const current = useOpenCodeCurrentProject() as unknown as QueryConfig;
    const path = useOpenCodePathInfo() as unknown as QueryConfig;

    await projects.queryFn();
    await current.queryFn();
    await path.queryFn();

    expect(calls).toEqual(['project.list', 'project.current', 'path.get']);
    expect(projects.queryKey.at(-1)).toBe('environment-1');
    expect(current.queryKey.at(-1)).toBe('environment-1');
    expect(path.queryKey.at(-1)).toBe('environment-1');
  });

  test('stay disabled while a Pi environment is pending', () => {
    runtimeState = { ...runtimeState, workspaceUrl: null, workspaceSandboxId: null };

    expect((useOpenCodeProjects() as unknown as QueryConfig).enabled).toBe(false);
    expect((useOpenCodeCurrentProject() as unknown as QueryConfig).enabled).toBe(false);
    expect((useOpenCodePathInfo() as unknown as QueryConfig).enabled).toBe(false);
  });
});
