import { createWorkspace, type CreateWorkspaceInput, type KortixProject } from '@kortix/sdk';

/** A new workspace's provision input: no `account_id`, the server picks it. */
export type NewWorkspaceInput = CreateWorkspaceInput;

/**
 * Create a whole workspace in one request: `POST /v1/projects/provision` with
 * `new_workspace: true`. The server reuses the caller's newest owned account
 * with no project (a plan or credits already there stay), else creates one,
 * then provisions its project (Workspaces D3). A restricted self-host answers
 * `403 account_creation_restricted` when a new account would be needed.
 *
 * For the hosts that create a workspace outside `/new` (a marketplace item, a
 * use-case template). The SDK's `createWorkspace` carries the flag.
 */
export function provisionNewWorkspace(input: NewWorkspaceInput): Promise<KortixProject> {
  return createWorkspace(input);
}
