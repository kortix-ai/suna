import { useEffect, useState } from 'react';
import { useAuthContext } from '@/contexts';
import { API_URL, getAuthHeaders } from '@/api/config';

export function useAccountInitialization() {
  const { isAuthenticated, session } = useAuthContext();
  const [isInitializing, setIsInitializing] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initializeAccount = async () => {
      if (!isAuthenticated || !session?.user || isInitializing || isInitialized) {
        return;
      }

      try {
        console.log('🚀 Checking if account needs initialization...');
        setIsInitializing(true);

        const headers = await getAuthHeaders();
        const response = await fetch(`${API_URL}/setup/initialize`, {
          method: 'POST',
          headers,
        });

        const data = await response.json();

        if (response.ok && data.success) {
          console.log('✅ Account initialized successfully');
          setIsInitialized(true);
        } else {
          if (data.message?.includes('Already subscribed')) {
            console.log('✅ Account already initialized');
            setIsInitialized(true);
          } else {
            console.error('❌ Account initialization failed:', data.message);
            setError(data.message || 'Initialization failed');
          }
        }
      } catch (err) {
        console.error('❌ Account initialization error:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setIsInitializing(false);
      }
    };

    initializeAccount();
  }, [isAuthenticated, session, isInitializing, isInitialized]);

  return {
    isInitializing,
    isInitialized,
    error,
  };
}

