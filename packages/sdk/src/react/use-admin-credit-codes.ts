import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '../core/http/api-client';

/** A credit code as the admin routes return it. Amounts are USD (1 USD = 100 credits). */
export interface AdminCreditCode {
  code_id: string;
  /** Upper case: `FRONTIER`. */
  code: string;
  amount_usd: number;
  /** Null: no limit on the number of accounts. */
  max_redemptions: number | null;
  redemption_count: number;
  /** ISO 8601; null: never expires. */
  expires_at: string | null;
  active: boolean;
  description: string | null;
  created_at: string;
}

export interface AdminCreateCreditCodeInput {
  code: string;
  amount_usd: number;
  max_redemptions?: number | null;
  expires_at?: string | null;
  description?: string | null;
}

export const ADMIN_CREDIT_CODES_PATH = '/admin/api/credit-codes';

export function adminCreditCodePath(codeId: string): string {
  return `${ADMIN_CREDIT_CODES_PATH}/${codeId}`;
}

const CREDIT_CODES_KEY = ['admin', 'credit-codes'] as const;

/** Every credit code, newest first (platform admins only). */
export function useAdminCreditCodes() {
  return useQuery<AdminCreditCode[]>({
    queryKey: CREDIT_CODES_KEY,
    queryFn: async () => {
      const response = await backendApi.get<{ codes: AdminCreditCode[] }>(ADMIN_CREDIT_CODES_PATH);
      if (response.error) throw response.error;
      return response.data!.codes;
    },
  });
}

/** Create a code. A taken code rejects with an `ApiError` whose code is `credit_code_exists`. */
export function useAdminCreateCreditCode() {
  const queryClient = useQueryClient();
  return useMutation<AdminCreditCode, Error, AdminCreateCreditCodeInput>({
    mutationFn: async (input) => {
      const response = await backendApi.post<{ code: AdminCreditCode }>(ADMIN_CREDIT_CODES_PATH, input, {
        showErrors: false,
      });
      if (response.error) throw response.error;
      return response.data!.code;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CREDIT_CODES_KEY }),
  });
}

/** Switch a code on or off. An off code reads as unknown to customers. */
export function useAdminSetCreditCodeActive() {
  const queryClient = useQueryClient();
  return useMutation<AdminCreditCode, Error, { codeId: string; active: boolean }>({
    mutationFn: async ({ codeId, active }) => {
      const response = await backendApi.patch<{ code: AdminCreditCode }>(adminCreditCodePath(codeId), { active });
      if (response.error) throw response.error;
      return response.data!.code;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CREDIT_CODES_KEY }),
  });
}
