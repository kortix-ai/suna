import { backendApi } from '../api-client';
import type { ApiResponse, ApiClientOptions } from '../api-client';

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

