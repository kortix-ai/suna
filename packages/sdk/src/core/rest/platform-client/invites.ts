/**
 * Platform API client — sandbox invite accept/decline.
 */

import { platformFetch } from './shared';

// Visible form — viewer is the intended recipient, so all details are returned.
export interface InviteDetailsVisible {
  invite_id: string;
  sandbox_id: string;
  sandbox_name: string | null;
  email: string;
  inviter_email: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  email_matches_caller: true;
  expired: boolean;
}

// Redacted form — viewer is signed in as someone else. We never leak which
// account or address an invite belongs to if the viewer isn't the recipient.
export interface InviteDetailsRedacted {
  invite_id: string;
  sandbox_id: null;
  sandbox_name: null;
  email: null;
  inviter_email: null;
  created_at: null;
  expires_at: null;
  accepted_at: string | null;
  email_matches_caller: false;
  expired: boolean;
}

export type InviteDetails = InviteDetailsVisible | InviteDetailsRedacted;

export async function getInvite(inviteId: string): Promise<InviteDetails> {
  const result = await platformFetch<InviteDetails>(
    `/platform/invites/${encodeURIComponent(inviteId)}`,
    { method: 'GET' },
  );
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Invite not found');
  }
  return result.data;
}

export async function acceptInvite(inviteId: string): Promise<{ status: string; sandbox_id: string }> {
  const result = await platformFetch<{ status: string; sandbox_id: string }>(
    `/platform/invites/${encodeURIComponent(inviteId)}/accept`,
    { method: 'POST' },
  );
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to accept invite');
  }
  return result.data;
}

export async function declineInvite(inviteId: string): Promise<void> {
  const result = await platformFetch<void>(
    `/platform/invites/${encodeURIComponent(inviteId)}/decline`,
    { method: 'POST' },
  );
  if (!result.success) {
    throw new Error(result.error || 'Failed to decline invite');
  }
}
