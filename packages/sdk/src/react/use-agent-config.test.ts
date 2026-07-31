import { beforeEach, describe, expect, mock, test } from 'bun:test';

let invalidated: unknown[][] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey);
    },
  }),
}));

const { agentConfigKey, useAgentConfig, useAgentConfigMutations } = await import(
  './use-agent-config'
);

beforeEach(() => {
  invalidated = [];
});

describe('useAgentConfig', () => {
  test('uses a stable project and agent scoped query key', () => {
    const result = useAgentConfig('proj-1', 'support') as any;
    expect(result.queryKey).toEqual(agentConfigKey('proj-1', 'support'));
    expect(result.enabled).toBe(true);
    expect((useAgentConfig(null, 'support') as any).enabled).toBe(false);
    expect((useAgentConfig('proj-1', null) as any).enabled).toBe(false);
  });
});

describe('useAgentConfigMutations', () => {
  test('invalidates config, project config, project detail, visible agents, and change requests after writes', () => {
    const result = useAgentConfigMutations('proj-1') as any;

    result.create.onSuccess({ agent_name: 'reliance-cto' });
    result.repairBehavior.onSuccess({ agent_name: 'support' });

    expect(invalidated).toEqual([
      ['project-agent-config', 'proj-1', 'reliance-cto'],
      ['project-config', 'proj-1'],
      ['project-detail', 'proj-1'],
      ['project-detail', 'proj-1', 'agents'],
      ['project-change-requests', 'proj-1'],
      ['project-agent-config', 'proj-1', 'support'],
      ['project-config', 'proj-1'],
      ['project-detail', 'proj-1'],
      ['project-detail', 'proj-1', 'agents'],
      ['project-change-requests', 'proj-1'],
    ]);
    expect(result.preview.mutationFn).toBeFunction();
  });
});
