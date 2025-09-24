import { createClient } from '@/lib/supabase/client';
import { handleApiError } from './error-handler';

interface AuthErrorHandler {
  isAuthError: (error: any) => boolean;
  handleAuthError: (error: any) => Promise<void>;
  refreshAuth: () => Promise<boolean>;
}

class AuthErrorHandlerImpl implements AuthErrorHandler {
  private supabase = createClient();
  private refreshAttempts = 0;
  private maxRefreshAttempts = 2;

  isAuthError(error: any): boolean {
    if (!error) return false;
    
    const status = error.status || error.response?.status;
    const message = error.message?.toLowerCase() || '';
    
    return (
      status === 401 ||
      status === 403 ||
      message.includes('api key') ||
      message.includes('invalid key') ||
      message.includes('authentication') ||
      message.includes('unauthorized') ||
      message.includes('token') ||
      message.includes('session')
    );
  }

  async handleAuthError(error: any): Promise<void> {
    if (!this.isAuthError(error)) {
      return;
    }

    console.warn('Authentication error detected:', error);

    // Try to refresh the session first
    const refreshed = await this.refreshAuth();
    
    if (!refreshed) {
      // If refresh failed, redirect to login or show appropriate message
      this.handleAuthFailure();
    }
  }

  async refreshAuth(): Promise<boolean> {
    if (this.refreshAttempts >= this.maxRefreshAttempts) {
      console.warn('Max refresh attempts reached');
      return false;
    }

    try {
      this.refreshAttempts++;
      const { data, error } = await this.supabase.auth.refreshSession();
      
      if (error) {
        console.error('Session refresh failed:', error);
        return false;
      }

      if (data.session) {
        console.log('Session refreshed successfully');
        this.refreshAttempts = 0; // Reset attempts on success
        return true;
      }

      return false;
    } catch (error) {
      console.error('Session refresh error:', error);
      return false;
    }
  }

  private handleAuthFailure(): void {
    // Clear any cached authentication data
    this.clearAuthCache();
    
    // Show user-friendly error message
    handleApiError({
      message: 'Authentication session expired',
      status: 401,
    }, {
      operation: 'authenticate',
      resource: 'user session'
    });

    // Optionally redirect to login page
    // You can uncomment this if you want automatic redirect
    // window.location.href = '/auth/login';
  }

  private clearAuthCache(): void {
    try {
      // Clear any cached API responses that might contain stale auth data
      if ('caches' in window) {
        caches.keys().then(cacheNames => {
          cacheNames.forEach(cacheName => {
            if (cacheName.includes('api') || cacheName.includes('auth')) {
              caches.delete(cacheName);
            }
          });
        });
      }
    } catch (error) {
      console.warn('Failed to clear auth cache:', error);
    }
  }
}

export const authErrorHandler = new AuthErrorHandlerImpl();

// Utility function to wrap API calls with auth error handling
export const withAuthErrorHandling = async <T>(
  apiCall: () => Promise<T>,
  context?: { operation?: string; resource?: string }
): Promise<T> => {
  try {
    return await apiCall();
  } catch (error) {
    await authErrorHandler.handleAuthError(error);
    
    // Re-throw the error if it's not an auth error or if auth handling didn't resolve it
    throw error;
  }
};

export default authErrorHandler;
