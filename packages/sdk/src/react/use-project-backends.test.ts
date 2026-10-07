import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { qk } from './query-keys';

let invalidated: (readonly unknown[])[] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (options: { queryKey: readonly unknown[] }) =>
      invalidated.push(options.queryKey),
  }),
}));

const { projectBackendsKey, useProjectBackends, useProjectBackendBackups } = await import('./use-project-backends');

beforeEach(() => {
  invalidated = [];
});

describe('Kortix Backends React Query bindings', () => {
  test('uses a stable project-scoped query key and is disabled without a project', () => {
    expect((useProjectBackends('project-1') as any).queryKey).toEqual(projectBackendsKey('project-1'));
    expect(projectBackendsKey('project-1')).toEqual(qk.project.backends('project-1'));
    expect((useProjectBackends(null) as any).enabled).toBe(false);
  });

  test('create and remove invalidate the backend list', () => {
    const backends = useProjectBackends('project-1') as any;
    backends.create.onSuccess();
    backends.remove.onSuccess();
    expect(invalidated).toEqual([qk.project.backends('project-1'), qk.project.backends('project-1')]);
  });

  test('polls the list while any backend has an operation or is provisioning', () => {
    const interval = (useProjectBackends('project-1') as any).refetchInterval;
    const poll = (rows: object[]) => interval({ state: { data: rows } });
    expect(poll([{ status: 'running', operation: null }])).toBe(false);
    expect(poll([{ status: 'running', operation: 'resizing' }])).toBe(2_000);
    expect(poll([{ status: 'provisioning', operation: null }])).toBe(2_000);
  });

  test('resize, restore and rotateAdminKey invalidate the backend list', () => {
    const backends = useProjectBackends('project-1') as any;
    backends.resize.onSuccess();
    backends.restore.onSuccess();
    backends.rotateAdminKey.onSuccess();
    expect(invalidated).toEqual([
      qk.project.backends('project-1'),
      qk.project.backends('project-1'),
      qk.project.backends('project-1'),
    ]);
  });

  test('backups query is keyed per backend, disabled without one, and a snapshot refreshes it', () => {
    const backups = useProjectBackendBackups('project-1', 'b1', true) as any;
    expect(backups.queryKey).toEqual(qk.project.backendBackups('project-1', 'b1'));
    expect((useProjectBackendBackups('project-1', 'b1', false) as any).enabled).toBe(false);
    backups.snapshot.onSuccess();
    expect(invalidated).toEqual([qk.project.backendBackups('project-1', 'b1')]);
  });
});
