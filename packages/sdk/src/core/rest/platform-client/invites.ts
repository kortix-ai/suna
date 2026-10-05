/**
 * Platform API client — sandbox invite accept/decline.
 *
 * The API removed `/v1/platform/invites/*` with the account-level sandbox.
 * Invitations are account and project invites now (`listAccountInvites`,
 * `acceptAccountInvite`). These exports remain for import compatibility until
 * the next major.
 */

import { retiredEndpointError } from '../../http/api/errors';

const INSTEAD = 'Use the account invite functions (acceptAccountInvite, declineAccountInvite).';

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

/** @deprecated Sandbox invites were removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function getInvite(_inviteId: string): Promise<InviteDetails> {
  throw retiredEndpointError('getInvite', INSTEAD);
}

/** @deprecated Sandbox invites were removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function acceptInvite(_inviteId: string): Promise<{ status: string; sandbox_id: string }> {
  throw retiredEndpointError('acceptInvite', INSTEAD);
}

/** @deprecated Sandbox invites were removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function declineInvite(_inviteId: string): Promise<void> {
  throw retiredEndpointError('declineInvite', INSTEAD);
}
