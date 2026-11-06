import { createWorkspace, type CreateWorkspaceInput, type KortixProject } from '@kortix/sdk';

/** A new workspace's provision input: no `account_id`, the server picks it. */
export type NewWorkspaceInput = CreateWorkspaceInput;

/**
 * Create a whole workspace in one request: `POST /v1/projects/provision` with
 * `new_workspace: true`. The server creates a new account the caller owns,
 * then provisions its project (Workspaces D3; a retry with the same
 * idempotency key returns the same workspace). A restricted self-host answers
 * `403 account_creation_restricted` when a new account would be needed.
 *
 * For the hosts that create a workspace outside `/workspaces/new` (a marketplace item, a
 * use-case template). The SDK's `createWorkspace` carries the flag.
 */
export function provisionNewWorkspace(input: NewWorkspaceInput): Promise<KortixProject> {
  return createWorkspace(input);
}
