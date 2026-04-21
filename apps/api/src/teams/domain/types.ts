export type AccountRole = 'owner' | 'admin' | 'member';

export type SandboxAction =
  | 'view'
  | 'execute'
  | 'write'
  | 'lifecycle'
  | 'rename'
  | 'delete'
  | 'manage_members';

export interface Membership {
  accountId: string;
  role: AccountRole;
}

export interface SandboxMember {
  sandboxId: string;
  userId: string;
  email: string | null;
  /** Role in the sandbox's own account. Null when the user has a
   * sandbox_members row but is no longer part of the account (edge case). */
  accountRole: AccountRole | null;
  addedBy: string | null;
  addedAt: Date;
}

export interface SandboxInvite {
  inviteId: string;
  sandboxId: string;
  accountId: string;
  email: string;
  invitedBy: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface SandboxRef {
  sandboxId: string;
  accountId: string;
}

export interface AccessDecision {
  allowed: boolean;
  reason:
    | 'platform_admin'
    | 'account_manager'
    | 'sandbox_member'
    | 'not_member'
    | 'not_found';
}
