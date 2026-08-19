import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { backendApi } from '../core/http/api-client';
import {
  clearImpersonationSession,
  getImpersonationSession,
  setImpersonationSession,
  subscribeToImpersonation,
  type ImpersonationSession,
} from '../core/http/impersonation';

/**
 * React surface over the act-as store. The data logic (storage, expiry,
 * header injection) lives in `core/http/impersonation`; these three hooks are
 * the only React that knows about it, so the host renders a banner and a
 * button and nothing else.
 */

/** Wire path of the mint route. */
export const ADMIN_IMPERSONATE_PATH = '/admin/api/impersonate';

/** Wire path of the revoke route for one grant. */
export function adminImpersonateRevokePath(grantId: string): string {
  return `${ADMIN_IMPERSONATE_PATH}/${encodeURIComponent(grantId)}`;
}

/** Wire path of the caller's live grants. */
export const ADMIN_IMPERSONATE_ACTIVE_PATH = `${ADMIN_IMPERSONATE_PATH}/active`;

/** What `POST /admin/api/impersonate` answers. */
export interface AdminImpersonateResponse {
  grant_id: string;
  account_id: string;
  account_name?: string | null;
  /** ISO-8601. Server-capped at one hour — the client never chooses it. */
  expires_at: string;
}

/**
 * The current act-as session, or null. Subscribes to the store, so a banner
 * built on it disappears by itself when the grant expires or is exited from
 * another component.
 */
export function useImpersonation(): ImpersonationSession | null {
  return useSyncExternalStore(
    subscribeToImpersonation,
    getImpersonationSession,
    // Server render: never acting as an account. The store is per-tab
    // `sessionStorage`, which does not exist during SSR, and claiming a session
    // there would flash a banner for an operator who has none.
    () => null,
  );
}

/**
 * Start acting as an account. On success the session is stored, which makes
 * every subsequent request from this tab carry the grant header — so the
 * caller navigates to the app shell and nothing else needs wiring.
 *
 * The whole React Query cache is cleared, not invalidated: every cached entry
 * was fetched as the OPERATOR, and re-serving one inside a customer's session
 * would show the operator's own data under the customer's banner.
 */
export function useAdminImpersonate() {
  const queryClient = useQueryClient();
  return useMutation<AdminImpersonateResponse, Error, { accountId: string; reason?: string }>({
    mutationFn: async ({ accountId, reason }) => {
      const body: Record<string, unknown> = { account_id: accountId };
      if (reason) body.reason = reason;
      const response = await backendApi.post<AdminImpersonateResponse>(
        ADMIN_IMPERSONATE_PATH,
        body,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    onSuccess: (data) => {
      setImpersonationSession({
        grantId: data.grant_id,
        accountId: data.account_id,
        accountName: data.account_name ?? null,
        expiresAt: data.expires_at,
      });
      queryClient.clear();
    },
  });
}

/**
 * Stop acting. Revokes server-side FIRST, then clears the local session — in
 * that order, because a client that forgot the grant id can no longer revoke
 * it, and the row would stay live for the rest of its hour.
 *
 * A failed revoke still clears locally: the operator asked to leave, and the
 * grant expires on its own. The error is surfaced so the caller can say so.
 */
export function useStopImpersonation() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean } | null, Error, { grantId?: string } | void>({
    mutationFn: async (variables) => {
      const grantId = variables?.grantId ?? getImpersonationSession()?.grantId;
      if (!grantId) return null;
      try {
        const response = await backendApi.delete<{ ok: boolean }>(
          adminImpersonateRevokePath(grantId),
        );
        if (response.error) throw new Error(response.error.message);
        return response.data ?? { ok: true };
      } finally {
        clearImpersonationSession();
        queryClient.clear();
      }
    },
  });
}
