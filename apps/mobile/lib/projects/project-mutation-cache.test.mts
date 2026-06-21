import test from 'node:test';
import assert from 'node:assert/strict';

import { invalidateAfterProjectCreation } from './project-mutation-cache.ts';

test('project creation retries the previously failed sandbox query', () => {
  const invalidations: Array<readonly unknown[]> = [];
  const queryClient = {
    invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      invalidations.push(queryKey);
    },
  };

  invalidateAfterProjectCreation(queryClient);

  assert.deepEqual(invalidations, [
    ['projects'],
    ['platform', 'sandbox'],
  ]);
});
