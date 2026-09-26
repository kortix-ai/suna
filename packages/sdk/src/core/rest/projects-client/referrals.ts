/**
 * Referral program. The API removed every `/v1/referrals/*` route; these
 * exports remain for import compatibility until the next major.
 */
import { retiredEndpointError } from '../../http/api/errors';

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

/** @deprecated The referral program was removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function getReferralCode(): Promise<ReferralCodeResponse> {
  throw retiredEndpointError('getReferralCode');
}

/** @deprecated The referral program was removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function refreshReferralCode(): Promise<ReferralCodeResponse> {
  throw retiredEndpointError('refreshReferralCode');
}

/** @deprecated The referral program was removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function validateReferralCode(_code: string): Promise<ValidateReferralCodeResponse> {
  throw retiredEndpointError('validateReferralCode');
}

/** @deprecated The referral program was removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function getReferralStats(): Promise<ReferralStats> {
  throw retiredEndpointError('getReferralStats');
}

/** @deprecated The referral program was removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function listReferrals(_options: {
  limit?: number;
  offset?: number;
} = {}): Promise<ReferralListResponse> {
  throw retiredEndpointError('listReferrals');
}

/** @deprecated The referral program was removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function sendReferralEmails(_emails: string[]): Promise<ReferralEmailResponse> {
  throw retiredEndpointError('sendReferralEmails');
}
