import { useEffect } from 'react';
import { useAuthContext } from '@/contexts';
import { usePushNotifications } from '@/hooks/useNotifications';

/**
 * Component to setup push notifications when user is authenticated
 * This should be placed inside the AuthProvider in the app layout
 */
export function PushNotificationSetup() {
  const { isAuthenticated } = useAuthContext();
  
  // Setup push notifications hook (registers and handles notifications)
  usePushNotifications();
  
  return null;
}
