import type { RuntimeProfilesResponse } from '@kortix/sdk/projects-client';

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `runtime-view.test.tsx` established (this file's tests are the surviving
// half of that suite — the profile-CRUD behavior that moved into Agents when
// the standalone Runtime section was removed).
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, render, screen } = await import('@testing-library/react');

let runtimeProfiles: RuntimeProfilesResponse = {
  schema_version: 3,
  editable: true,
  runtimes: {},
};
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === 'runtime-profiles') {
      return { data: runtimeProfiles, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));

const { RuntimeProfilesManager } = await import('./runtime-profiles-manager');

const PROJECT_ID = 'proj_1';

afterEach(() => {
  cleanup();
  runtimeProfiles = { schema_version: 3, editable: true, runtimes: {} };
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('RuntimeProfilesManager', () => {
  test('a not-yet-editable project shows the enable-harnesses upsell, not the profile editor', () => {
    runtimeProfiles = { schema_version: 2, editable: false, runtimes: {} };
    render(<RuntimeProfilesManager projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Turn on runtime profiles')).toBeDefined();
    expect(screen.queryByText('Runtime profiles')).toBeNull();
  });

  test('a read-only viewer sees the upsell with its action disabled', () => {
    runtimeProfiles = { schema_version: 2, editable: false, runtimes: {} };
    render(<RuntimeProfilesManager projectId={PROJECT_ID} canWrite={false} />);

    const button = screen.getByRole('button', { name: 'Enable runtime profiles' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  test('an editable project lists its declared profiles with harness + config dir', () => {
    runtimeProfiles = {
      schema_version: 3,
      editable: true,
      runtimes: {
        claude: { harness: 'claude', config_dir: '.claude' },
        'runtime-2': { harness: 'opencode' },
      },
    };
    render(<RuntimeProfilesManager projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Runtime profiles')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    // "claude" appears twice — the profile name and its harness badge.
    expect(screen.getAllByText('claude').length).toBe(2);
    expect(screen.getByText('.claude')).toBeDefined();
    expect(screen.getByText('runtime-2')).toBeDefined();
    expect(screen.getByText('opencode')).toBeDefined();
  });

  test('a read-only viewer sees the profile list with "Edit profiles" disabled', () => {
    runtimeProfiles = {
      schema_version: 3,
      editable: true,
      runtimes: { claude: { harness: 'claude' } },
    };
    render(<RuntimeProfilesManager projectId={PROJECT_ID} canWrite={false} />);

    const button = screen.getByRole('button', { name: 'Edit profiles' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});
