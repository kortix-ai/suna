import { createClient } from '@/lib/supabase/client';
import { handleApiError, handleNetworkError, ErrorContext, ApiError } from './error-handler';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export interface ApiClientOptions {
  showErrors?: boolean;
  errorContext?: ErrorContext;
  timeout?: number;
}

export interface ApiResponse<T = any> {
  data?: T;
  error?: ApiError;
  success: boolean;
}

// Internal request handler
async function makeRequest<T = any>(
  url: string,
  options: RequestInit & ApiClientOptions = {}
): Promise<ApiResponse<T>> {
  const {
    showErrors = true,
    errorContext,
    timeout = 30000,
    ...fetchOptions
  } = options;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...fetchOptions.headers as Record<string, string>,
    };

    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    if (session?.refresh_token) {
      headers['X-Refresh-Token'] = session.refresh_token;
    }

    const response = await fetch(url, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      let errorData: any = null;

      try {
        errorData = await response.json();
        if (errorData.message) {
          errorMessage = errorData.message;
        }
      } catch {
      }

      const error: ApiError = Object.assign(Object.create(Error.prototype), {
        message: errorMessage,
        name: 'ApiError',
        status: response.status,
        response: response,
        details: errorData || undefined,
        code: errorData?.code || response.status.toString()
      });

      if (showErrors) {
        handleApiError(error, errorContext);
      }

      return {
        error,
        success: false,
      };
    }

    let data: T;
    const contentType = response.headers.get('content-type');
    
    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else if (contentType?.includes('text/')) {
      data = await response.text() as T;
    } else {
      data = await response.blob() as T;
    }

    return {
      data,
      success: true,
    };

  } catch (error: any) {
    let apiError: ApiError;
    
    if (error?.name === 'AbortError') {
      apiError = Object.assign(Object.create(Error.prototype), {
        message: 'Request timeout',
        name: 'ApiError',
        code: 'TIMEOUT'
      });
    } else if (error instanceof Error) {
      apiError = Object.assign(Object.create(Error.prototype), {
        message: error.message,
        name: error.name || 'ApiError',
        stack: error.stack
      });
    } else {
      apiError = Object.assign(Object.create(Error.prototype), {
        message: String(error),
        name: 'ApiError'
      });
    }

    if (showErrors) {
      handleNetworkError(apiError, errorContext);
    }

    return {
      error: apiError,
      success: false,
    };
  }
}

export const supabaseClient = {
  async execute<T = any>(
    queryFn: () => Promise<{ data: T | null; error: any }>,
    errorContext?: ErrorContext
  ): Promise<ApiResponse<T>> {
    try {
      const { data, error } = await queryFn();

      if (error) {
        const apiError: ApiError = Object.assign(Object.create(Error.prototype), {
          message: error.message || 'Database error',
          name: 'ApiError',
          code: error.code,
          details: error
        });

        handleApiError(apiError, errorContext);

        return {
          error: apiError,
          success: false,
        };
      }

      return {
        data: data as T,
        success: true,
      };
    } catch (error: any) {
      const apiError: ApiError = error instanceof Error 
        ? Object.assign(Object.create(Error.prototype), {
            message: error.message,
            name: error.name || 'ApiError',
            stack: error.stack
          })
        : Object.assign(Object.create(Error.prototype), {
            message: String(error),
            name: 'ApiError'
          });
      
      handleApiError(apiError, errorContext);

      return {
        error: apiError,
        success: false,
      };
    }
  },
};

export const backendApi = {
  get: <T = any>(endpoint: string, options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>) =>
    makeRequest<T>(`${API_URL}${endpoint}`, { ...options, method: 'GET' }),

  post: <T = any>(endpoint: string, data?: any, options?: Omit<RequestInit & ApiClientOptions, 'method'>) =>
    makeRequest<T>(`${API_URL}${endpoint}`, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }),

  put: <T = any>(endpoint: string, data?: any, options?: Omit<RequestInit & ApiClientOptions, 'method'>) =>
    makeRequest<T>(`${API_URL}${endpoint}`, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    }),

  patch: <T = any>(endpoint: string, data?: any, options?: Omit<RequestInit & ApiClientOptions, 'method'>) =>
    makeRequest<T>(`${API_URL}${endpoint}`, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    }),

  delete: <T = any>(endpoint: string, options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>) =>
    makeRequest<T>(`${API_URL}${endpoint}`, { ...options, method: 'DELETE' }),

  upload: <T = any>(endpoint: string, formData: FormData, options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>) => {
    const { headers, ...restOptions } = options || {};
    const uploadHeaders = { ...headers as Record<string, string> };
    delete uploadHeaders['Content-Type'];

    return makeRequest<T>(`${API_URL}${endpoint}`, {
      ...restOptions,
      method: 'POST',
      body: formData,
      headers: uploadHeaders,
    });
  },
}; 