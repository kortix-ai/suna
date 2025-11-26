import { useMutation } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { backendApi } from '@/lib/api-client';

/**
 * Account Initialization Hook (Fallback)
 * 
 * NOTE: Most users are initialized automatically via backend webhook on signup.
 * This hook is only used as a fallback if webhook failed or user signed up before
 * automatic initialization was implemented.
 */
export function useInitializeAccount() {
  return useMutation({
    mutationFn: async (): Promise<{ success: boolean; message: string; subscription_id?: string }> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('You must be logged in to initialize account');
      }
      const response = await backendApi.post(`/setup/initialize`);
      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to initialize account');
      }
      return response.data;
    },
    retry: false, // Don't retry on failure - initialization should only happen once
  });
}

