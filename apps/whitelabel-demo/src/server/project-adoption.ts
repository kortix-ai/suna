/**
 * Importing an EXISTING account project into this demo user.
 *
 * Why this needs a gate at all: in wrapper mode one server-held `KORTIX_API_KEY`
 * can reach every project in the Kortix account. The `/projects` list is
 * therefore filtered to the projects this end-user provisioned through the demo
 * (`filterProjectsList` → `listOwnedProjects`), because otherwise every signed-in
 * Lumen user would see — and be able to open — every project the operator owns.
 * That filter is the wrapper's tenancy boundary, not an oversight.
 *
 * But it makes the demo useless for testing against a project that already has
 * connectors, secrets and history: those were created in the Kortix dashboard, so
 * the demo has no record of them and shows an empty list.
 *
 * So: a DEPLOYMENT-level switch, default off, exactly like the usage breakdown.
 * Not a per-user permission — this app's login accepts any email with any
 * password, so an allowlist of addresses would name a user without
 * authenticating one. The honest statement is about the DEPLOYMENT ("this
 * instance is a single-tenant demo, so letting the signed-in user adopt the
 * operator's own projects harms nobody"), and it cannot be bypassed by choosing
 * a different email because it never consults identity.
 *
 * A real product would not have this at all: its end-users would never be
 * offered the operator's projects, under any flag.
 */

const ADOPTION_ENV_VAR = 'LUMEN_ALLOW_PROJECT_IMPORT';

export function projectImportEnabled(): boolean {
  const raw = (process.env[ADOPTION_ENV_VAR] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export const PROJECT_IMPORT_ENV_VAR = ADOPTION_ENV_VAR;

export interface ImportableProject {
  project_id: string;
  name: string;
  /** True when this demo user already owns it — shown as already-imported rather
   *  than hidden, so the list matches what the operator sees in the dashboard. */
  imported: boolean;
}

/**
 * Split the account's projects into what this user may import.
 *
 * Pure so the decision is testable without a server: the route supplies the
 * upstream list and the user's owned set.
 */
export function selectImportableProjects(
  accountProjects: Array<{ project_id?: unknown; name?: unknown }> | undefined,
  ownedProjectIds: readonly string[],
): ImportableProject[] {
  const owned = new Set(ownedProjectIds);
  return (accountProjects ?? [])
    .map((project) => ({
      project_id: typeof project.project_id === 'string' ? project.project_id : '',
      name: typeof project.name === 'string' ? project.name : '',
      imported: false,
    }))
    .filter((project) => project.project_id.length > 0)
    .map((project) => ({ ...project, imported: owned.has(project.project_id) }))
    .sort((a, b) => {
      // Not-yet-imported first — those are the actionable rows.
      if (a.imported !== b.imported) return a.imported ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
}
