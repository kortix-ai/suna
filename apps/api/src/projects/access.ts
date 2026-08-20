// Display-tier helpers for the project routes: the coarse
// `read | session | write | manage | members | credentials` alias vocabulary
// that `loadProjectForUser` speaks, and the boolean it renders into
// `can_manage` / `canManageProject` response fields.
//
// NOT an authorization source. Every GATE is `authorize()` /
// `assertProjectCapability` with a catalog leaf; these answer "should the UI
// show the manage affordance", which is a LABEL on a verdict already taken.
//
// The effective-access FOLD that used to live here — `foldEffectiveProjectAccess`,
// one of the four independent copies of "the strongest role wins" the cutover
// collapsed — is now `foldProjectAccess` in `iam/read-models.ts`, over
// `kortix.role_assignments`.
//
// `member` is the floor project role (renamed from `user`); the retired `user`
// and `viewer` tiers fold into it — see `normalizeProjectRole` in iam/roles.ts,
// the canonical parser (this module keeps no copy).
import { isAccountManager, type AccountRole, type ProjectRole } from '../iam/roles';

export type { AccountRole, ProjectRole };
export { isAccountManager };

// The coarse aliases `loadProjectForUser` accepts. They survive ONLY as that
// function's parameter mapping onto real catalog leaves (see
// `iamActionForProjectAccess`) — nothing else in the system speaks them.
//
// 'session' sits between 'read' and 'write': any project member (a plain
// `member` included) may start and run sessions, but not customize the project.
// 'members' and 'credentials' split the old blanket 'manage', which mapped to
// `project.write` and therefore gated neither member administration nor
// credential issuance (routes.md §5.1/§5.2).
export type ProjectAccessAction =
  | 'read'
  | 'session'
  | 'write'
  | 'manage'
  | 'members'
  | 'credentials';

export function roleAllows(role: ProjectRole | null, action: ProjectAccessAction): boolean {
  if (!role) return false;
  if (action === 'read') return true;
  // Every project role can use sessions — `member` is the base *usable* role.
  if (action === 'session') return true;
  // write / manage / members / credentials are all manager-tier.
  return role === 'manager';
}

export function effectiveProjectRole(
  accountRole: AccountRole,
  projectRole: ProjectRole | null,
): ProjectRole | null {
  if (isAccountManager(accountRole)) return 'manager';
  return projectRole;
}
