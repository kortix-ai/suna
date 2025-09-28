"use client";

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useGetAAL } from '@/hooks/react-query/phone-verification';
import { useAuth } from '@/components/AuthProvider';

interface BackgroundAALCheckerProps {
  children: React.ReactNode;
  redirectTo?: string;
  enabled?: boolean;
}

/**
 * BackgroundAALChecker runs MFA checks silently in the background without blocking the UI.
 * 
 * Only redirects when:
 * - New users (created after cutoff) who don't have MFA enrolled
 * - Users who have MFA enrolled but need verification
 * - Users who need to reauthenticate due to MFA changes
 * 
 * Does NOT show loading states or block the UI - runs entirely in background.
 */
export function BackgroundAALChecker({ 
  children, 
  redirectTo = '/auth/phone-verification',
  enabled = true 
}: BackgroundAALCheckerProps) {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  
  // Only run queries if user is authenticated and check is enabled
  const { data: aalData } = useGetAAL();

  useEffect(() => {
    // Only check if user is authenticated, not loading, and checks are enabled
    if (!authLoading && user && enabled && aalData) {
      const { action_required, current_level, next_level, verification_required } = aalData;

      // Only redirect if the user is trying to access protected routes
      // Allow users to stay on the home page "/" even if phone verification fails
      const isProtectedRoute = pathname.startsWith('/dashboard') || 
                              pathname.startsWith('/agents') || 
                              pathname.startsWith('/projects') ||
                              pathname.startsWith('/settings');
      
      if (!isProtectedRoute) {
        return;
      }

      // Handle new users who need phone verification enrollment
      if (verification_required) {
        if (current_level === "aal1" && next_level === "aal1") {
          router.push(redirectTo);
          return;
        }
        // If new user has MFA enrolled, follow standard AAL flow below
      }

      // Standard AAL flow (for all users)
      switch (action_required) {
        case 'verify_mfa':
          // User has MFA enrolled but needs to verify it
          router.push(redirectTo);
          break;
        
        case 'reauthenticate':
          // User has stale JWT due to MFA changes, force reauthentication
          router.push('/auth?message=Please sign in again due to security changes');
          break;
        
        case 'none':
          // No action required, user can proceed
          break;
        
        case 'unknown':
        default:
          // Unknown AAL state, log and allow access (fail open)
          console.warn('Background: Unknown AAL state:', { current_level, next_level, action_required });
          break;
      }
    }
  }, [user, authLoading, enabled, aalData, router, redirectTo, pathname]);

  // Always render children immediately - no loading states
  return <>{children}</>;
} 