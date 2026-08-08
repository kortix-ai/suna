import { expect, test } from 'bun:test';

import {
  clearProjectProviderCache,
  projectSecretsKey,
  useKortixRouteProjectId,
  useProjectConfig,
} from './index';
import {
  clearWorkspaceProviderCache,
  useKortixRouteWorkspaceId,
  useWorkspaceConfig,
  workspaceSecretsKey,
} from './workspace-compat';

test('Workspace React exports are direct aliases of the current Project implementation', () => {
  expect(clearWorkspaceProviderCache).toBe(clearProjectProviderCache);
  expect(useKortixRouteWorkspaceId).toBe(useKortixRouteProjectId);
  expect(useWorkspaceConfig).toBe(useProjectConfig);
  expect(workspaceSecretsKey).toBe(projectSecretsKey);
});
