import { beforeEach, expect, mock, test } from 'bun:test';

const writes: unknown[][] = [];
const invalidations: unknown[] = [];
let failure = false;
let runtimeUrl = 'http://runtime-a';
let options: any;
let release: (() => void) | undefined;
let pending: Promise<void> | undefined;
mock.module('../core/rest/projects-client', () => ({
  setProjectSessionModel: async (...args: unknown[]) => {
    writes.push(args);
    await pending;
    if (failure) throw new Error('Not supported');
    return { opencode_model: args[2], applied_live: false, applies_to: 'next_prompt' };
  },
}));
mock.module('@tanstack/react-query', () => ({
  useMutation: (value: any) => {
    options = value;
    return { isPending: false, mutateAsync: async (variables: unknown) => {
      const result = await value.mutationFn(variables);
      await options.onSuccess(result, variables);
      return result;
    } };
  },
  useQueryClient: () => ({ invalidateQueries: async (value: unknown) => { invalidations.push(value); } }),
}));
mock.module('./use-current-runtime', () => ({ useCurrentRuntime: (select: (value: unknown) => unknown) => select({ url: runtimeUrl }) }));
mock.module('./use-opencode-config', () => ({ configKeys: { all: ['opencode', 'config'] } }));
const { useSessionModelChange } = await import('./use-session-model-change');
beforeEach(() => { writes.length = 0; invalidations.length = 0; failure = false; pending = undefined; runtimeUrl = 'http://runtime-a'; });

test('persists the platform session selection and refreshes its runtime and row', async () => {
  const mutation = useSessionModelChange('project-a', 'platform-session-a');
  await mutation.mutateAsync('kortix/model-b');
  expect(writes).toHaveLength(1);
  expect(writes[0]?.join('|')).toBe('project-a|platform-session-a|kortix/model-b');
  expect(invalidations).toContainEqual({ queryKey: ['opencode', 'config', 'http://runtime-a'] });
  expect(invalidations).toHaveLength(2);
});

test('a missing identity or failed save cannot claim a selected model', async () => {
  const absent = useSessionModelChange(undefined, undefined);
  await expect(absent.mutateAsync('kortix/model-b')).rejects.toThrow('Session identity is required');
  failure = true;
  const mutation = useSessionModelChange('project-a', 'platform-session-a');
  await expect(mutation.mutateAsync('kortix/model-b')).rejects.toThrow('Not supported');
  expect(invalidations).toHaveLength(0);
});

test('navigation during a save refreshes the original session only', async () => {
  pending = new Promise<void>(resolve => { release = resolve; });
  const mutation = useSessionModelChange('project-a', 'platform-session-a');
  const result = mutation.mutateAsync('kortix/model-b');
  runtimeUrl = 'http://runtime-b';
  useSessionModelChange('project-b', 'platform-session-b');
  release!();
  await result;
  expect(writes[0]?.join('|')).toBe('project-a|platform-session-a|kortix/model-b');
  expect(invalidations).toContainEqual({ queryKey: ['opencode', 'config', 'http://runtime-a'] });
  expect(invalidations).not.toContainEqual({ queryKey: ['opencode', 'config', 'http://runtime-b'] });
});
