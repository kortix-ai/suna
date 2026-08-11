'use client';

import { successToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import { invalidateAccountState } from '@/hooks/billing';
import { fireConfetti } from '@/lib/confetti';
import { latestProjectPath } from '@/lib/onboarding/last-project-cookie';
import { syncSubscription } from '@kortix/sdk';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

/**
 * Coming back from Stripe.
 *
 * Stripe returns the browser to a `success_url` carrying a marker param. The
 * webhook has already done the real work server-side; all the client owes the
 * user is a refreshed wallet and an acknowledgement.
 *
 * This used to be two near-identical 25-line effects inlined in the projects
 * LIST page — which is why every checkout return had to land on `/projects`,
 * the one place in the product that is deliberately never a destination. The
 * handling is route-independent now (mounted once in the `(app)` layout), so a
 * return can land wherever the user actually belongs.
 */
export type BillingReturn = {
  /** Query param Stripe echoes back. */
  param: string;
  /** Value that marks success. Anything else is ignored. */
  value: string;
  /** Re-read whatever the webhook changed. Must be idempotent. May be sync. */
  settle: (queryClient: QueryClient) => void | Promise<void>;
  title: string;
  description: string;
};

const RETURNS = [
  {
    param: 'team_signup',
    value: 'success',
    // syncSubscription pulls the new plan across before the wallet is re-read,
    // so the toast never lands ahead of the state it is announcing.
    settle: async (queryClient) => {
      await syncSubscription();
      await invalidateAccountState(queryClient);
    },
    title: 'Subscription activated',
    description: 'Your team is on dosco. Compute and LLM credits are ready.',
  },
  {
    param: 'credit_purchase',
    value: 'success',
    settle: (queryClient) => invalidateAccountState(queryClient, true),
    title: 'Credits added',
    description: 'Your top-up landed — compute and the latest AI models are ready to go.',
  },
] as const satisfies readonly BillingReturn[];

export const BILLING_RETURNS: readonly BillingReturn[] = RETURNS;

/** The marker params this module owns — a closed set, not an open string. */
export type BillingReturnParam = (typeof RETURNS)[number]['param'];

/** For callers that must carry a return across their own redirect. */
export const BILLING_RETURN_PARAMS: readonly string[] = RETURNS.map((r) => r.param);

/**
 * Build the absolute `success_url` to hand Stripe.
 *
 * Producer and consumer live in one file on purpose. When the handling lived in
 * the projects page, "where does a checkout return land" was an implicit
 * consequence of where the effect happened to be mounted, and every producer
 * hardcoded `/projects` to match it. Now the destination is a decision, made
 * once, here: the user's latest project — never the list.
 */
export function useBillingReturnUrl(): (param: BillingReturnParam) => string {
  const { user } = useAuth();
  return useCallback(
    (param: BillingReturnParam) => {
      const url = new URL(latestProjectPath(user?.id), window.location.origin);
      url.searchParams.set(param, 'success');
      return url.toString();
    },
    [user?.id],
  );
}

function stripParam(param: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete(param);
  window.history.replaceState(null, '', url.toString());
}

/**
 * Runs the matching billing return, once, then strips the param so a refresh
 * cannot replay the celebration.
 *
 * Failure is deliberately quiet: the money already moved and the webhook is
 * authoritative, so a failed client refresh is a stale number, not a lost
 * purchase. Invalidate anyway and let the next fetch correct it.
 */
export function useBillingReturn(): void {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const match = BILLING_RETURNS.find((r) => searchParams.get(r.param) === r.value);
    if (!match || handled.current === match.param) return;
    handled.current = match.param;

    let cancelled = false;
    void (async () => {
      try {
        await match.settle(queryClient);
        if (cancelled) return;
        fireConfetti();
        successToast(match.title, { description: match.description });
      } catch {
        invalidateAccountState(queryClient);
      } finally {
        stripParam(match.param);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams, queryClient]);
}

/** Mount once, app-wide. Renders nothing. */
export function BillingReturnWatcher() {
  useBillingReturn();
  return null;
}
