'use client';

import { useState, useEffect, Suspense, lazy } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PhoneInput } from './phone-input';
import { OtpVerification } from './otp-verification';
import {
  useEnrollPhoneNumber,
  useCreateChallenge,
  useVerifyChallenge,
  useListFactors,
  useGetAAL,
  useUnenrollFactor,
} from '@/hooks/auth';
import { signOut } from '@/app/auth/actions';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LogOut, Loader2, Shield } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

const AnimatedBg = lazy(() => import('@/components/ui/animated-bg').then(mod => ({ default: mod.AnimatedBg })));

interface PhoneVerificationPageProps {
  onSuccess?: () => void;
}

export function PhoneVerificationPage({
  onSuccess,
}: PhoneVerificationPageProps) {
  const t = useTranslations('auth.phoneVerification');
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

      setSuccess(t('phoneNumberVerified'));

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

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-background via-background to-accent/10 pointer-events-none" />
      
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <Suspense fallback={null}>
          <AnimatedBg
            variant="hero"
            customArcs={{
              left: [
                { pos: { left: -120, top: 150 }, opacity: 0.15 },
                { pos: { left: -120, top: 400 }, opacity: 0.18 },
              ],
              right: [
                { pos: { right: -150, top: 50 }, opacity: 0.2 },
                { pos: { right: 10, top: 650 }, opacity: 0.17 },
              ]
            }}
          />
        </Suspense>
      </div>

      <div className="absolute top-6 left-6 z-10">
        <Link href="/" className="flex items-center space-x-2">
          <KortixLogo size={28} />
        </Link>
      </div>

      <div className="absolute top-6 right-6 z-10">
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
            {signOutMutation.isPending ? t('signingOut') : t('signOut')}
          </span>
        </Button>
      </div>

      <div className="relative z-10 min-h-screen flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2 mb-8">
            <div className="flex justify-center mb-4">
              <div className="bg-primary/10 rounded-full p-4">
                <Shield className="h-8 w-8 text-primary" />
              </div>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {step === 'phone' ? t('title') : t('titleOtp')}
            </h1>
            <p className="text-muted-foreground text-sm">
              {step === 'phone' ? t('description') : t('descriptionOtp')}
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                {error}
              </AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert className="border-green-500/50 bg-green-500/10">
              <AlertDescription className="text-green-700 dark:text-green-400">
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
    </div>
  );
}
