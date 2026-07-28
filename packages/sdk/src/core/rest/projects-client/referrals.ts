import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

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

export interface Referral {
  id: string;
  referred_account_id: string;
  credits_awarded: number;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export interface ReferralListResponse {
  referrals: Referral[];
  total_count: number;
}

export interface ValidateReferralCodeResponse {
  valid: boolean;
  referrer_id?: string;
  message?: string;
}

export interface ReferralEmailResult {
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

export async function getReferralCode(): Promise<ReferralCodeResponse> {
  return unwrap(await backendApi.get<ReferralCodeResponse>('/referrals/code'), 'GET_CODE_FAILED');
}

export async function refreshReferralCode(): Promise<ReferralCodeResponse> {
  return unwrap(
    await backendApi.post<ReferralCodeResponse>('/referrals/code/refresh', {}),
    'REFRESH_CODE_FAILED',
  );
}

export async function validateReferralCode(code: string): Promise<ValidateReferralCodeResponse> {
  return unwrap(
    await backendApi.post<ValidateReferralCodeResponse>('/referrals/validate', {
      referral_code: code,
    }),
    'VALIDATE_CODE_FAILED',
  );
}

export async function getReferralStats(): Promise<ReferralStats> {
  return unwrap(await backendApi.get<ReferralStats>('/referrals/stats'), 'GET_STATS_FAILED');
}

export async function listReferrals(options: {
  limit?: number;
  offset?: number;
} = {}): Promise<ReferralListResponse> {
  const search = new URLSearchParams({
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
  });
  return unwrap(
    await backendApi.get<ReferralListResponse>(`/referrals/list?${search}`),
    'GET_REFERRALS_FAILED',
  );
}

export async function sendReferralEmails(emails: string[]): Promise<ReferralEmailResponse> {
  return unwrap(
    await backendApi.post<ReferralEmailResponse>('/referrals/email', { emails }),
    'SEND_EMAILS_FAILED',
  );
}
