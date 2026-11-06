/**
 * The one line a person with no workspace reads. A new user belongs to no
 * workspace (no account is created at signup). The API answers `409
 * {code:'no_workspace'}` for an action that needs one — minting a key, the CLI
 * device approval — and `GET /accounts/me` lists no account: every one of
 * those paths prints this line.
 */
export const NO_WORKSPACE_LINE =
  'No workspace yet. Create one with kortix workspaces create <name>, or accept an invite.';

/** The API's error code for "this needs a workspace and the caller has none". */
export const NO_WORKSPACE_CODE = 'no_workspace';

/**
 * The same fact at sign-in, where `kortix workspaces create` cannot run yet:
 * the CLI holds no key until a workspace exists, so the fix is the web.
 */
export function noWorkspaceLoginLine(webBase: string): string {
  return `No workspace yet. Create one at ${webBase.replace(/\/+$/, '')}/workspaces/new, or accept an invite, then run kortix login again.`;
}
