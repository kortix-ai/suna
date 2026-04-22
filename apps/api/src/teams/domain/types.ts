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
  accountRole: AccountRole | null;
  addedBy: string | null;
  addedAt: Date;
  monthlySpendCapCents: number | null;
  currentPeriodCents: number;
}

export interface SandboxInvite {
  inviteId: string;
  sandboxId: string;
  accountId: string;
  email: string;
  invitedBy: string | null;
  initialRole: AccountRole;
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
