/**
 * Admin billing hooks. The API removed every `/v1/billing/admin/*` route; credit
 * grants and debits live on the admin accounts routes (`useAdminGrantCredits`,
 * `useAdminDebitCredits`). These hooks stay exported until the next major and
 * fail with `ENDPOINT_RETIRED` without sending a request.
 */
import { useRetiredMutation, useRetiredQuery } from './retired-endpoint';

interface CreditAdjustmentRequest {
  account_id: string;
  amount: number;
  reason: string;
  is_expiring: boolean;
  notify_user: boolean;
}

interface RefundRequest {
  account_id: string;
  amount: number;
  reason: string;
  is_expiring: boolean;
  stripe_refund: boolean;
  payment_intent_id?: string;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useUserBillingSummary(userId: string | null) {
  return useRetiredQuery<any>('useUserBillingSummary', ['admin', 'billing', 'user', userId], !!userId);
}

interface TransactionParams {
  userId: string;
  page?: number;
  page_size?: number;
  type_filter?: string;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useAdminUserTransactions(params: TransactionParams) {
  return useRetiredQuery<any>('useAdminUserTransactions', ['admin', 'billing', 'transactions', params.userId, params.page, params.page_size, params.type_filter], !!params.userId);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useAdjustCredits() {
  return useRetiredMutation<any, CreditAdjustmentRequest>('useAdjustCredits');
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useProcessRefund() {
  return useRetiredMutation<any, RefundRequest>('useProcessRefund');
}
