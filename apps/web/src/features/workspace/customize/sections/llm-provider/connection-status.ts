/**
 * ONE status vocabulary for every connection surface — the Models page rows
 * (`connection-row.tsx`), the two-door connect modal (`connect-model-modal.tsx`),
 * and (once consumed) the Step-3 `CredentialRecord` health. The point is that
 * a credential reads the SAME word wherever it appears: a user must never see
 * "Needs attention" in one place and "Unavailable" in another for the same
 * underlying state (coordinator UX note #3).
 *
 * `variant` maps onto `Badge`'s tokens (kortix-* semantics, never raw palette).
 */
import type { ModelsPageConnectionStatus } from '@kortix/sdk/react';

export type StatusBadgeVariant = 'success' | 'destructive' | 'secondary';

export interface StatusBadge {
  label: string;
  variant: StatusBadgeVariant;
}

/** The canonical words. Everything below resolves into one of these. */
export const CONNECTION_STATUS = {
  connected: { label: 'Connected', variant: 'success' } satisfies StatusBadge,
  expired: { label: 'Expired', variant: 'destructive' } satisfies StatusBadge,
  needsAttention: { label: 'Needs attention', variant: 'destructive' } satisfies StatusBadge,
  unavailable: { label: 'Unavailable', variant: 'destructive' } satisfies StatusBadge,
  checking: { label: 'Checking', variant: 'secondary' } satisfies StatusBadge,
} as const;

/** The per-connection status the Models page + composer already resolve
 *  (`ModelsPageConnection.status`). */
export function connectionStatusBadge(status: ModelsPageConnectionStatus): StatusBadge {
  switch (status) {
    case 'ready':
      return CONNECTION_STATUS.connected;
    case 'needs-attention':
      return CONNECTION_STATUS.needsAttention;
    case 'unavailable':
      return CONNECTION_STATUS.unavailable;
    default:
      return CONNECTION_STATUS.checking;
  }
}

/** The Step-3 `CredentialRecord.status` enum (healthy | expired | invalid |
 *  unverified | absent) resolved into the SAME vocabulary — so when the
 *  `/auth-providers` typed health is threaded onto the door rows it reads
 *  identically to the Models page. `absent` has no badge (nothing connected). */
export type CredentialStatus = 'healthy' | 'expired' | 'invalid' | 'unverified' | 'absent';

export function credentialStatusBadge(status: CredentialStatus): StatusBadge | null {
  switch (status) {
    case 'healthy':
      return CONNECTION_STATUS.connected;
    case 'expired':
      return CONNECTION_STATUS.expired;
    case 'invalid':
      return CONNECTION_STATUS.needsAttention;
    case 'unverified':
      return CONNECTION_STATUS.checking;
    default:
      return null;
  }
}
