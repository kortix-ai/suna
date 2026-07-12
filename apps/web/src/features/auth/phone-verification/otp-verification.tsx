'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { CodeInput } from '@/features/auth/auth-primitives';

interface OtpVerificationProps {
  phoneNumber?: string;
  onVerify: (otp: string) => Promise<void>;
  onResend: () => Promise<void>;
  onSendCode?: () => Promise<void>;
  onRemovePhone?: () => Promise<void>;
  isLoading?: boolean;
  error?: string | null;
  showExistingOptions?: boolean;
  challengeId?: string;
}

export function OtpVerification({
  phoneNumber,
  onVerify,
  onResend,
  onSendCode,
  onRemovePhone,
  isLoading = false,
  error = null,
  showExistingOptions = false,
  challengeId,
}: OtpVerificationProps) {
  const t = useTranslations('auth.phoneVerification');
  const [otp, setOtp] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [canResend, setCanResend] = useState(false);
  const [countdown, setCountdown] = useState(30);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Single ref-tracked countdown timer so it can be cleared on unmount and
  // restarted on resend without leaking a second interval (the resend timer
  // previously lived in a local var and was never cleaned up — it kept firing
  // setState after unmount).
  const startCountdown = useCallback(() => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setCanResend(false);
    setCountdown(30);
    countdownTimerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setCanResend(true);
          if (countdownTimerRef.current) {
            clearInterval(countdownTimerRef.current);
            countdownTimerRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    if (challengeId) {
      startCountdown();
    }
    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, [challengeId, startCountdown]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (otp.length !== 6) {
      setLocalError(t('pleaseEnterSixDigitCode'));
      errorToast(t('pleaseEnterSixDigitCode'));
      return;
    }

    await onVerify(otp);
  };

  const handleResend = async () => {
    setOtp('');
    setLocalError(null);

    await onResend();

    startCountdown();
  };

  const handleSendCode = async () => {
    if (onSendCode) {
      setOtp('');
      setLocalError(null);
      setCanResend(false);
      setCountdown(30);
      await onSendCode();
    }
  };

  return (
    <div>
      {phoneNumber && (
        <p className="text-foreground text-sm">
          {t('codeSentTo')} <span className="font-semibold break-words">{phoneNumber}</span>
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-3 space-y-5">
        <CodeInput
          key={challengeId || 'idle'}
          value={otp}
          onChange={(next) => {
            setLocalError(null);
            setOtp(next);
          }}
          disabled={isLoading || !challengeId}
          autoFocus={!!challengeId}
          invalid={!!(localError || error)}
        />

        {challengeId ? (
          <>
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={isLoading || otp.length !== 6}
            >
              {isLoading ? <Loading className="size-4 shrink-0" /> : null}
              {isLoading ? t('verifying') : t('verifyCode')}
            </Button>

            <p className="text-muted-foreground text-sm">
              {canResend ? (
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={isLoading}
                  className="hover:text-foreground underline-offset-4 transition-colors hover:underline disabled:opacity-50"
                >
                  {t('resendCode')}
                </button>
              ) : (
                <span className="tabular-nums">
                  {t('resendInSeconds', { seconds: countdown })}
                </span>
              )}
            </p>
          </>
        ) : (
          <div className="space-y-2">
            {onSendCode && (
              <Button
                type="button"
                size="lg"
                onClick={handleSendCode}
                disabled={isLoading}
                className="w-full"
              >
                {isLoading ? <Loading className="size-4 shrink-0" /> : null}
                {isLoading ? t('sending') : t('sendVerificationCode')}
              </Button>
            )}

            {onRemovePhone && (
              <Button
                type="button"
                onClick={onRemovePhone}
                disabled={isLoading}
                variant="secondary"
                size="lg"
                className="w-full"
              >
                {t('removePhoneNumber')}
              </Button>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
