import { expect, test } from 'bun:test';

import {
  ensureProjectConnectorConnection,
  listAccounts,
  listProjectSessions,
  projectSessionStartSeed,
  updateProjectDefaultAgent,
} from '../projects-client';
import {
  ensureWorkspaceConnectorProfile,
  listWorkspaceSessions,
  updateWorkspaceDefaultAgent,
  workspaceSessionStartSeed,
} from './compat';
import * as PublishedWorkspaceClient from '../../../deprecated/workspaces-client';

test('Workspace compatibility exports are direct aliases of the current Project implementation', () => {
  expect(ensureWorkspaceConnectorProfile).toBe(ensureProjectConnectorConnection);
  expect(listWorkspaceSessions).toBe(listProjectSessions);
  expect(updateWorkspaceDefaultAgent).toBe(updateProjectDefaultAgent);
  expect(workspaceSessionStartSeed).toBe(projectSessionStartSeed);
});

test('the published Workspace subpath retains the full current REST client', () => {
  expect(PublishedWorkspaceClient.listAccounts).toBe(listAccounts);
});
