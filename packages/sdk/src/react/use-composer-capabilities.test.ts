import { describe, expect, test } from 'bun:test';

import { invalidateComposerCapabilityQueries } from './use-composer-capabilities';

describe('invalidateComposerCapabilityQueries', () => {
  test('invalidates every agent/auth/model dependency for a project', async () => {
    const invalidated: unknown[][] = [];
    await invalidateComposerCapabilityQueries({
      invalidateQueries: async ({ queryKey }: { queryKey: readonly unknown[] }) => {
        invalidated.push([...queryKey]);
      },
    }, 'project-1');

    expect(invalidated).toEqual([
      ['project', 'project-1'],
      ['project-llm-catalog', 'project-1'],
      ['project-secrets', 'project-1'],
      ['harness-connections', 'project-1'],
    ]);
  });
});
