import { useMutation } from '@tanstack/react-query';
import { useAuthContext } from '@/contexts';
import { API_URL, getAuthHeaders } from '@/api/config';

/**
 * Account Initialization Hook
 * 
 * Matches frontend implementation using React Query mutation.
 * Should be called explicitly when account initialization is needed.
 * 
 * @example
 * const initializeMutation = useAccountInitialization();
 * initializeMutation.mutate(undefined, {
 *   onSuccess: () => console.log('Account initialized'),
 *   onError: (error) => console.error('Failed:', error),
 * });
 */
export function useAccountInitialization() {
  const { session } = useAuthContext();

  return useMutation({
    mutationFn: async (): Promise<{ success: boolean; message: string; subscription_id?: string }> => {
      if (!session) {
        throw new Error('You must be logged in to initialize account');
      }

      console.log('🚀 Initializing account...');
      const headers = await getAuthHeaders();
      
      const response = await fetch(`${API_URL}/setup/initialize`, {
        method: 'POST',
        headers,
      });

      // Handle non-OK responses
      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        try {
          const errorData = await response.json();
          if (errorData.detail) {
            errorMessage = errorData.detail;
          } else if (errorData.message) {
            errorMessage = errorData.message;
          }
        } catch {
          // If response is not JSON, use status text
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      console.log('📦 Account initialization response:', data);

      // Check if initialization was successful
      if (data.success) {
        console.log('✅ Account initialized successfully');
        return {
          success: true,
          message: data.message || 'Account initialized successfully',
          subscription_id: data.subscription_id,
        };
      } else {
        // Handle "already initialized" case
        if (data.message?.includes('Already subscribed') || data.message?.includes('already')) {
          console.log('✅ Account already initialized');
          return {
            success: true,
            message: 'Account already initialized',
            subscription_id: data.subscription_id,
          };
        }
        
        throw new Error(data.message || 'Failed to initialize account');
      }
    },
  });
}

