/**
 * Apify Approval API
 * 
 * Handles approval requests for Apify actor runs.
 */

import { API_URL, getAuthHeaders } from './config';
import { log } from '@/lib/logger';

export interface ApifyApprovalRequest {
  actor_id: string;
  run_input: Record<string, any>;
  max_cost_usd?: number;
  thread_id?: string;
}

export interface ApifyApproval {
  approval_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
  actor_id: string;
  estimated_cost_usd?: number;
  estimated_cost_credits?: number;
  max_cost_usd?: number;
  actual_cost_usd?: number;
  actual_cost_credits?: number;
  run_id?: string;
  created_at?: string;
  approved_at?: string;
  expires_at?: string;
  message?: string;
}

export interface ApifyApprovalResponse {
  success: boolean;
  data: ApifyApproval;
}

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    
    if (response.status !== 401 && response.status !== 403) {
      log.error('❌ Apify Approvals API Error:', {
        endpoint,
        status: response.status,
        error: errorData,
      });
    }
    
    const errorMessage = errorData.detail?.message || errorData.detail || errorData.message || response.statusText;
    throw new Error(`HTTP ${response.status}: ${errorMessage}`);
  }

  return response.json();
}

export const apifyApprovalsApi = {
  async approveRequest(
    approvalId: string,
    threadId: string
  ): Promise<ApifyApproval> {
    const response = await fetchApi<ApifyApprovalResponse>(
      `/apify/approvals/${approvalId}/approve`,
      {
        method: 'POST',
        body: JSON.stringify({ thread_id: threadId }),
      }
    );

    if (!response.success || !response.data) {
      throw new Error(response.data?.message || 'Failed to approve request');
    }

    return response.data;
  },

  async getApprovalStatus(
    approvalId: string,
    threadId: string
  ): Promise<ApifyApproval> {
    const response = await fetchApi<ApifyApprovalResponse>(
      `/apify/approvals/${approvalId}?thread_id=${threadId}`
    );

    if (!response.success || !response.data) {
      throw new Error(response.data?.message || 'Failed to get approval status');
    }

    return response.data;
  },
};

