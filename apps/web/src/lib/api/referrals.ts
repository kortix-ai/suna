import { backendApi } from '@/lib/api-client';

export interface ReferralCodeResponse {
  referral_code: string;
  referral_url: string;
}

export interface ReferralStats {
  referral_code: string;
  total_referrals: number;
  successful_referrals: number;
  total_credits_earned: number;
  last_referral_at: string | null;
  remaining_earnable_credits: number;
  max_earnable_credits: number;
  has_reached_limit: boolean;
}

interface ReferralEmailResult {
  email: string;
  success: boolean;
  message?: string;
}

export interface ReferralEmailResponse {
  success: boolean;
  message?: string;
  results?: ReferralEmailResult[];
  success_count?: number;
  total_count?: number;
}

export const referralsApi = {
  getReferralCode: async (): Promise<ReferralCodeResponse> => {
    const response = await backendApi.get<ReferralCodeResponse>('/referrals/code');
    if (!response.success || !response.data) {
      throw new Error('GET_CODE_FAILED');
    }
    return response.data;
  },

  getReferralStats: async (): Promise<ReferralStats> => {
    const response = await backendApi.get<ReferralStats>('/referrals/stats');
    if (!response.success || !response.data) {
      throw new Error('GET_STATS_FAILED');
    }
    return response.data;
  },

  sendReferralEmails: async (emails: string[]): Promise<ReferralEmailResponse> => {
    const response = await backendApi.post<ReferralEmailResponse>(
      '/referrals/email',
      { emails }
    );
    if (!response.success || !response.data) {
      throw new Error('SEND_EMAILS_FAILED');
    }
    return response.data;
  },
};
