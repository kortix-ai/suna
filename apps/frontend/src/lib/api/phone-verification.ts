import { supabaseMFAService } from '@/lib/supabase/mfa';



export interface FactorInfo {
  id: string;
  friendly_name?: string;
  factor_type?: string;
  status?: string;
  phone?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PhoneVerificationEnroll {
  friendly_name: string;
  phone_number: string;
}

export interface PhoneVerificationChallenge {
  factor_id: string;
}

export interface PhoneVerificationVerify {
  factor_id: string;
  challenge_id: string;
  code: string;
}

export interface PhoneVerificationChallengeAndVerify {
  factor_id: string;
  code: string;
}

export interface PhoneVerificationResponse {
  success: boolean;
  message?: string;
  id?: string;
  expires_at?: string;
}

export interface EnrollFactorResponse {
  id: string;
  friendly_name: string;
  phone_number: string;
  qr_code?: string;
  secret?: string;
}

export interface ChallengeResponse {
  id: string;
  expires_at?: string;
}

export interface ListFactorsResponse {
  factors: FactorInfo[];
}

export interface AALResponse {
  current_level?: string;
  next_level?: string;
  current_authentication_methods?: string[];
  // Add action guidance based on AAL status
  action_required?: string;
  message?: string;
  // Phone verification requirement fields
  phone_verification_required?: boolean;
  user_created_at?: string;
  cutoff_date?: string;
  // Computed verification status fields (same as PhoneVerificationStatus)
  verification_required?: boolean;
  is_verified?: boolean;
  factors?: FactorInfo[];
}




export const phoneVerificationService = {
  /**
   * Enroll phone number for SMS-based 2FA
   */
  async enrollPhoneNumber(data: PhoneVerificationEnroll): Promise<EnrollFactorResponse> {
    return await supabaseMFAService.enrollPhoneNumber(data);
  },

  /**
   * Create a challenge for an enrolled phone factor (sends SMS)
   */
  async createChallenge(data: PhoneVerificationChallenge): Promise<ChallengeResponse> {
    return await supabaseMFAService.createChallenge(data);
  },

  /**
   * Verify SMS code for phone verification
   */
  async verifyChallenge(data: PhoneVerificationVerify): Promise<PhoneVerificationResponse> {
    return await supabaseMFAService.verifyChallenge(data);
  },

  /**
   * Create challenge and verify in one step
   */
  async challengeAndVerify(data: PhoneVerificationChallengeAndVerify): Promise<PhoneVerificationResponse> {
    return await supabaseMFAService.challengeAndVerify(data);
  },

  /**
   * Resend SMS code (create new challenge for existing factor)
   */
  async resendSMS(factorId: string): Promise<ChallengeResponse> {
    return await supabaseMFAService.resendSMS(factorId);
  },

  /**
   * List all enrolled MFA factors
   */
  async listFactors(): Promise<ListFactorsResponse> {
    return await supabaseMFAService.listFactors();
  },

  /**
   * Remove phone verification from account
   */
  async unenrollFactor(factorId: string): Promise<PhoneVerificationResponse> {
    return await supabaseMFAService.unenrollFactor(factorId);
  },

  /**
   * Get Authenticator Assurance Level
   */
  async getAAL(): Promise<AALResponse> {
    return await supabaseMFAService.getAAL();
  }
};