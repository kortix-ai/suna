// V1 membership-sync shims. The V1 engine derived a member's permissions
// from rows in iam_policies, so every change to account_members or
// project_members fanned out into matching policy rows. V2 reads
// account_members.account_role and project_members.project_role
// directly — no policy fan-out is needed.
//
// Rather than churn every call site at once, we keep the signatures as
// no-ops here. The existing callers (accounts/index.ts, accounts/invites.ts,
// projects/index.ts) keep compiling and their await statements just resolve
// immediately. Callers can be cleaned up incrementally.
//
// `backfillMembershipPolicies` was the boot-time job that retro-actively
// synced the same data on first run after IAM landed. Also a no-op now.
//
// `seedSystemRoles` seeded the V1 16-system-role catalog into the
// iam_roles table. V2 hard-codes role permissions in
// iam/role-perms.ts, so there's nothing to seed. The function stays
// callable as a no-op so the boot routine in apps/api/src/index.ts
// keeps its existing wiring; cleanup of that call site is a follow-up.

export async function syncMemberAccountPolicy(_args: {
  accountId: string;
  userId: string;
  accountRole: string;
  createdBy: string;
}): Promise<void> {
  // no-op: V2 reads account_members.account_role directly
}

export async function removeMemberPolicies(
  _accountId: string,
  _userId: string,
): Promise<void> {
  // no-op: V2 reads account_members directly
}

export async function removeProjectPoliciesForMember(
  _accountId: string,
  _userId: string,
): Promise<void> {
  // no-op: V2 reads project_members directly
}

export async function syncProjectMemberPolicy(_args: {
  accountId: string;
  projectId: string;
  userId: string;
  projectRole: string;
  createdBy: string;
}): Promise<void> {
  // no-op: V2 reads project_members.project_role directly
}

export async function removeProjectMemberPolicy(
  _accountId: string,
  _projectId: string,
  _userId: string,
): Promise<void> {
  // no-op: V2 reads project_members directly
}

export async function backfillMembershipPolicies(): Promise<{
  policiesInserted: number;
  membersBackfilled: number;
}> {
  // no-op: nothing to backfill on V2
  return { policiesInserted: 0, membersBackfilled: 0 };
}

export async function backfillAccountMembershipPolicies(
  _accountId: string,
): Promise<{ policiesInserted: number; membersBackfilled: number }> {
  // no-op: nothing to backfill on V2
  return { policiesInserted: 0, membersBackfilled: 0 };
}

export async function seedSystemRoles(): Promise<void> {
  // no-op: V2 hard-codes role permissions in iam/role-perms.ts
}
