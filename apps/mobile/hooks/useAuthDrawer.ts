import { useCallback } from 'react';
import { useAuthContext } from '@/contexts';

/**
 * Custom hook to manage auth drawer interactions
 * 
 * Use this to check auth state and trigger auth when needed
 * 
 * @example
 * const { requireAuth } = useAuthDrawer();
 * 
 * const handleSaveChat = () => {
 *   requireAuth(() => {
 *     // This only runs if user is authenticated
 *     saveChat();
 *   });
 * };
 */
export function useAuthDrawer() {
  const { isAuthenticated, user } = useAuthContext();

  /**
   * Execute a function only if user is authenticated
   * Returns true if authenticated, false if not (and auth should be triggered)
   */
  const requireAuth = useCallback(
    (callback?: () => void): boolean => {
      if (isAuthenticated) {
        callback?.();
        return true;
      }
      
      console.log('🔐 Authentication required');
      // Auth drawer will be shown by parent component
      return false;
    },
    [isAuthenticated]
  );

  /**
   * Check if user has specific permissions or tier
   */
  const hasPermission = useCallback(
    (permission: string): boolean => {
      if (!isAuthenticated) return false;
      
      // Add your permission logic here
      // For now, just check if user exists
      return !!user;
    },
    [isAuthenticated, user]
  );

  return {
    isAuthenticated,
    user,
    requireAuth,
    hasPermission,
  };
}

