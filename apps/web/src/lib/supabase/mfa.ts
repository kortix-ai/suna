import { createClient } from './client';
import type {
  FactorInfo,
  PhoneVerificationEnroll,
  PhoneVerificationChallenge,
  PhoneVerificationVerify,
  PhoneVerificationResponse,
  EnrollFactorResponse,
  ChallengeResponse,
  ListFactorsResponse,
  AALResponse,
} from '@/lib/api/phone-verification';

/**
 * Extract a human-readable message from an unknown thrown value. Preserves the
 * previous `error.message` behaviour for Error instances and Supabase error
 * objects (plain objects carrying a `message`), without using `any`.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message?: unknown }).message ?? error);
  }
  return String(error);
}

// Cutoff date for new user phone verification requirement
// Users created after this date will be required to have phone verification
// Users created before this date are grandfathered in and not required to verify
const PHONE_VERIFICATION_CUTOFF_DATE = new Date('2025-12-24T00:09:30.000Z');

function isPhoneVerificationMandatory(): boolean {
  const envVal = process.env.NEXT_PUBLIC_PHONE_NUMBER_MANDATORY;
  if (!envVal) return false;
  return envVal.toLowerCase() === 'true';
}

export const supabaseMFAService = {
  /**
   * Enroll phone number for SMS-based 2FA
   */
  async enrollPhoneNumber(data: PhoneVerificationEnroll): Promise<EnrollFactorResponse> {
    const supabase = createClient();
    
    try {
      const response = await supabase.auth.mfa.enroll({
        factorType: 'phone',
        friendlyName: data.friendly_name,
        phone: data.phone_number,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      if (!response.data) {
        throw new Error('No data returned from enrollment');
      }

      return {
        id: response.data.id,
        friendly_name: data.friendly_name,
        phone_number: data.phone_number,
        qr_code: undefined, // Phone factors don't have QR codes
        secret: undefined, // Phone factors don't have secrets
      };
    } catch (error: unknown) {
      console.error('❌ Enroll phone factor failed:', error);
      throw new Error(`Failed to enroll phone factor: ${toErrorMessage(error)}`);
    }
  },

  /**
   * Create a challenge for an enrolled phone factor (sends SMS)
   */
  async createChallenge(data: PhoneVerificationChallenge): Promise<ChallengeResponse> {
    const supabase = createClient();
    
    try {
      const response = await supabase.auth.mfa.challenge({
        factorId: data.factor_id,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      if (!response.data) {
        throw new Error('No data returned from challenge');
      }

      return {
        id: response.data.id,
        expires_at: response.data.expires_at ? new Date(response.data.expires_at * 1000).toISOString() : undefined,
      };
    } catch (error: unknown) {
      console.error('❌ Create SMS challenge failed:', error);
      throw new Error(`Failed to create SMS challenge: ${toErrorMessage(error)}`);
    }
  },

  /**
   * Verify SMS code for phone verification
   */
  async verifyChallenge(data: PhoneVerificationVerify): Promise<PhoneVerificationResponse> {
    const supabase = createClient();
    
    try {
      const response = await supabase.auth.mfa.verify({
        factorId: data.factor_id,
        challengeId: data.challenge_id,
        code: data.code,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      return {
        success: true,
        message: 'SMS code verified successfully',
      };
    } catch (error: unknown) {
      console.error('❌ Verify challenge failed:', error);
      throw new Error(`Failed to verify SMS code: ${toErrorMessage(error)}`);
    }
  },

  /**
   * Resend SMS code (create new challenge for existing factor)
   */
  async resendSMS(factorId: string): Promise<ChallengeResponse> {
    const supabase = createClient();
    
    try {
      const response = await supabase.auth.mfa.challenge({
        factorId: factorId,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      if (!response.data) {
        throw new Error('No data returned from challenge');
      }

      return {
        id: response.data.id,
        expires_at: response.data.expires_at ? new Date(response.data.expires_at * 1000).toISOString() : undefined,
      };
    } catch (error: unknown) {
      console.error('❌ Resend SMS failed:', error);
      throw new Error(`Failed to resend SMS: ${toErrorMessage(error)}`);
    }
  },

  /**
   * List all enrolled MFA factors
   */
  async listFactors(): Promise<ListFactorsResponse> {
    const supabase = createClient();
    
    try {
      const { data: { user }, error } = await supabase.auth.getUser();
      
      if (error) {
        throw new Error(error.message);
      }

      if (!user) {
        throw new Error('User not found');
      }

      const factors: FactorInfo[] = [];
      
      if (user.factors) {
        for (const factor of user.factors) {
          factors.push({
            id: factor.id,
            friendly_name: factor.friendly_name,
            factor_type: factor.factor_type,
            status: factor.status,
            phone: (factor as { phone?: string }).phone, // Phone property may not be in the type definition
            created_at: factor.created_at,
            updated_at: factor.updated_at,
          });
        }
      }

      return { factors };
    } catch (error: unknown) {
      console.error('❌ List factors failed:', error);
      throw new Error(`Failed to list factors: ${toErrorMessage(error)}`);
    }
  },

  /**
   * Remove phone verification from account
   */
  async unenrollFactor(factorId: string): Promise<PhoneVerificationResponse> {
    const supabase = createClient();
    
    try {
      const response = await supabase.auth.mfa.unenroll({
        factorId: factorId,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      return {
        success: true,
        message: 'Phone factor unenrolled successfully',
      };
    } catch (error: unknown) {
      console.error('❌ Unenroll factor failed:', error);
      throw new Error(`Failed to unenroll phone factor: ${toErrorMessage(error)}`);
    }
  },

  /**
   * Get Authenticator Assurance Level
   */
  async getAAL(): Promise<AALResponse> {
    const supabase = createClient();

    // If no active Supabase session (e.g. pre-login), return safe defaults.
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      return {
        current_level: 'aal1',
        next_level: 'aal1',
        current_authentication_methods: [],
        action_required: 'none',
        message: 'No active session — MFA not applicable',
        phone_verification_required: false,
        user_created_at: undefined,
        cutoff_date: PHONE_VERIFICATION_CUTOFF_DATE.toISOString(),
        verification_required: false,
        is_verified: false,
        factors: [],
      };
    }
    
    try {
      const aalResponse = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      
      if (aalResponse.error) {
        throw new Error(aalResponse.error.message);
      }

      const { data: { user }, error: userError } = await supabase.auth.getUser();
      
      if (userError) {
        throw new Error(userError.message);
      }

      if (!user) {
        throw new Error('User not found');
      }

      let userCreatedAt: Date | null = null;
      if (user.created_at) {
        try {
          userCreatedAt = new Date(user.created_at);
        } catch (e) {
          console.error('Failed to parse user created_at:', e);
          userCreatedAt = new Date();
        }
      }

      const isNewUser = userCreatedAt && userCreatedAt >= PHONE_VERIFICATION_CUTOFF_DATE;

      const factors: FactorInfo[] = [];
      const phoneFactors: FactorInfo[] = [];
      let hasVerifiedPhone = false;

      if (user.factors) {
        for (const factor of user.factors) {
          const factorInfo = {
            id: factor.id,
            friendly_name: factor.friendly_name,
            factor_type: factor.factor_type,
            status: factor.status,
            phone: (factor as { phone?: string }).phone,
            created_at: factor.created_at,
            updated_at: factor.updated_at,
          };
          factors.push(factorInfo);

          if (factor.factor_type === 'phone') {
            phoneFactors.push(factorInfo);
            if (factor.status === 'verified') {
              hasVerifiedPhone = true;
            }
          }
        }
      }

      const current = aalResponse.data?.currentLevel;
      const nextLevel = aalResponse.data?.nextLevel;

      let actionRequired: string = 'none';
      let message: string = '';

      if (current === 'aal1' && nextLevel === 'aal1') {
        actionRequired = 'none';
        message = 'MFA is not enrolled for this account';
      } else if (current === 'aal1' && nextLevel === 'aal2') {
        actionRequired = 'verify_mfa';
        message = 'MFA verification required to access full features';
      } else if (current === 'aal2' && nextLevel === 'aal2') {
        actionRequired = 'none';
        message = 'MFA is verified and active';
      } else if (current === 'aal2' && nextLevel === 'aal1') {
        actionRequired = 'reauthenticate';
        message = 'Session needs refresh due to MFA changes';
      } else {
        actionRequired = 'unknown';
        message = `Unknown AAL combination: ${current} -> ${nextLevel}`;
      }

      let verificationRequired = false;
      if (isNewUser) {
        if (current === 'aal1' && nextLevel === 'aal1') {
          verificationRequired = true;
        } else if (actionRequired === 'verify_mfa') {
          verificationRequired = true;
        }
      } else {
        verificationRequired = actionRequired === 'verify_mfa';
      }

      const phoneVerificationRequired = isNewUser && isPhoneVerificationMandatory();
      verificationRequired = !!(isNewUser && verificationRequired && isPhoneVerificationMandatory());

      return {
        current_level: current ?? undefined,
        next_level: nextLevel ?? undefined,
        // Supabase types currentAuthenticationMethods as string[] | AMREntry[];
        // `any` keeps the `.method` access valid across both arms of the union.
        current_authentication_methods: aalResponse.data?.currentAuthenticationMethods?.map((m: any) => m.method) || [],
        action_required: actionRequired,
        message: message,
        phone_verification_required: phoneVerificationRequired ?? false,
        user_created_at: userCreatedAt?.toISOString(),
        cutoff_date: PHONE_VERIFICATION_CUTOFF_DATE.toISOString(),
        verification_required: verificationRequired ?? undefined,
        is_verified: hasVerifiedPhone,
        factors: factors,
      };
    } catch (error: unknown) {
      console.error('❌ Get AAL failed:', error);
      throw new Error(`Failed to get AAL: ${toErrorMessage(error)}`);
    }
  },
}; 
