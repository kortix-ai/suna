'use client';

import Link from 'next/link';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useMediaQuery } from '@/hooks/utils';
import { useState, useEffect, Suspense, lazy, useRef } from 'react';
import { signUp, verifyOtp } from './actions';
import { useSearchParams, useRouter } from 'next/navigation';
import { Mail, MailCheck, Clock, ExternalLink } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useAuth } from '@/components/AuthProvider';
import { useAuthMethodTracking } from '@/stores/auth-tracking';
import { toast } from '@/lib/toast';
import { useTranslations } from 'next-intl';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { ReferralCodeDialog } from '@/components/referrals/referral-code-dialog';
import { isElectron, getAuthOrigin } from '@/lib/utils/is-electron';
import { ExampleShowcase } from '@/components/auth/example-showcase';
import { trackSendAuthLink } from '@/lib/analytics/gtm';
import { backendApi } from '@/lib/api-client';

// Lazy load heavy components
const GoogleSignIn = lazy(() => import('@/components/GoogleSignIn'));
// const GitHubSignIn = lazy(() => import('@/components/GithubSignIn'));
const AnimatedBg = lazy(() => import('@/components/ui/animated-bg').then(mod => ({ default: mod.AnimatedBg })));

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();
  const mode = searchParams.get('mode');
  const returnUrl = searchParams.get('returnUrl') || searchParams.get('redirect');
  const message = searchParams.get('message');
  const isExpired = searchParams.get('expired') === 'true';
  const expiredEmail = searchParams.get('email') || '';
  const referralCodeParam = searchParams.get('ref') || '';
  const t = useTranslations('auth');

  const isSignUp = mode !== 'signin';
  const [referralCode, setReferralCode] = useState(referralCodeParam);
  const [showReferralInput, setShowReferralInput] = useState(false);
  const [showReferralDialog, setShowReferralDialog] = useState(false);
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [mounted, setMounted] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false); // GDPR requires explicit opt-in

  const { wasLastMethod: wasEmailLastMethod, markAsUsed: markEmailAsUsed } = useAuthMethodTracking('email');

  useEffect(() => {
    // Redirect to dashboard if user is logged in
    if (!isLoading && user) {
      router.replace(returnUrl || '/dashboard');
    }
  }, [user, isLoading, router, returnUrl]);

  const isSuccessMessage =
    message &&
    (message.includes('Check your email') ||
      message.includes('Account created') ||
      message.includes('success'));

  // Registration success state
  const [registrationSuccess, setRegistrationSuccess] =
    useState(!!isSuccessMessage);
  const [registrationEmail, setRegistrationEmail] = useState('');

  // Expired link state
  const [linkExpired, setLinkExpired] = useState(isExpired);
  const [expiredEmailState, setExpiredEmailState] = useState(expiredEmail);
  const [resendEmail, setResendEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [newCodeSent, setNewCodeSent] = useState(false);
  const [autoSendingCode, setAutoSendingCode] = useState(false);
  const [autoSendError, setAutoSendError] = useState(false);
  const autoSendAttempted = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isSuccessMessage) {
      setRegistrationSuccess(true);
    }
  }, [isSuccessMessage]);

  useEffect(() => {
    if (isExpired) {
      setLinkExpired(true);
      if (expiredEmail) {
        setExpiredEmailState(expiredEmail);
      }
    }
  }, [isExpired, expiredEmail]);

  // Auto-send new OTP code when link expires (if we have the email)
  useEffect(() => {
    const autoSendNewCode = async () => {
      if (!isExpired || !expiredEmail || autoSendAttempted.current || isLoading || user) {
        return;
      }

      autoSendAttempted.current = true;
      setAutoSendingCode(true);

      try {
        // Call backend API to send OTP-only email
        const response = await backendApi.post('/auth/send-otp', { email: expiredEmail });

        if (response.success) {
          setNewCodeSent(true);
          setAutoSendError(false);
        } else {
          setAutoSendError(true);
        }
      } catch (error) {
        console.error('Auto-send failed:', error);
        setAutoSendError(true);
      } finally {
        setAutoSendingCode(false);
      }
    };

    autoSendNewCode();
  }, [isExpired, expiredEmail, isLoading, user]);

  const handleAuth = async (prevState: any, formData: FormData) => {
    trackSendAuthLink();
    markEmailAsUsed();

    const email = formData.get('email') as string;
    setRegistrationEmail(email);

    const finalReturnUrl = returnUrl || '/dashboard';
    formData.append('returnUrl', finalReturnUrl);
    // Use custom protocol for Electron, standard origin for web
    formData.append('origin', isElectron() ? getAuthOrigin() : window.location.origin);
    formData.append('acceptedTerms', acceptedTerms.toString());
    // Flag for Electron to use custom callback handling
    if (isElectron()) {
      formData.append('isDesktopApp', 'true');
    }

    const result = await signUp(prevState, formData);

    // Magic link always returns success with message (no immediate redirect)
    if (result && typeof result === 'object' && 'success' in result && result.success) {
      if ('email' in result && result.email) {
        setRegistrationEmail(result.email as string);
        setRegistrationSuccess(true);
        return result;
      }
    }

    if (result && typeof result === 'object' && 'message' in result) {
      toast.error(t('signUpFailed'), {
        description: result.message as string,
        duration: 5000,
      });
      return {};
    }

    return result;
  };


  // Helper to get email provider info for "Open in X" button
  // Uses mobile deep links when on mobile devices
  const getEmailProviderInfo = (email: string) => {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return null;

    // Detect mobile device for deep links
    const isMobileDevice = typeof window !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    // Provider config with web and mobile URLs
    // Mobile URLs use deep links that open native apps if installed
    const providers: { [key: string]: { name: string; webUrl: string; mobileUrl: string } } = {
      // Gmail - googlemail:// opens Gmail app on iOS/Android
      'gmail.com': { name: 'Gmail', webUrl: 'https://mail.google.com', mobileUrl: 'googlegmail://' },
      'googlemail.com': { name: 'Gmail', webUrl: 'https://mail.google.com', mobileUrl: 'googlegmail://' },
      // Outlook - ms-outlook:// opens Outlook app
      'outlook.com': { name: 'Outlook', webUrl: 'https://outlook.live.com', mobileUrl: 'ms-outlook://' },
      'hotmail.com': { name: 'Outlook', webUrl: 'https://outlook.live.com', mobileUrl: 'ms-outlook://' },
      'live.com': { name: 'Outlook', webUrl: 'https://outlook.live.com', mobileUrl: 'ms-outlook://' },
      'msn.com': { name: 'Outlook', webUrl: 'https://outlook.live.com', mobileUrl: 'ms-outlook://' },
      // Yahoo - ymail:// opens Yahoo Mail app
      'yahoo.com': { name: 'Yahoo Mail', webUrl: 'https://mail.yahoo.com', mobileUrl: 'ymail://' },
      'yahoo.de': { name: 'Yahoo Mail', webUrl: 'https://mail.yahoo.com', mobileUrl: 'ymail://' },
      'yahoo.co.uk': { name: 'Yahoo Mail', webUrl: 'https://mail.yahoo.com', mobileUrl: 'ymail://' },
      // iCloud - Use web URL, Apple Mail is default on iOS
      'icloud.com': { name: 'Mail', webUrl: 'https://www.icloud.com/mail', mobileUrl: 'message://' },
      'me.com': { name: 'Mail', webUrl: 'https://www.icloud.com/mail', mobileUrl: 'message://' },
      'mac.com': { name: 'Mail', webUrl: 'https://www.icloud.com/mail', mobileUrl: 'message://' },
      // ProtonMail - protonmail:// opens ProtonMail app
      'protonmail.com': { name: 'ProtonMail', webUrl: 'https://mail.proton.me', mobileUrl: 'protonmail://' },
      'proton.me': { name: 'ProtonMail', webUrl: 'https://mail.proton.me', mobileUrl: 'protonmail://' },
      'pm.me': { name: 'ProtonMail', webUrl: 'https://mail.proton.me', mobileUrl: 'protonmail://' },
      // AOL - Use web URL (no widely-used deep link)
      'aol.com': { name: 'AOL Mail', webUrl: 'https://mail.aol.com', mobileUrl: 'https://mail.aol.com' },
      // Zoho - Use web URL
      'zoho.com': { name: 'Zoho Mail', webUrl: 'https://mail.zoho.com', mobileUrl: 'https://mail.zoho.com' },
      // GMX - Use web URL
      'gmx.com': { name: 'GMX', webUrl: 'https://www.gmx.com', mobileUrl: 'https://www.gmx.com' },
      'gmx.de': { name: 'GMX', webUrl: 'https://www.gmx.net', mobileUrl: 'https://www.gmx.net' },
      'gmx.net': { name: 'GMX', webUrl: 'https://www.gmx.net', mobileUrl: 'https://www.gmx.net' },
      'web.de': { name: 'WEB.DE', webUrl: 'https://web.de', mobileUrl: 'https://web.de' },
      't-online.de': { name: 'T-Online', webUrl: 'https://email.t-online.de', mobileUrl: 'https://email.t-online.de' },
    };

    const provider = providers[domain];
    if (!provider) return null;

    return {
      name: provider.name,
      url: isMobileDevice ? provider.mobileUrl : provider.webUrl,
    };
  };

  // Don't block render while checking auth - let content show immediately
  // The useEffect will redirect if user is already authenticated

  // Handle OTP verification
  const handleVerifyOtp = async (prevState: any, formData: FormData) => {
    const email = expiredEmailState || formData.get('email') as string;
    if (!email) {
      toast.error(t('pleaseEnterValidEmail'));
      return {};
    }

    formData.set('email', email);
    formData.set('token', otpCode);
    formData.set('returnUrl', returnUrl || '/dashboard');

    const result = await verifyOtp(prevState, formData);

    if (result && typeof result === 'object') {
      if ('message' in result) {
        toast.error('Verification failed', {
          description: result.message as string,
          duration: 5000,
        });
        return {};
      }

      if ('success' in result && result.success) {
        // Full page reload to ensure AuthProvider re-initializes with new session cookies
        // router.replace() is client-side and won't refresh the AuthProvider state
        const redirectTo = (result as any).redirectTo || '/dashboard';
        const authEvent = (result as any).authEvent || 'login';
        const authMethod = (result as any).authMethod || 'email_otp';
        window.location.href = `${redirectTo}?auth_event=${authEvent}&auth_method=${authMethod}`;
        return result;
      }
    }

    return result;
  };

  // Don't show expired view if user is logged in or still loading
  if (isLoading || user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <KortixLoader size="medium" />
      </div>
    );
  }

  // Handle sending OTP code (for expired link flow)
  const handleSendOtpCode = async (prevState: any, formData: FormData) => {
    trackSendAuthLink();
    markEmailAsUsed();

    const email = expiredEmailState || formData.get('email') as string;
    if (!email) {
      toast.error(t('pleaseEnterValidEmail'));
      return {};
    }

    try {
      const response = await backendApi.post('/auth/send-otp', { email });

      if (response.success) {
        setRegistrationEmail(email);
        setExpiredEmailState(email);
        setNewCodeSent(true);
        setOtpCode('');
        setAutoSendError(false);
        return { success: true };
      } else {
        const errorMessage = response.error?.message || 'Failed to send verification code';
        toast.error('Failed to send code', {
          description: errorMessage,
          duration: 5000,
        });
        return {};
      }
    } catch (error: any) {
      toast.error('Failed to send code', {
        description: error.message || 'An error occurred',
        duration: 5000,
      });
      return {};
    }
  };

  // Expired link view
  if (linkExpired) {
    const emailForProvider = expiredEmailState || resendEmail;
    const provider = emailForProvider ? getEmailProviderInfo(emailForProvider) : null;

    // Split OTP into individual digits for the segmented input
    const otpDigits = otpCode.padEnd(6, '').split('');

    return (
      <div className="w-full relative overflow-hidden min-h-screen">
        <div className="relative flex flex-col items-center w-full px-4 sm:px-6 min-h-screen justify-center">
          {/* Animated background - same as registration success for consistency */}
          <Suspense fallback={null}>
            <AnimatedBg variant="hero" />
          </Suspense>

          <div className="relative z-10 w-full max-w-[420px] flex flex-col items-center">
            {autoSendingCode ? (
              // Loading: Auto-sending new code
              <div className="flex flex-col items-center gap-6 animate-in fade-in duration-300">
                <KortixLogo size={32} />

                <div className="relative">
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/5 to-transparent animate-pulse" />
                  <KortixLoader size="medium" />
                </div>

                <div className="text-center space-y-2">
                  <h1 className="text-[28px] sm:text-[32px] font-normal tracking-tight text-foreground leading-none">
                    Link expired
                  </h1>
                  <p className="text-[15px] text-foreground/50">
                    Sending a fresh code to your email...
                  </p>
                </div>
              </div>
            ) : newCodeSent ? (
              // Success: New code sent, show OTP input
              <div className="flex flex-col items-center gap-6 w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
                <KortixLogo size={32} />

                {/* Success indicator */}
                <div className="relative">
                  <div className="absolute inset-0 bg-emerald-500/20 rounded-full blur-xl" />
                  <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-b from-emerald-400/20 to-emerald-500/10 border border-emerald-500/20">
                    <MailCheck className="h-7 w-7 text-emerald-500" />
                  </div>
                </div>

                <div className="text-center space-y-2">
                  <h1 className="text-[28px] sm:text-[32px] font-normal tracking-tight text-foreground leading-none">
                    Check your email
                  </h1>
                  <p className="text-[15px] text-foreground/50">
                    We sent a 6-digit code to
                  </p>
                  <p className="text-[15px] font-medium text-foreground">
                    {expiredEmailState || resendEmail}
                  </p>
                </div>

                {/* Segmented OTP Input */}
                <label htmlFor="otp-input" className="w-full cursor-text">
                  <div className="flex justify-center gap-2 sm:gap-3">
                    {[0, 1, 2, 3, 4, 5].map((index) => (
                      <div
                        key={index}
                        className={`
                          relative w-11 h-14 sm:w-12 sm:h-16
                          rounded-xl border-2 transition-all duration-200
                          flex items-center justify-center
                          text-xl sm:text-2xl font-medium font-mono
                          ${otpDigits[index]
                            ? 'border-foreground/20 bg-card shadow-sm'
                            : 'border-border bg-background'
                          }
                          ${index === otpCode.length && otpCode.length < 6
                            ? 'border-foreground/40 ring-2 ring-foreground/10'
                            : ''
                          }
                        `}
                      >
                        {otpDigits[index] || (
                          <span className="text-foreground/20">·</span>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Hidden actual input for keyboard/paste support */}
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="sr-only"
                    autoFocus
                    id="otp-input"
                  />
                </label>

                <form className="w-full space-y-3">
                  <SubmitButton
                    formAction={handleVerifyOtp}
                    className="w-full h-12 rounded-xl text-[15px] font-medium"
                    pendingText="Verifying..."
                    disabled={otpCode.length !== 6}
                  >
                    Verify code
                  </SubmitButton>

                  {provider && (
                    <Button asChild variant="outline" size="lg" className="w-full h-12 rounded-xl">
                      <a
                        href={provider.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2"
                      >
                        <ExternalLink className="h-4 w-4" />
                        <span>{t('openProvider', { provider: provider.name })}</span>
                      </a>
                    </Button>
                  )}
                </form>

                <button
                  onClick={async () => {
                    const email = expiredEmailState || resendEmail;
                    if (!email) return;

                    setAutoSendingCode(true);
                    try {
                      const response = await backendApi.post('/auth/send-otp', { email });
                      if (response.success) {
                        setOtpCode('');
                        toast.success('New code sent!');
                      } else {
                        toast.error('Failed to send code');
                      }
                    } catch {
                      toast.error('Failed to send code');
                    } finally {
                      setAutoSendingCode(false);
                    }
                  }}
                  className="text-[13px] text-foreground/40 hover:text-foreground/70 transition-colors"
                >
                  Didn't receive it? <span className="underline underline-offset-2">Send again</span>
                </button>
              </div>
            ) : (
              // No email provided or auto-send failed - show manual form
              <div className="flex flex-col items-center gap-6 w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
                <KortixLogo size={32} />

                {/* Warning indicator */}
                <div className="relative">
                  <div className="absolute inset-0 bg-amber-500/20 rounded-full blur-xl" />
                  <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-b from-amber-400/20 to-amber-500/10 border border-amber-500/20">
                    <Clock className="h-7 w-7 text-amber-500" />
                  </div>
                </div>

                <div className="text-center space-y-2">
                  <h1 className="text-[28px] sm:text-[32px] font-normal tracking-tight text-foreground leading-none">
                    {t('magicLinkExpired')}
                  </h1>
                  <p className="text-[15px] text-foreground/50 max-w-[280px]">
                    {autoSendError
                      ? "We couldn't send a code automatically. Try again below."
                      : t('magicLinkExpiredDescription')
                    }
                  </p>
                </div>

                {expiredEmailState && (
                  <Card className="w-full bg-card/50 border border-border/50 backdrop-blur-sm">
                    <CardContent className="p-4 flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
                        <Mail className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <span className="text-[14px] font-medium text-foreground truncate">
                        {expiredEmailState}
                      </span>
                    </CardContent>
                  </Card>
                )}

                <form className="w-full space-y-4">
                  {!expiredEmailState && (
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      placeholder={t('emailAddress')}
                      required
                      onChange={(e) => setResendEmail(e.target.value)}
                      className="h-12 rounded-xl text-[15px]"
                    />
                  )}

                  <SubmitButton
                    formAction={handleSendOtpCode}
                    className="w-full h-12 rounded-xl text-[15px] font-medium"
                    pendingText="Sending..."
                    disabled={!expiredEmailState && !resendEmail}
                  >
                    Send verification code
                  </SubmitButton>

                  <p className="text-[12px] text-foreground/40 text-center">
                    We'll send a 6-digit code to verify it's you
                  </p>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Registration success view
  if (registrationSuccess) {
    const provider = registrationEmail ? getEmailProviderInfo(registrationEmail) : null;
    
    return (
      <div className="w-full relative overflow-hidden min-h-screen">
        <div className="relative flex flex-col items-center w-full px-4 sm:px-6 min-h-screen justify-center">
          {/* Animated background */}
          <Suspense fallback={null}>
            <AnimatedBg variant="hero" />
          </Suspense>

          <div className="relative z-10 w-full max-w-[456px] flex flex-col items-center gap-8">
            {/* Logo */}
            <KortixLogo size={32} />

            {/* Title */}
            <h1 className="text-[43px] font-normal tracking-tight text-foreground leading-none text-center whitespace-nowrap">
              {t('checkYourEmail')}
            </h1>

            {/* Description */}
            <p className="text-[16px] text-foreground/60 text-center leading-relaxed">
              {t('magicLinkSent') || 'We sent a magic link to'}{' '}
              <span className="font-medium text-foreground">{registrationEmail || t('emailAddress')}</span>
            </p>

            {/* Status Card and Footer */}
            <div className="w-full flex flex-col gap-4">
              <Card className="w-full h-24 bg-card border border-border">
                <CardContent className="p-6 flex items-center justify-between h-full">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted">
                      <Mail className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[14px] font-medium text-foreground">
                        Click the link in your email to sign in
                      </span>
                      <span className="text-[13px] text-foreground/60">
                        Check your inbox and spam folder
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Footer text */}
              <p className="text-[13px] text-foreground/40 text-center">
                {t('didntReceiveEmail')}{' '}
                <button
                  onClick={() => {
                    setRegistrationSuccess(false);
                    const params = new URLSearchParams(window.location.search);
                    params.set('mode', 'signin');
                    const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
                    window.history.pushState({ path: newUrl }, '', newUrl);
                  }}
                  className="text-primary hover:underline font-medium"
                >
                  {t('resend')}
                </button>
              </p>
            </div>

            {/* Action Buttons */}
            {provider && (
              <Button
                asChild
                size="lg"
                variant="outline"
                className="w-full h-12 rounded-lg font-medium"
              >
                <a
                  href={provider.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2"
                >
                  <ExternalLink className="h-4 w-4" />
                  <span>{t('openProvider', { provider: provider.name })}</span>
                </a>
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background relative">
      <div className="absolute top-4 sm:top-6 left-4 sm:left-6 z-10">
        <Link href="/" className="flex items-center space-x-2">
          <KortixLogo size={24} className="sm:w-7 sm:h-7" />
        </Link>
      </div>
      <div className="flex min-h-[100dvh]">
        <div className="relative flex-1 flex items-center justify-center px-4 py-16 sm:p-8">
          <div className="w-full max-w-sm">
            <div className="mb-4 sm:mb-6 flex items-center flex-col gap-2 sm:gap-4 justify-center">
              <h1 className="text-lg sm:text-xl md:text-2xl font-semibold text-foreground text-center leading-tight">
                {t('signInOrCreateAccount')}
              </h1>
            </div>
            <div className="space-y-3 mb-4">
              <Suspense fallback={<div className="h-10 sm:h-11 bg-muted/20 rounded-full animate-pulse" />}>
                <GoogleSignIn returnUrl={returnUrl || undefined} referralCode={referralCode} />
              </Suspense>
              {/* GitHub auth commented out
              <Suspense fallback={<div className="h-10 sm:h-11 bg-muted/20 rounded-full animate-pulse" />}>
                <GitHubSignIn returnUrl={returnUrl || undefined} referralCode={referralCode} />
              </Suspense>
              */}
            </div>
            <div className="relative my-3 sm:my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border"></div>
              </div>
              <div className="relative flex justify-center text-xs sm:text-sm">
                <span className="px-2 bg-background text-muted-foreground">
                  {t('orEmail')}
                </span>
              </div>
            </div>
            <form className="space-y-3 sm:space-y-4">
              <Input
                id="email"
                name="email"
                type="email"
                placeholder={t('emailAddress')}
                required
                className="h-10 sm:h-11 text-[16px] sm:text-sm"
              />

              {referralCodeParam && (
                <div className="bg-card border rounded-xl p-2.5 sm:p-3">
                  <p className="text-xs text-muted-foreground mb-0.5 sm:mb-1">{t('referralCode')}</p>
                  <p className="text-sm font-semibold">{referralCode}</p>
                </div>
              )}

              {!referralCodeParam && <input type="hidden" name="referralCode" value={referralCode} />}
              <div className="flex items-start gap-2">
                <Checkbox
                  id="gdprConsent"
                  checked={acceptedTerms}
                  onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                  required
                  className="h-5 w-5 mt-0.5"
                />
                <label
                  htmlFor="gdprConsent"
                  className="text-[11px] sm:text-xs text-muted-foreground leading-relaxed cursor-pointer select-none flex-1"
                >
                  {t.rich('acceptPrivacyTerms', {
                    privacyPolicy: (chunks) => {
                      return (
                        <a
                          href="https://www.kortix.com/legal?tab=privacy"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline underline-offset-2 text-primary"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {chunks}
                        </a>
                      );
                    },
                    termsOfService: (chunks) => {
                      return (
                        <a
                          href="https://www.kortix.com/legal?tab=terms"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline underline-offset-2 text-primary"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {chunks}
                        </a>
                      );
                    }
                  })}
                </label>
              </div>

              <div className="relative">
                <SubmitButton
                  formAction={handleAuth}
                  className="w-full h-10 sm:h-11 text-sm sm:text-base"
                  pendingText={t('sending')}
                  disabled={!acceptedTerms}
                >
                  {t('sendMagicLink')}
                </SubmitButton>
                {wasEmailLastMethod && (
                  <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-background shadow-sm">
                    <div className="w-full h-full bg-green-500 rounded-full animate-pulse" />
                  </div>
                )}
              </div>

              {/* Magic Link Explanation */}
              <p className="text-[11px] sm:text-xs text-muted-foreground text-center leading-relaxed">
                {t('magicLinkExplanation')}
              </p>

              {/* Minimal Referral Link */}
              {!referralCodeParam && (
                <button
                  type="button"
                  onClick={() => setShowReferralDialog(true)}
                  className="text-[11px] sm:text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-center mt-1 touch-manipulation"
                >
                  Have a referral code?
                </button>
              )}
            </form>

            {/* Referral Code Dialog */}
            <ReferralCodeDialog
              open={showReferralDialog}
              onOpenChange={setShowReferralDialog}
              referralCode={referralCode}
              onCodeChange={(code) => {
                setReferralCode(code);
                setShowReferralDialog(false);
              }}
            />
          </div>
        </div>
        <div className="hidden lg:flex flex-1 items-center justify-center relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-background via-background to-accent/10" />
          <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
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

          <ExampleShowcase />
        </div>
      </div>
    </div>
  );
}

export default function Login() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <KortixLoader size="medium" />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
