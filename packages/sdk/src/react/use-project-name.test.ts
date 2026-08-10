import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Same harness as `./use-project-secrets.test.ts` / `./use-kortix-master.test.ts`:
// `useQuery` is mocked to (a) capture the config the hook builds, so the
// queryKey/enabled/freshness wiring can be asserted without a React render
// tree, and (b) return a canned `{ data }` so the hook's derivation off that
// data (`data?.workspace?.name`, `data?.workspace?.account_id`) is exercised too.
// This never calls the real `queryFn` — that goes through `backendApi`,
// covered at the facade level elsewhere.

let lastConfig: Record<string, unknown> | null = null;
let mockData: unknown;
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => {
    lastConfig = config;
    return { data: mockData };
  },
}));

const { useWorkspaceName, useWorkspaceAccountId } = await import('./use-project-name');
const { qk } = await import('./query-keys');
const { contract } = await import('./query-contracts');

beforeEach(() => {
  lastConfig = null;
  mockData = undefined;
});

describe('useWorkspaceName', () => {
  test('reads through qk.workspace.detail on the config contract', () => {
    useWorkspaceName('workspace-1');
    expect(lastConfig?.queryKey).toEqual(qk.workspace.detail('workspace-1'));
    expect(lastConfig?.staleTime).toBe(contract('config').staleTime);
    expect(lastConfig?.gcTime).toBe(contract('config').gcTime);
    expect(lastConfig?.refetchOnMount).toBe(true);
  });

  test('is disabled without a workspaceId', () => {
    useWorkspaceName(undefined);
    expect(lastConfig?.enabled).toBe(false);
  });

  test('is enabled once a workspaceId is supplied', () => {
    useWorkspaceName('workspace-1');
    expect(lastConfig?.enabled).toBe(true);
  });

  test('returns the name off the detail response', () => {
    mockData = { workspace: { workspace_id: 'workspace-1', name: 'Renamed' } };
    expect(useWorkspaceName('workspace-1')).toBe('Renamed');
  });

  test('returns undefined when the detail cache is empty', () => {
    mockData = undefined;
    expect(useWorkspaceName('workspace-1')).toBeUndefined();
  });
});

describe('useWorkspaceAccountId', () => {
  test('reads the SAME qk.workspace.detail key useWorkspaceName does, on the config contract', () => {
    useWorkspaceAccountId('workspace-1');
    expect(lastConfig?.queryKey).toEqual(qk.workspace.detail('workspace-1'));
    expect(lastConfig?.staleTime).toBe(contract('config').staleTime);
    expect(lastConfig?.gcTime).toBe(contract('config').gcTime);
    expect(lastConfig?.refetchOnMount).toBe(true);
  });

  test('is disabled without a workspaceId', () => {
    useWorkspaceAccountId(undefined);
    expect(lastConfig?.enabled).toBe(false);
  });

  test('is enabled once a workspaceId is supplied', () => {
    useWorkspaceAccountId('workspace-1');
    expect(lastConfig?.enabled).toBe(true);
  });

  test('returns the account id off the detail response', () => {
    mockData = { workspace: { workspace_id: 'workspace-1', account_id: 'acct-9' } };
    expect(useWorkspaceAccountId('workspace-1')).toBe('acct-9');
  });

  test('returns undefined when the detail cache is empty', () => {
    mockData = undefined;
    expect(useWorkspaceAccountId('workspace-1')).toBeUndefined();
  });
});
