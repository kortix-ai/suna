import test from 'node:test';
import assert from 'node:assert/strict';

import { invalidateAfterWorkspaceCreation } from './workspace-mutation-cache.ts';

test('Workspace creation retries the previously failed sandbox query', () => {
  const invalidations: Array<readonly unknown[]> = [];
  const queryClient = {
    invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      invalidations.push(queryKey);
    },
  };

  invalidateAfterWorkspaceCreation(queryClient);

  assert.deepEqual(invalidations, [
    ['workspaces'],
    ['platform', 'sandbox'],
  ]);
});
