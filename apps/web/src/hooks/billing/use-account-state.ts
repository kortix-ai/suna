'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * Unified Account State Hook
 *
 * Single source of truth for all billing data:
 * - Credits (total, daily, monthly, extra)
 * - Subscription (tier, status, billing period)
 * - Available models
 * - Limits (projects, threads, concurrent runs)
 *
 * Replaces: useSubscription, useCreditBalance, useBillingStatus, useScheduledChanges
 */

import { errorToast, successToast } from '@/components/ui/toast';
import { shouldQueryAccountState } from '@/hooks/billing/account-state-gating';
import { useBillingAccountId, useBillingAccountResolved } from '@/stores/billing-account-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  cancelSubscription,
  createPortalSession,
  getAccountState,
  purchaseCredits,
  reactivateSubscription,
  syncSubscription,
  type AccountState,
} from '@kortix/sdk';
import { dollarsToCredits } from '@kortix/shared';

export type { AccountState };

export interface CreatePortalSessionRequest {
  return_url: string;
}

export interface PurchaseCreditsRequest {
  amount: number;
  success_url: string;
  cancel_url: string;
}

export interface CancelSubscriptionRequest {
  feedback?: string;
}

// =============================================================================
// QUERY KEYS - Single key for all billing state
// =============================================================================

export const accountStateKeys = {
  all: ['account-state'] as const,
  // Scope each query by accountId. `undefined` means "the user's primary
  // account" (resolved server-side from the auth user) — used by global
  // surfaces like the user menu. /accounts/[id] pages pass the explicit id so
  // multi-account users don't see the same wallet/limits across all pages.
  state: (accountId?: string | null) =>
    [...accountStateKeys.all, 'state', { accountId: accountId ?? null }] as const,
  transactions: (limit?: number, offset?: number) =>
    [...accountStateKeys.all, 'transactions', { limit, offset }] as const,
};

// =============================================================================
// UTILITY - Invalidation helper for mutations
// =============================================================================

// Forced refetches are debounced and deduplicated per QueryClient and per
// account slot (KRTX-2414). One module-wide timer and promise let a second
// account cancel the first account's pending refetch, and skip its own while
// the first one ran.
type QueryClientLike = ReturnType<typeof useQueryClient>;
interface RefetchSlot {
  timeout: ReturnType<typeof setTimeout> | null;
  /** A caller in this window asked to bypass the server cache: the most aggressive wins. */
  skipCache: boolean;
  active: Promise<void> | null;
}
const refetchSlots = new WeakMap<QueryClientLike, Map<string, RefetchSlot>>();
const REFETCH_DEBOUNCE_MS = 200;

function refetchSlot(queryClient: QueryClientLike, accountId?: string): RefetchSlot {
  let slots = refetchSlots.get(queryClient);
  if (!slots) refetchSlots.set(queryClient, (slots = new Map()));
  const key = accountId ?? '';
  let slot = slots.get(key);
  if (!slot) slots.set(key, (slot = { timeout: null, skipCache: false, active: null }));
  return slot;
}

export function invalidateAccountState(
  queryClient: QueryClientLike,
  refetch = false,
  skipCache = false,
  accountId?: string,
) {
  // Invalidate the query cache (marks data as stale). Per-account queries
  // have their own cache slot (see accountStateKeys.state).
  queryClient.invalidateQueries({ queryKey: accountStateKeys.state(accountId) });
  // Also invalidate the global (primary-account) slot when a per-account
  // mutation lands — global surfaces should reflect the new state too if
  // they happen to point at the same account.
  if (accountId) {
    queryClient.invalidateQueries({ queryKey: accountStateKeys.state() });
  }

  if (!refetch) return;

  const slot = refetchSlot(queryClient, accountId);
  if (skipCache) slot.skipCache = true;

  // This slot is already fetching: keep the skipCache preference for its next refetch.
  if (slot.active) return;

  // Debounce to batch rapid calls for this slot into one.
  if (slot.timeout) clearTimeout(slot.timeout);
  slot.timeout = setTimeout(() => {
    const shouldSkipCache = slot.skipCache;
    slot.skipCache = false;
    slot.timeout = null;
    slot.active = (async () => {
      if (shouldSkipCache) {
        // Bypass the server cache: write fresh data straight into the slot.
        const freshData = await getAccountState({ skipCache: true, accountId });
        queryClient.setQueryData(accountStateKeys.state(accountId), freshData);
      } else {
        // Normal refetch — React Query deduplicates across components.
        await queryClient.refetchQueries({ queryKey: accountStateKeys.state(accountId), type: 'active' });
      }
    })()
      // A failed refresh keeps the stale data; the next request tries again.
      .catch(() => undefined)
      .finally(() => {
        slot.active = null;
      });
  }, REFETCH_DEBOUNCE_MS);
}

// =============================================================================
// MAIN HOOK - Single query for all billing data
// =============================================================================

interface UseAccountStateOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchOnMount?: boolean;
  refetchOnWindowFocus?: boolean;
  skipCache?: boolean; // Skip backend cache (useful after checkout/subscription changes)
  /** Fetch a specific account's state. Defaults to the user's primary account.
   *  `null` (no account selected yet) reads the same slot as `undefined`. */
  accountId?: string | null;
}

/**
 * Unified hook for all account billing state.
 *
 * This replaces:
 * - useSubscription()
 * - useCreditBalance()
 * - useBillingStatus()
 * - useScheduledChanges()
 * - useAvailableModels() (models are now in account state)
 *
 * The data is cached for 10 minutes and only refetched when:
 * - A mutation occurs (upgrade, downgrade, purchase, etc.)
 * - User explicitly refreshes
 * - Agent run completes (credits deducted)
 */
export function useAccountState(options?: UseAccountStateOptions) {
  // Explicit option wins; fall back to the nearest BillingAccountProvider so
  // any consumer inside /accounts/[id] is automatically scoped without
  // every call site having to pass the id by hand.
  const contextAccountId = useBillingAccountId();
  const contextResolved = useBillingAccountResolved();
  const accountId = options?.accountId ?? contextAccountId;
  // Hold the query until the surface knows whose account it is; fetching the
  // primary account as a stand-in only to swap cache slots is what made every
  // presence-driven billing UI paint, unpaint, and paint again on cold load.
  const enabled = shouldQueryAccountState({
    enabled: options?.enabled ?? true,
    hasExplicitAccountId: options?.accountId !== undefined,
    contextResolved,
  });

  return useQuery<AccountState>({
    queryKey: accountStateKeys.state(accountId),
    queryFn: () => getAccountState({ skipCache: options?.skipCache ?? false, accountId }),
    enabled,
    staleTime: options?.staleTime ?? 1000 * 60 * 2,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: options?.refetchOnWindowFocus ?? false,
    // 'always' caused a fetch on every component mount (6+ consumers).
    // Use true instead: only refetches if data is stale (past staleTime).
    refetchOnMount: options?.refetchOnMount ?? true,
    refetchOnReconnect: true,
    structuralSharing: true,
    retry: enabled
      ? (failureCount, error) => {
          const message = (error as Error).message || '';
          if (message.includes('401') || message.includes('403')) {
            return false;
          }
          return failureCount < 2;
        }
      : false,
  });
}

// =============================================================================
// MUTATION HOOKS - All invalidate account state after success
// =============================================================================

// A paid plan is chosen and changed through `useChangeCreditPlan`
// (`features/billing/use-change-credit-plan.ts`), which wraps the SDK's
// `useSetBillingPlan`. There is no seat checkout and no claim flow.

export function useCreatePortalSession() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const accountId = useBillingAccountId();
  return useMutation({
    mutationFn: (params: CreatePortalSessionRequest) =>
      createPortalSession(params.return_url, accountId),
    onSuccess: (data) => {
      const portalUrl = data?.portal_url || (data as any)?.url;
      if (portalUrl) {
        window.location.href = portalUrl;
      } else {
        errorToast(tI18nComplete.raw('text6a4c0b695fe4'));
      }
    },
    onError: (error: any) => {
      errorToast(error?.message || tI18nComplete.raw('text7a098b3b9a9d'));
    },
  });
}

function useBillingAction<TRequest, TResponse extends { success: boolean; message: string }>(
  mutationFn: (accountId: string | undefined, request: TRequest) => Promise<TResponse>,
  errorKey: string,
  options: { successKey?: string; refetch?: boolean } = {},
) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const accountId = useBillingAccountId();

  return useMutation({
    mutationFn: (request: TRequest) => mutationFn(accountId, request),
    onSuccess: (response) => {
      invalidateAccountState(queryClient, options.refetch ?? true, false, accountId); // Refetch to show updated state
      if (options.successKey) {
        successToast(tI18nComplete.raw(options.successKey));
      } else if (response.success) {
        successToast(response.message);
      } else {
        errorToast(response.message);
      }
    },
    onError: (error: any) => {
      errorToast(error.message || tI18nComplete.raw(errorKey));
    },
  });
}

export function useCancelSubscription() {
  return useBillingAction((accountId, request?: CancelSubscriptionRequest) => cancelSubscription(request?.feedback, accountId), 'text2b41749fceaa');
}

export function useReactivateSubscription() {
  return useBillingAction((accountId) => reactivateSubscription(accountId), 'text5051e9e23edf');
}

export function usePurchaseCredits() {
  const queryClient = useQueryClient();
  const accountId = useBillingAccountId();

  return useMutation({
    mutationFn: (request: PurchaseCreditsRequest) =>
      purchaseCredits({
        accountId,
        amount: request.amount,
        successUrl: request.success_url,
        cancelUrl: request.cancel_url,
      }),
    onSuccess: (data) => {
      // Will redirect to checkout - invalidation happens on return via backend
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    },
  });
}

export function useSyncSubscription() {
  return useBillingAction((accountId) => syncSubscription(accountId), 'textf3d331b82d30', { successKey: 'text24db9f4eb779', refetch: false });
}

// `useTransactions` (rich variant with typeFilter) lives in `./use-transactions`
// and is the only one actually used by the BillingTab history block. The
// previous duplicate here was a thin wrapper that the index re-exported but
// nothing imported — removed to avoid two hooks with the same name backed by
// different cache keys.

// =============================================================================
// SELECTORS - Helper functions to extract specific data from account state
// =============================================================================

export const accountStateSelectors = {
  /** Get total credits (converted from dollars to credits using 1$ = 100 credits) */
  totalCredits: (state: AccountState | undefined) => dollarsToCredits(state?.credits?.total ?? 0),

  /** Get tier key */
  tierKey: (state: AccountState | undefined) => state?.subscription?.tier_key ?? 'none',

};
