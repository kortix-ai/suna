import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
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
