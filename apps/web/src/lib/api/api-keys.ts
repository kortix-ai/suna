import { backendApi } from '../api-client';
import type { ApiResponse, ApiClientOptions } from '../api-client';

// API Key Management Types
export type APIKeyType = 'user' | 'sandbox';

export interface APIKeyCreateRequest {
  sandbox_id: string;
  title: string;
  description?: string;
  expires_in_days?: number;
}

export interface APIKeyResponse {
  key_id: string;
  public_key: string;
  sandbox_id: string;
  title: string;
  description?: string;
  type: APIKeyType;
  status: 'active' | 'revoked' | 'expired';
  expires_at?: string;
  last_used_at?: string;
  created_at: string;
}

export interface APIKeyCreateResponse {
  key_id: string;
  public_key: string;
  secret_key: string;
  sandbox_id: string;
  title: string;
  description?: string;
  type: APIKeyType;
  status: 'active' | 'revoked' | 'expired';
  expires_at?: string;
  created_at: string;
}

export interface APIKeyRegenerateResponse {
  key_id: string;
  public_key: string;
  secret_key: string;
  sandbox_id: string;
  title: string;
  type: APIKeyType;
  status: 'active' | 'revoked' | 'expired';
  created_at: string;
}

// Wrapper types for the new response envelope
interface ApiKeysListEnvelope {
  success: boolean;
  data: APIKeyResponse[];
}

interface ApiKeyCreateEnvelope {
  success: boolean;
  data: APIKeyCreateResponse;
}

interface ApiKeyRegenerateEnvelope {
  success: boolean;
  data: APIKeyRegenerateResponse;
  sandbox_updated: boolean;
}

// API Key Management API (sandbox-scoped, kortix schema)
export const apiKeysApi = {
  /**
   * Create a new user API key for a sandbox.
   * The secret_key is returned ONCE in the response — only the hash is stored.
   */
  create: (data: APIKeyCreateRequest, options?: ApiClientOptions): Promise<ApiResponse<ApiKeyCreateEnvelope>> =>
    backendApi.post<ApiKeyCreateEnvelope>('/platform/api-keys', data, options),

  /**
   * List all API keys for a sandbox (no secrets returned).
   */
  list: (sandboxId: string, options?: ApiClientOptions): Promise<ApiResponse<ApiKeysListEnvelope>> =>
    backendApi.get<ApiKeysListEnvelope>(`/platform/api-keys?sandbox_id=${sandboxId}`, options),

  /**
   * Revoke an API key (soft-delete).
   */
  revoke: (keyId: string, options?: ApiClientOptions): Promise<ApiResponse<{ success: boolean; message: string }>> =>
    backendApi.patch<{ success: boolean; message: string }>(`/platform/api-keys/${keyId}/revoke`, {}, options),

  /**
   * Delete an API key permanently.
   */
  delete: (keyId: string, options?: ApiClientOptions): Promise<ApiResponse<{ success: boolean; message: string }>> =>
    backendApi.delete<{ success: boolean; message: string }>(`/platform/api-keys/${keyId}`, options),

  /**
   * Regenerate a sandbox-managed key (revoke old + create new).
   * Returns the new secret_key ONCE.
   */
  regenerate: (keyId: string, options?: ApiClientOptions): Promise<ApiResponse<ApiKeyRegenerateEnvelope>> =>
    backendApi.post<ApiKeyRegenerateEnvelope>(`/platform/api-keys/${keyId}/regenerate`, {}, options),
};
