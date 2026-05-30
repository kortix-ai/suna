// Shared IAM test mocks. The real IAM engine + membership-sync hit
// iam_roles/iam_policies/account_groups tables that the suites' lightweight db
// mocks don't model, so authz-agnostic suites bypass them here instead of
// re-declaring the same blocks in every file.
//
// Paths are relative to THIS file (src/__tests__/helpers/), so '../../iam/...'
// resolves to src/iam/... — the same module the suites import as '../iam/...'.
import { mock } from 'bun:test';

/** No-op the IAM policy-sync writes (project/member grant + revoke). */
export function mockIamMembershipSyncNoop(): void {
  mock.module('../../iam/membership-sync', () => ({
    syncMemberAccountPolicy: async () => {},
    removeMemberPolicies: async () => {},
    removeProjectPoliciesForMember: async () => {},
    syncProjectMemberPolicy: async () => {},
    removeProjectMemberPolicy: async () => {},
  }));
}

/** Bypass the IAM engine, allowing every action. Use only in suites that are
 *  NOT testing authz denial — those keep a role-aware engine mock.
 *
 *  `authorize` / `assertAuthorized` / `listAccessibleResources` are re-exported
 *  from `../iam` via `./dispatcher` (the V1 engine + flag-routing were retired),
 *  so the mock MUST target the dispatcher — mocking the old `./engine` is a
 *  dead no-op and lets the real V2 engine hit unmocked account-group tables. */
export function mockIamEngineAllowAll(): void {
  mock.module('../../iam/dispatcher', () => ({
    authorize: async () => ({ allowed: true }),
    assertAuthorized: async () => {},
    listAccessibleResources: async () => ({ mode: 'all', ids: [] }),
  }));
}
