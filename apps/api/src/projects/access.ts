// The coarse `read | session | write | members | credentials` alias
// vocabulary that `loadProjectForUser` speaks, and the project-role label fold.
//
// NOT an authorization source. Every GATE is `authorize()` /
// `assertProjectCapability` with a catalog leaf.
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
export type ProjectAccessAction =
  | 'read'
  | 'session'
  | 'write'
  | 'members'
  | 'credentials';

export function effectiveProjectRole(
  accountRole: AccountRole,
  projectRole: ProjectRole | null,
): ProjectRole | null {
  if (isAccountManager(accountRole)) return 'manager';
  return projectRole;
}
