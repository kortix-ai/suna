import { HTTPException } from "hono/http-exception";

/**
 * The typed refusal for a caller who belongs to no workspace: `409` with
 * `code: 'no_workspace'`. No account is ever created implicitly (Workspaces
 * D3, 2026-11-05): a new user has 0 workspaces until they create one
 * (`POST /v1/projects/provision` with `new_workspace: true`, or
 * `POST /v1/accounts`) or join one through an invite. Clients branch on the
 * code and show the create-or-join screen.
 */
export const NO_WORKSPACE_CODE = "no_workspace";
export const NO_WORKSPACE_MESSAGE = "Create or join a workspace first.";

/** The 409 `no_workspace` refusal. A subclass so callers can catch it by type. */
export class NoWorkspaceError extends HTTPException {
  readonly code = NO_WORKSPACE_CODE;
  constructor(message: string = NO_WORKSPACE_MESSAGE) {
    super(409, {
      message,
      res: new Response(
        JSON.stringify({ error: message, message, code: NO_WORKSPACE_CODE, status: 409 }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    });
  }
}

export function noWorkspaceError(message?: string): NoWorkspaceError {
  return new NoWorkspaceError(message);
}

export function isNoWorkspaceError(err: unknown): err is NoWorkspaceError {
  return err instanceof NoWorkspaceError;
}
