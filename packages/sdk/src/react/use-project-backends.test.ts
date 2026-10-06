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

const { projectBackendsKey, useProjectBackends } = await import('./use-project-backends');

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
});
