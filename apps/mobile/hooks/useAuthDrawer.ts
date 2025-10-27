import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useAuthContext } from '@/contexts';

/**
 * Custom hook to manage auth navigation
 * 
 * Use this to check auth state and navigate to auth screens when needed
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
  const router = useRouter();

  /**
   * Execute a function only if user is authenticated
   * Returns true if authenticated, false if not (and navigates to auth)
   */
  const requireAuth = useCallback(
    (callback?: () => void): boolean => {
      if (isAuthenticated) {
        callback?.();
        return true;
      }
      
      console.log('🔐 Authentication required - navigating to sign in');
      router.push('/auth');
      return false;
    },
    [isAuthenticated, router]
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

