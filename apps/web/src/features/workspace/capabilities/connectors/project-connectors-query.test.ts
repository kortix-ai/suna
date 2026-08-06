import { describe, expect, test } from 'bun:test';
import { qk } from '@kortix/sdk/react';

import { PROJECT_CONNECTORS_STALE_MS, projectConnectorsQuery } from './project-connectors-query';

describe('projectConnectorsQuery', () => {
  test('reuses cached connectors and refreshes them after ten seconds', () => {
    const options = projectConnectorsQuery('project-1');

    expect(options.queryKey).toEqual(qk.project.connectors('project-1'));
    expect(options.staleTime).toBe(PROJECT_CONNECTORS_STALE_MS);
    expect(options.refetchOnMount).toBe(true);
  });
});
