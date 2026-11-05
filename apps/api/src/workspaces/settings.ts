/**
 * The settings block of `GET /v1/workspaces/:workspaceId`: what the account
 * key holds for the workspace (MFA, session and token policy, branding,
 * automations, setup state), read from `kortix.workspaces`.
 */
import { effectiveBranding } from '../accounts/branding';
import { accountMemberRoleRow, countBillableAccountMembers } from '../iam/membership-read';
import { getWorkspace } from './store';

export interface WorkspaceSettings {
  workspace_id: string;
  account_id: string;
  /** True while the workspace's legacy account still holds other projects. */
  split_pending: boolean;
  member_count: number;
  /**
   * The caller's role in the workspace's account (`owner`, `admin`, `member`),
   * or null when the caller reaches the workspace through a project grant
   * only. The SDK derives the workspace role from it and the project role.
   */
  account_role: string | null;
  mfa_required: boolean;
  session_max_lifetime_minutes: number | null;
  session_idle_timeout_minutes: number | null;
  pat_max_lifetime_days: number | null;
  pat_require_expiry: boolean;
  pat_idle_revoke_days: number | null;
  admins_see_all_sessions: boolean;
  automations_paused_at: string | null;
  setup_complete_at: string | null;
  branding: Awaited<ReturnType<typeof effectiveBranding>>;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** `null` when the id is not an active workspace. */
export async function readWorkspaceSettings(
  workspaceId: string,
  callerUserId?: string | null,
): Promise<WorkspaceSettings | null> {
  const row = await getWorkspace(workspaceId);
  if (!row) return null;
  const [members, branding, roleRows] = await Promise.all([
    countBillableAccountMembers(row.accountId),
    effectiveBranding(row.accountId, row.branding),
    callerUserId ? accountMemberRoleRow(row.accountId, callerUserId) : Promise.resolve([]),
  ]);
  const countRows =
    (members as unknown as { rows?: Array<{ n: number }> }).rows ??
    (members as unknown as Array<{ n: number }>);
  return {
    workspace_id: row.workspaceId,
    account_id: row.accountId,
    split_pending: row.splitPending,
    member_count: Number(countRows?.[0]?.n ?? 0),
    account_role: roleRows[0]?.accountRole ?? null,
    mfa_required: row.mfaRequired ?? false,
    session_max_lifetime_minutes: row.sessionMaxLifetimeMinutes ?? null,
    session_idle_timeout_minutes: row.sessionIdleTimeoutMinutes ?? null,
    pat_max_lifetime_days: row.patMaxLifetimeDays ?? null,
    pat_require_expiry: row.patRequireExpiry ?? false,
    pat_idle_revoke_days: row.patIdleRevokeDays ?? null,
    admins_see_all_sessions: row.adminsSeeAllSessions ?? false,
    automations_paused_at: iso(row.automationsPausedAt),
    setup_complete_at: iso(row.setupCompleteAt),
    branding,
  };
}
