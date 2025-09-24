import { createClient } from '@/lib/supabase/client';

interface ApiKeyValidationResult {
  isValid: boolean;
  error?: string;
  shouldRefresh?: boolean;
}

class ApiKeyValidator {
  private supabase = createClient();

  /**
   * Validates the current session and API key
   */
  async validateSession(): Promise<ApiKeyValidationResult> {
    try {
      const { data: { session }, error } = await this.supabase.auth.getSession();
      
      if (error) {
        return {
          isValid: false,
          error: 'Session validation failed',
          shouldRefresh: true,
        };
      }

      if (!session) {
        return {
          isValid: false,
          error: 'No active session found',
          shouldRefresh: true,
        };
      }

      // Check if token is expired
      const now = Math.floor(Date.now() / 1000);
      if (session.expires_at && session.expires_at < now) {
        return {
          isValid: false,
          error: 'Session expired',
          shouldRefresh: true,
        };
      }

      return { isValid: true };
    } catch (error) {
      console.error('Session validation error:', error);
      return {
        isValid: false,
        error: 'Session validation failed',
        shouldRefresh: true,
      };
    }
  }

  /**
   * Attempts to refresh the session
   */
  async refreshSession(): Promise<ApiKeyValidationResult> {
    try {
      const { data, error } = await this.supabase.auth.refreshSession();
      
      if (error) {
        return {
          isValid: false,
          error: 'Session refresh failed',
        };
      }

      if (!data.session) {
        return {
          isValid: false,
          error: 'No session after refresh',
        };
      }

      return { isValid: true };
    } catch (error) {
      console.error('Session refresh error:', error);
      return {
        isValid: false,
        error: 'Session refresh failed',
      };
    }
  }

  /**
   * Performs a test API call to validate the current authentication
   */
  async testApiConnection(): Promise<ApiKeyValidationResult> {
    try {
      const { data: { session } } = await this.supabase.auth.getSession();
      
      if (!session) {
        return {
          isValid: false,
          error: 'No session available for API test',
        };
      }

      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/health`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (response.ok) {
        return { isValid: true };
      }

      if (response.status === 401) {
        return {
          isValid: false,
          error: 'API authentication failed',
          shouldRefresh: true,
        };
      }

      return {
        isValid: false,
        error: `API test failed with status ${response.status}`,
      };
    } catch (error) {
      console.error('API connection test error:', error);
      return {
        isValid: false,
        error: 'API connection test failed',
      };
    }
  }

  /**
   * Comprehensive validation that checks session and API connectivity
   */
  async validateComprehensive(): Promise<ApiKeyValidationResult> {
    // First check session validity
    const sessionResult = await this.validateSession();
    if (!sessionResult.isValid) {
      if (sessionResult.shouldRefresh) {
        const refreshResult = await this.refreshSession();
        if (!refreshResult.isValid) {
          return refreshResult;
        }
      } else {
        return sessionResult;
      }
    }

    // Then test API connectivity
    const apiResult = await this.testApiConnection();
    if (!apiResult.isValid && apiResult.shouldRefresh) {
      const refreshResult = await this.refreshSession();
      if (refreshResult.isValid) {
        // Retry API test after refresh
        return await this.testApiConnection();
      }
      return refreshResult;
    }

    return apiResult;
  }
}

export const apiKeyValidator = new ApiKeyValidator();

// Utility function to wrap API calls with validation
export const withApiKeyValidation = async <T>(
  apiCall: () => Promise<T>,
  options: { 
    validateBeforeCall?: boolean;
    retryOnAuthError?: boolean;
    maxRetries?: number;
  } = {}
): Promise<T> => {
  const {
    validateBeforeCall = false,
    retryOnAuthError = true,
    maxRetries = 1,
  } = options;

  let attempts = 0;

  while (attempts <= maxRetries) {
    try {
      // Optional pre-call validation
      if (validateBeforeCall) {
        const validation = await apiKeyValidator.validateComprehensive();
        if (!validation.isValid) {
          throw new Error(validation.error || 'API key validation failed');
        }
      }

      return await apiCall();
    } catch (error: any) {
      attempts++;

      // Check if it's an auth error and we should retry
      if (
        retryOnAuthError && 
        attempts <= maxRetries && 
        (error?.status === 401 || error?.message?.toLowerCase().includes('api key'))
      ) {
        console.log(`Auth error detected, attempting refresh (attempt ${attempts}/${maxRetries})`);
        
        const refreshResult = await apiKeyValidator.refreshSession();
        if (!refreshResult.isValid) {
          throw new Error(refreshResult.error || 'Session refresh failed');
        }
        
        continue; // Retry the API call
      }

      throw error;
    }
  }

  throw new Error('Max retry attempts exceeded');
};

export default apiKeyValidator;
