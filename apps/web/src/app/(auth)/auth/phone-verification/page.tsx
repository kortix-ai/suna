'use client';

import { signOut } from '@/app/(auth)/auth/actions';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import {
  AuthMobileLogo,
  Rise,
  StepHeader,
  SuccessStrip,
} from '@/features/auth/auth-primitives';
import { OtpVerification } from '@/features/auth/phone-verification/otp-verification';
import { PhoneInput } from '@/features/auth/phone-verification/phone-input';
import {
  useCreateChallenge,
  useEnrollPhoneNumber,
  useGetAAL,
  useListFactors,
  useUnenrollFactor,
  useVerifyChallenge,
} from '@/hooks/auth';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { useMutation } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export default function PhoneVerificationPage() {
  const t = useTranslations('auth.phoneVerification');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [factorId, setFactorId] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmittingPhone, setIsSubmittingPhone] = useState(false);
  const [hasExistingFactor, setHasExistingFactor] = useState(false);
  const router = useRouter();
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the post-verify redirect timer if we unmount before it fires.
  useEffect(
    () => () => {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    },
    [],
  );

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
      const phoneFactors = factors.factors.filter((f) => f.factor_type === 'phone');
      const verifiedPhoneFactor = phoneFactors.find((f) => f.status === 'verified');

      if (verifiedPhoneFactor) {
        // User already has a verified factor - show options
        setStep('otp');
        setFactorId(verifiedPhoneFactor.id);
        setPhoneNumber(verifiedPhoneFactor.phone || '');
        setHasExistingFactor(true);
        // Don't set challengeId yet - let user choose to send code
      } else {
        // No verified factor found - check for unverified factors
        const unverifiedPhoneFactor = phoneFactors.find((f) => f.status !== 'verified');
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
      setSuccess(t('verificationCodeSent'));
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
      setSuccess(t('phoneNumberRemoved'));
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
      setSuccess(t('verificationCodeSent'));
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
      await verifyMutation.mutateAsync({
        factor_id: factorId,
        challenge_id: challengeId,
        code: otp,
      });

      setSuccess(t('phoneNumberVerified'));

      // Wait a bit for cache invalidation, then redirect. Track the timer so a
      // pre-redirect unmount doesn't fire router.push/onSuccess after unmount.
      redirectTimerRef.current = setTimeout(() => {
        router.push('/projects');
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
      setSuccess(t('newVerificationCodeSent'));
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

  // Mutation failures surface as a toast (the inputs shake via aria-invalid);
  // dedupe so re-renders don't replay the same toast.
  const lastToastedError = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== lastToastedError.current) errorToast(error);
    lastToastedError.current = error;
  }, [error]);

  return (
    <div className="bg-background relative flex min-h-svh flex-col">
      <AuthMobileLogo />
      <div className="absolute top-6 right-6 z-10">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          disabled={signOutMutation.isPending}
          className="text-muted-foreground hover:text-foreground gap-2"
        >
          {signOutMutation.isPending ? (
            <Loading className="text-foreground! size-4 shrink-0" />
          ) : (
            <LogOut className="size-4" />
          )}
          <span className="hidden sm:inline">
            {signOutMutation.isPending ? t('signingOut') : t('signOut')}
          </span>
        </Button>
      </div>

      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
        <div className="w-full max-w-[380px]">
          <Rise>
            <StepHeader
              title={step === 'phone' ? t('title') : t('titleOtp')}
              description={step === 'phone' ? t('description') : t('descriptionOtp')}
            />
          </Rise>

          <Rise delay={0.06}>
            {success && <SuccessStrip message={success} />}

            {step === 'phone' ? (
              <PhoneInput onSubmit={handlePhoneSubmit} isLoading={isLoading} error={error} />
            ) : (
              <OtpVerification
                phoneNumber={phoneNumber}
                onVerify={handleOtpVerify}
                onResend={handleResendCode}
                onSendCode={handleCreateChallengeForExistingFactor}
                onRemovePhone={handleUnenrollFactor}
                isLoading={isLoading}
                error={error}
                showExistingOptions={hasExistingFactor}
                challengeId={challengeId}
              />
            )}
          </Rise>
        </div>
      </main>
    </div>
  );
}
