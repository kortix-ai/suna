import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Same harness as `./use-project-secrets.test.ts` / `./use-kortix-master.test.ts`:
// `useQuery` is mocked to (a) capture the config the hook builds, so the
// queryKey/enabled/freshness wiring can be asserted without a React render
// tree, and (b) return a canned `{ data }` so the hook's derivation off that
// data (`data?.project?.name`, `data?.project?.account_id`) is exercised too.
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

const { useProjectName, useProjectAccountId, useProjectIcon } = await import(
  './use-project-name'
);
const { qk } = await import('./query-keys');
const { contract } = await import('./query-contracts');

beforeEach(() => {
  lastConfig = null;
  mockData = undefined;
});

describe('useProjectName', () => {
  test('reads through qk.project.detail on the config contract', () => {
    useProjectName('proj-1');
    expect(lastConfig?.queryKey).toEqual(qk.project.detail('proj-1'));
    expect(lastConfig?.staleTime).toBe(contract('config').staleTime);
    expect(lastConfig?.gcTime).toBe(contract('config').gcTime);
    expect(lastConfig?.refetchOnMount).toBe(true);
  });

  test('is disabled without a projectId', () => {
    useProjectName(undefined);
    expect(lastConfig?.enabled).toBe(false);
  });

  test('is enabled once a projectId is supplied', () => {
    useProjectName('proj-1');
    expect(lastConfig?.enabled).toBe(true);
  });

  test('returns the name off the detail response', () => {
    mockData = { project: { project_id: 'proj-1', name: 'Renamed' } };
    expect(useProjectName('proj-1')).toBe('Renamed');
  });

  test('returns undefined when the detail cache is empty', () => {
    mockData = undefined;
    expect(useProjectName('proj-1')).toBeUndefined();
  });
});

describe('useProjectAccountId', () => {
  test('reads the SAME qk.project.detail key useProjectName does, on the config contract', () => {
    useProjectAccountId('proj-1');
    expect(lastConfig?.queryKey).toEqual(qk.project.detail('proj-1'));
    expect(lastConfig?.staleTime).toBe(contract('config').staleTime);
    expect(lastConfig?.gcTime).toBe(contract('config').gcTime);
    expect(lastConfig?.refetchOnMount).toBe(true);
  });

  test('is disabled without a projectId', () => {
    useProjectAccountId(undefined);
    expect(lastConfig?.enabled).toBe(false);
  });

  test('is enabled once a projectId is supplied', () => {
    useProjectAccountId('proj-1');
    expect(lastConfig?.enabled).toBe(true);
  });

  test('returns the account id off the detail response', () => {
    mockData = { project: { project_id: 'proj-1', account_id: 'acct-9' } };
    expect(useProjectAccountId('proj-1')).toBe('acct-9');
  });

  test('returns undefined when the detail cache is empty', () => {
    mockData = undefined;
    expect(useProjectAccountId('proj-1')).toBeUndefined();
  });
});

describe('useProjectIcon', () => {
  test('reads the SAME qk.project.detail key useProjectName does, on the config contract', () => {
    useProjectIcon('proj-1');
    expect(lastConfig?.queryKey).toEqual(qk.project.detail('proj-1'));
    expect(lastConfig?.staleTime).toBe(contract('config').staleTime);
    expect(lastConfig?.gcTime).toBe(contract('config').gcTime);
    expect(lastConfig?.refetchOnMount).toBe(true);
  });

  test('is disabled without a projectId', () => {
    useProjectIcon(undefined);
    expect(lastConfig?.enabled).toBe(false);
  });

  test('is enabled once a projectId is supplied', () => {
    useProjectIcon('proj-1');
    expect(lastConfig?.enabled).toBe(true);
  });

  test('returns the emoji off the detail response', () => {
    mockData = { project: { project_id: 'proj-1', icon: '🐢' } };
    expect(useProjectIcon('proj-1')).toEqual({ icon: '🐢', icon_glyph: null });
  });

  test('returns the glyph off the detail response', () => {
    mockData = { project: { project_id: 'proj-1', icon_glyph: { name: 'Heart', color: 'red' } } };
    expect(useProjectIcon('proj-1')).toEqual({
      icon: null,
      icon_glyph: { name: 'Heart', color: 'red' },
    });
  });

  // A project with no icon still resolves to a KNOWN pair rather than to
  // `undefined` — a caller must be able to tell "this project has no icon"
  // apart from "the cache has not answered yet", because those two render
  // differently (the initial tile vs. nothing at all).
  test('normalises an icon-less project to an explicit null pair', () => {
    mockData = { project: { project_id: 'proj-1' } };
    expect(useProjectIcon('proj-1')).toEqual({ icon: null, icon_glyph: null });
  });

  test('returns undefined when the detail cache is empty', () => {
    mockData = undefined;
    expect(useProjectIcon('proj-1')).toBeUndefined();
  });
});
