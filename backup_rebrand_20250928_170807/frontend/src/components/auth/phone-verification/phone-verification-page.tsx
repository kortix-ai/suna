'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PhoneInput } from './phone-input';
import { OtpVerification } from './otp-verification';
import {
  useEnrollPhoneNumber,
  useCreateChallenge,
  useVerifyChallenge,
  useListFactors,
  useGetAAL,
  useUnenrollFactor,
} from '@/hooks/react-query/phone-verification';
import { signOut } from '@/app/auth/actions';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LogOut, Loader2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';

interface PhoneVerificationPageProps {
  onSuccess?: () => void;
}

export function PhoneVerificationPage({
  onSuccess,
}: PhoneVerificationPageProps) {
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [factorId, setFactorId] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [success, setSuccess] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [isSubmittingPhone, setIsSubmittingPhone] = useState(false);
  const [hasExistingFactor, setHasExistingFactor] = useState(false);
  const router = useRouter();

  // Use React Query hooks
  const enrollMutation = useEnrollPhoneNumber();
  const challengeMutation = useCreateChallenge();
  const verifyMutation = useVerifyChallenge();
  const unenrollMutation = useUnenrollFactor();

  // Add debugging hooks
  const { data: factors } = useListFactors();
  const { data: aalData } = useGetAAL();

  // Check for existing verified factors on component mount
  useEffect(() => {
    // Don't interfere while we're submitting a phone number
    if (isSubmittingPhone) {
      return;
    }

    if (factors?.factors) {
      const phoneFactors = factors.factors.filter(
        (f) => f.factor_type === 'phone',
      );
      const verifiedPhoneFactor = phoneFactors.find(
        (f) => f.status === 'verified',
      );

      if (verifiedPhoneFactor) {
        // User already has a verified factor - show options
        setStep('otp');
        setFactorId(verifiedPhoneFactor.id);
        setPhoneNumber(verifiedPhoneFactor.phone || '');
        setHasExistingFactor(true);
        // Don't set challengeId yet - let user choose to send code
      } else {
        // No verified factor found - check for unverified factors
        const unverifiedPhoneFactor = phoneFactors.find(
          (f) => f.status !== 'verified',
        );
        if (unverifiedPhoneFactor) {
          setFactorId(unverifiedPhoneFactor.id);
          setPhoneNumber(unverifiedPhoneFactor.phone || '');
          setStep('otp');
          setHasExistingFactor(true);
          // Don't set challengeId yet - let user choose to send code
        }
      }
    }
  }, [factors, aalData, isSubmittingPhone]);

  const handleCreateChallengeForExistingFactor = async () => {
    try {
      const challengeResponse = await challengeMutation.mutateAsync({
        factor_id: factorId,
      });

      setChallengeId(challengeResponse.id);
      setSuccess('Verification code sent to your phone');
    } catch (err) {
      console.error('❌ Failed to create challenge for existing factor:', err);
    }
  };

  const handleUnenrollFactor = async () => {
    try {
      await unenrollMutation.mutateAsync(factorId);

      // Reset state and go back to phone input
      setStep('phone');
      setFactorId('');
      setPhoneNumber('');
      setChallengeId('');
      setHasExistingFactor(false);
      setSuccess('Phone number removed. You can now add a new one.');
    } catch (err) {
      console.error('❌ Failed to unenroll factor:', err);
    }
  };

  const handlePhoneSubmit = async (phone: string) => {
    try {
      setIsSubmittingPhone(true);

      // Step 1: Enroll the phone number
      const enrollResponse = await enrollMutation.mutateAsync({
        friendly_name: 'Primary Phone',
        phone_number: phone,
      });

      // Step 2: Create a challenge (sends SMS)
      const challengeResponse = await challengeMutation.mutateAsync({
        factor_id: enrollResponse.id,
      });

      setPhoneNumber(phone);
      setFactorId(enrollResponse.id);
      setChallengeId(challengeResponse.id);
      setStep('otp');
      setHasExistingFactor(false);
      setSuccess('Verification code sent to your phone');
    } catch (err) {
      console.error('❌ Phone submission failed:', err);

      // If enrollment fails because factor already exists, try to handle existing factor
      if (err instanceof Error && err.message.includes('already exists')) {
        // Force refetch of factors
        window.location.reload();
      }
    } finally {
      setIsSubmittingPhone(false);
    }
  };

  const handleOtpVerify = async (otp: string) => {
    try {
      // Verify the challenge with the OTP code - this will automatically invalidate caches
      const verifyResponse = await verifyMutation.mutateAsync({
        factor_id: factorId,
        challenge_id: challengeId,
        code: otp,
      });

      // Store debug info to display
      setDebugInfo({
        verifyResponse,
        beforeFactors: factors,
        beforeAAL: aalData,
        timestamp: new Date().toISOString(),
      });

      setSuccess('Phone number verified successfully!');

      // Wait a bit for cache invalidation, then redirect
      setTimeout(() => {
        if (onSuccess) {
          onSuccess();
        } else {
          router.push('/dashboard');
        }
      }, 2000);
    } catch (err) {
      console.error('❌ OTP verification failed:', err);
    }
  };

  const handleResendCode = async () => {
    try {
      // Create a new challenge for the enrolled factor
      const challengeResponse = await challengeMutation.mutateAsync({
        factor_id: factorId,
      });

      setChallengeId(challengeResponse.id);
      setSuccess('New verification code sent');
    } catch (err) {
      console.error('❌ Resend failed:', err);
    }
  };

  const signOutMutation = useMutation({
    mutationFn: async () => {
      // Clear local storage before sign out
      clearUserLocalStorage();
      await signOut().catch(() => void 0);
      window.location.href = '/';
    },
  });

  const handleSignOut = () => {
    signOutMutation.mutate();
  };

  const isLoading =
    enrollMutation.isPending ||
    challengeMutation.isPending ||
    verifyMutation.isPending ||
    unenrollMutation.isPending;
  const error =
    enrollMutation.error?.message ||
    challengeMutation.error?.message ||
    verifyMutation.error?.message ||
    unenrollMutation.error?.message ||
    null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 relative">
      {/* Logout Button */}
      <div className="absolute top-4 right-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          disabled={signOutMutation.isPending}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground"
        >
          {signOutMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogOut className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">
            {signOutMutation.isPending ? 'Signing out...' : 'Sign out'}
          </span>
        </Button>
      </div>

      <div className="w-full max-w-md space-y-6">
        {/* Debug Information */}
        {false && (factors || aalData || debugInfo) && (
          <div className="p-4 rounded-lg text-xs space-y-2">
            <h3 className="font-semibold">Debug Info:</h3>
            {aalData && (
              <div>
                <strong>AAL:</strong> {aalData.current_level} →{' '}
                {aalData.next_level}
                (action: {aalData.action_required})
              </div>
            )}
            {factors && (
              <div>
                <strong>Factors:</strong>{' '}
                {factors.factors
                  ?.map((f) => `${f.factor_type}:${f.status}:${f.id}`)
                  .join(', ') || 'none'}
              </div>
            )}
            {debugInfo && (
              <div>
                <strong>Last Verification:</strong> {debugInfo.timestamp}
                <br />
                <strong>Response:</strong>{' '}
                {JSON.stringify(debugInfo.verifyResponse)}
              </div>
            )}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              {error}
            </AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert>
            <AlertDescription>
              {success}
            </AlertDescription>
          </Alert>
        )}

        {step === 'phone' ? (
          <PhoneInput
            onSubmit={handlePhoneSubmit}
            isLoading={isLoading}
            error={null}
          />
        ) : (
          <OtpVerification
            phoneNumber={phoneNumber}
            onVerify={handleOtpVerify}
            onResend={handleResendCode}
            onSendCode={handleCreateChallengeForExistingFactor}
            onRemovePhone={handleUnenrollFactor}
            isLoading={isLoading}
            error={null}
            showExistingOptions={hasExistingFactor}
            challengeId={challengeId}
          />
        )}
      </div>
    </div>
  );
}
