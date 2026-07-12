import { beforeAll, describe, expect, mock, test } from 'bun:test';

mock.module('@tanstack/react-query', () => ({
  useMutation: (config: Record<string, unknown>) => config,
  useQuery: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    removeQueries: () => undefined,
  }),
}));

let hooks: typeof import('./sessions');
beforeAll(async () => { hooks = await import('./sessions'); });

describe('removed harness-native session commands', () => {
  test('compaction does not call a native harness session API', async () => {
    const mutation = hooks.useSummarizeRuntimeSession() as unknown as {
      mutationFn: (input: { sessionId: string }) => Promise<unknown>;
    };
    await expect(mutation.mutationFn({ sessionId: 'session-1' })).rejects.toThrow(
      'Session compaction is not part of the ACP protocol',
    );
  });

  test('project initialization is expressed as an ACP prompt', async () => {
    const mutation = hooks.useInitSession() as unknown as {
      mutationFn: (input: { sessionId: string }) => Promise<unknown>;
    };
    await expect(mutation.mutationFn({ sessionId: 'session-1' })).rejects.toThrow(
      'Use an ACP prompt to initialize the project',
    );
  });
});
