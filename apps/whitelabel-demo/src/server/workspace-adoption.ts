/**
 * Importing an EXISTING account workspace into this demo user.
 *
 * Why this needs a gate at all: in wrapper mode one server-held `KORTIX_API_KEY`
 * can reach every workspace in the Kortix account. The `/workspaces` list is
 * therefore filtered to the workspaces this end-user provisioned through the demo
 * (`filterWorkspacesList` → `listOwnedWorkspaces`), because otherwise every signed-in
 * Lumen user would see — and be able to open — every workspace the operator owns.
 * That filter is the wrapper's tenancy boundary, not an oversight.
 *
 * But it makes the demo useless for testing against a workspace that already has
 * connectors, secrets and history: those were created in the Kortix dashboard, so
 * the demo has no record of them and shows an empty list.
 *
 * The deployment-level switch defaults to off.
 * Not a per-user permission — this app's login accepts any email with any
 * password, so an allowlist of addresses would name a user without
 * authenticating one. The honest statement is about the DEPLOYMENT ("this
 * instance is a single-tenant demo, so letting the signed-in user adopt the
 * operator's own workspaces harms nobody"), and it cannot be bypassed by choosing
 * a different email because it never consults identity.
 *
 * A real product would not have this at all: its end-users would never be
 * offered the operator's workspaces, under any flag.
 */

const ADOPTION_ENV_VAR = 'LUMEN_ALLOW_WORKSPACE_IMPORT';
const LEGACY_ADOPTION_ENV_VAR = 'LUMEN_ALLOW_PROJECT_IMPORT';

export function workspaceImportEnabled(): boolean {
  const raw = (
    process.env[ADOPTION_ENV_VAR] ??
    process.env[LEGACY_ADOPTION_ENV_VAR] ??
    ''
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export const WORKSPACE_IMPORT_ENV_VAR = ADOPTION_ENV_VAR;
/** @deprecated Use `LUMEN_ALLOW_WORKSPACE_IMPORT`. */
export const LEGACY_PROJECT_IMPORT_ENV_VAR = LEGACY_ADOPTION_ENV_VAR;

export interface ImportableWorkspace {
  workspace_id: string;
  name: string;
  /** True when this demo user already owns it — shown as already-imported rather
   *  than hidden, so the list matches what the operator sees in the dashboard. */
  imported: boolean;
}

/**
 * Split the account's workspaces into what this user may import.
 *
 * Pure so the decision is testable without a server: the route supplies the
 * upstream list and the user's owned set.
 */
export function selectImportableWorkspaces(
  accountWorkspaces: Array<{ workspace_id?: unknown; name?: unknown }> | undefined,
  ownedWorkspaceIds: readonly string[],
): ImportableWorkspace[] {
  const owned = new Set(ownedWorkspaceIds);
  return (accountWorkspaces ?? [])
    .map((workspace) => ({
      workspace_id:
        typeof workspace.workspace_id === 'string' ? workspace.workspace_id : '',
      name: typeof workspace.name === 'string' ? workspace.name : '',
      imported: false,
    }))
    .filter((workspace) => workspace.workspace_id.length > 0)
    .map((workspace) => ({ ...workspace, imported: owned.has(workspace.workspace_id) }))
    .sort((a, b) => {
      // Not-yet-imported first — those are the actionable rows.
      if (a.imported !== b.imported) return a.imported ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
}
