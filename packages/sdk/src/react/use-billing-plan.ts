import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  acceptEnterpriseOffer,
  type AcceptEnterpriseOfferParams,
  type AcceptEnterpriseOfferResult,
  setBillingPlan,
  type SetBillingPlanParams,
  type SetBillingPlanResult,
} from '../core/rest/projects-client/billing';

/**
 * Subscribe to, or change, the credits plan. Variables are
 * {@link SetBillingPlanParams}; the result is the {@link SetBillingPlanResult}
 * union (redirect to `checkout_url` on `checkout_created`). Invalidates the
 * account state on success so credits and plan refresh.
 */
export function useSetBillingPlan() {
  const queryClient = useQueryClient();
  return useMutation<SetBillingPlanResult, Error, SetBillingPlanParams>({
    mutationFn: setBillingPlan,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account-state'] });
    },
  });
}

/**
 * Accept the account's open Enterprise offer: resolves to a Stripe Checkout
 * link (redirect to `checkout_url`). Needs `billing.write` (owners and admins).
 */
export function useAcceptEnterpriseOffer() {
  return useMutation<AcceptEnterpriseOfferResult, Error, AcceptEnterpriseOfferParams>({
    mutationFn: acceptEnterpriseOffer,
  });
}
