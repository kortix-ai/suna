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

// API Key Management Types
export interface APIKeyCreateRequest {
  title: string;
  description?: string;
  expires_in_days?: number;
}

export interface APIKeyResponse {
  key_id: string;
  public_key: string;
  title: string;
  description?: string;
  status: 'active' | 'revoked' | 'expired';
  expires_at?: string;
  last_used_at?: string;
  created_at: string;
}

export interface APIKeyCreateResponse {
  key_id: string;
  public_key: string;
  secret_key: string;
  title: string;
  description?: string;
  status: 'active' | 'revoked' | 'expired';
  expires_at?: string;
  created_at: string;
}

export const apiClient = {
  async request<T = any>(
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

        // Create a custom error object to avoid read-only property issues
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
        // Create custom error for timeout
        apiError = Object.assign(Object.create(Error.prototype), {
          message: 'Request timeout',
          name: 'ApiError',
          code: 'TIMEOUT'
        });
      } else if (error instanceof Error) {
        // Create a copy of the error to avoid read-only issues
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
  },

  get: async <T = any>(
    url: string,
    options: Omit<RequestInit & ApiClientOptions, 'method' | 'body'> = {}
  ): Promise<ApiResponse<T>> => {
    return apiClient.request<T>(url, {
      ...options,
      method: 'GET',
    });
  },

  post: async <T = any>(
    url: string,
    data?: any,
    options: Omit<RequestInit & ApiClientOptions, 'method'> = {}
  ): Promise<ApiResponse<T>> => {
    return apiClient.request<T>(url, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    });
  },

  put: async <T = any>(
    url: string,
    data?: any,
    options: Omit<RequestInit & ApiClientOptions, 'method'> = {}
  ): Promise<ApiResponse<T>> => {
    return apiClient.request<T>(url, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    });
  },

  patch: async <T = any>(
    url: string,
    data?: any,
    options: Omit<RequestInit & ApiClientOptions, 'method'> = {}
  ): Promise<ApiResponse<T>> => {
    return apiClient.request<T>(url, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    });
  },

  delete: async <T = any>(
    url: string,
    options: Omit<RequestInit & ApiClientOptions, 'method' | 'body'> = {}
  ): Promise<ApiResponse<T>> => {
    return apiClient.request<T>(url, {
      ...options,
      method: 'DELETE',
    });
  },

  upload: async <T = any>(
    url: string,
    formData: FormData,
    options: Omit<RequestInit & ApiClientOptions, 'method' | 'body'> = {}
  ): Promise<ApiResponse<T>> => {
    const { headers, ...restOptions } = options;
    
    const uploadHeaders = { ...headers as Record<string, string> };
    delete uploadHeaders['Content-Type'];

    return apiClient.request<T>(url, {
      ...restOptions,
      method: 'POST',
      body: formData,
      headers: uploadHeaders,
    });
  },
};

export const supabaseClient = {
  async execute<T = any>(
    queryFn: () => Promise<{ data: T | null; error: any }>,
    errorContext?: ErrorContext
  ): Promise<ApiResponse<T>> {
    try {
      const { data, error } = await queryFn();

      if (error) {
        // Create custom error object to avoid read-only property issues
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
      // Create a copy of the error to avoid read-only issues
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
    apiClient.get<T>(`${API_URL}${endpoint}`, options),

  post: <T = any>(endpoint: string, data?: any, options?: Omit<RequestInit & ApiClientOptions, 'method'>) =>
    apiClient.post<T>(`${API_URL}${endpoint}`, data, options),

  put: <T = any>(endpoint: string, data?: any, options?: Omit<RequestInit & ApiClientOptions, 'method'>) =>
    apiClient.put<T>(`${API_URL}${endpoint}`, data, options),

  patch: <T = any>(endpoint: string, data?: any, options?: Omit<RequestInit & ApiClientOptions, 'method'>) =>
    apiClient.patch<T>(`${API_URL}${endpoint}`, data, options),

  delete: <T = any>(endpoint: string, options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>) =>
    apiClient.delete<T>(`${API_URL}${endpoint}`, options),

  upload: <T = any>(endpoint: string, formData: FormData, options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>) =>
    apiClient.upload<T>(`${API_URL}${endpoint}`, formData, options),
};

// API Key Management API
export const apiKeysApi = {
  /**
   * Create a new API key
   */
  create: (data: APIKeyCreateRequest, options?: ApiClientOptions): Promise<ApiResponse<APIKeyCreateResponse>> =>
    backendApi.post<APIKeyCreateResponse>('/api-keys', data, options),

  /**
   * List all API keys for the authenticated user
   */
  list: (options?: ApiClientOptions): Promise<ApiResponse<APIKeyResponse[]>> =>
    backendApi.get<APIKeyResponse[]>('/api-keys', options),

  /**
   * Revoke an API key
   */
  revoke: (keyId: string, options?: ApiClientOptions): Promise<ApiResponse<{ message: string }>> =>
    backendApi.patch<{ message: string }>(`/api-keys/${keyId}/revoke`, {}, options),

  /**
   * Delete an API key permanently
   */
  delete: (keyId: string, options?: ApiClientOptions): Promise<ApiResponse<{ message: string }>> =>
    backendApi.delete<{ message: string }>(`/api-keys/${keyId}`, options),
}; 