'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Loader2,
  Shield,
  RotateCcw,
  Trash2,
  MessageSquare,
} from 'lucide-react';

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
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [localError, setLocalError] = useState<string | null>(null);
  const [canResend, setCanResend] = useState(false);
  const [countdown, setCountdown] = useState(30);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (challengeId) {
      // Focus first input when challenge is available
      inputRefs.current[0]?.focus();

      // Start countdown timer
      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            setCanResend(true);
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [challengeId]);

  const handleOtpChange = (index: number, value: string) => {
    setLocalError(null);

    // Only allow single digit
    if (value.length > 1) {
      value = value.slice(-1);
    }

    // Only allow digits
    if (value && !/^\d$/.test(value)) {
      return;
    }

    const newOtp = [...otp];
    newOtp[index] = value;
    setOtp(newOtp);

    // Auto-focus next input
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      // Move to previous input on backspace if current is empty
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text');
    const digits = pastedData.replace(/\D/g, '').slice(0, 6);

    if (digits.length === 6) {
      const newOtp = digits.split('');
      setOtp(newOtp);
      inputRefs.current[5]?.focus();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    const otpCode = otp.join('');

    if (otpCode.length !== 6) {
      setLocalError(t('pleaseEnterSixDigitCode'));
      return;
    }

    await onVerify(otpCode);
  };

  const handleResend = async () => {
    setCanResend(false);
    setCountdown(30);
    setOtp(['', '', '', '', '', '']);
    setLocalError(null);

    await onResend();

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setCanResend(true);
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSendCode = async () => {
    if (onSendCode) {
      setOtp(['', '', '', '', '', '']);
      setLocalError(null);
      setCanResend(false);
      setCountdown(30);
      await onSendCode();
    }
  };

  return (
    <Card className="w-full border-border">
      <CardContent className="pt-6">
        {(error || localError) && (
          <Alert variant="destructive" className="mb-6 py-2">
            <AlertDescription className="text-sm">
              {error || localError}
            </AlertDescription>
          </Alert>
        )}

        {phoneNumber && (
          <div className="mb-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t('codeSentTo')}
            </p>
            <p className="text-sm font-medium mt-1">{phoneNumber}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-4">
            <Label htmlFor="otp" className="text-sm font-medium text-center block">
              {t('enterSixDigitCode')}
            </Label>
            <div className="flex gap-2 justify-center">
              {otp.map((digit, index) => (
                <Input
                  key={index}
                  ref={(el) => {
                    inputRefs.current[index] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleOtpChange(index, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(index, e)}
                  onPaste={handlePaste}
                  className="w-12 h-14 text-center text-lg font-semibold border-border/70 focus:border-primary transition-colors"
                  disabled={isLoading || !challengeId}
                />
              ))}
            </div>
          </div>

          {challengeId ? (
            <>
              <Button
                type="submit"
                className="w-full h-11"
                disabled={isLoading || otp.join('').length !== 6}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('verifying')}
                  </>
                ) : (
                  <>
                    <Shield className="h-4 w-4" />
                    {t('verifyCode')}
                  </>
                )}
              </Button>

              <div className="text-center">
                <Button
                  type="button"
                  variant="link"
                  onClick={handleResend}
                  disabled={!canResend || isLoading}
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {canResend ? t('resendCode') : t('resendInSeconds', { seconds: countdown })}
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              {onSendCode && (
                <Button
                  type="button"
                  onClick={handleSendCode}
                  disabled={isLoading}
                  className="w-full h-11"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('sending')}
                    </>
                  ) : (
                    <>
                      <MessageSquare className="h-4 w-4" />
                      {t('sendVerificationCode')}
                    </>
                  )}
                </Button>
              )}

              {onRemovePhone && (
                <Button
                  type="button"
                  onClick={onRemovePhone}
                  disabled={isLoading}
                  variant="outline"
                  className="w-full h-10 text-sm"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('removePhoneNumber')}
                </Button>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
