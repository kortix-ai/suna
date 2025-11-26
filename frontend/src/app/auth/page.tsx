'use client';

import Link from 'next/link';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useMediaQuery } from '@/hooks/utils';
import { useState, useEffect, Suspense, lazy } from 'react';
import { signUp } from './actions';
import { useSearchParams, useRouter } from 'next/navigation';
import { MailCheck } from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';
import { useAuthMethodTracking } from '@/stores/auth-tracking';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

// Lazy load heavy components
const GoogleSignIn = lazy(() => import('@/components/GoogleSignIn'));
const GitHubSignIn = lazy(() => import('@/components/GithubSignIn'));
const AnimatedBg = lazy(() => import('@/components/ui/animated-bg').then(mod => ({ default: mod.AnimatedBg })));

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();
  const mode = searchParams.get('mode');
  const returnUrl = searchParams.get('returnUrl') || searchParams.get('redirect');
  const message = searchParams.get('message');
  const t = useTranslations('auth');

  const isSignUp = mode !== 'signin';
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [mounted, setMounted] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false); // GDPR requires explicit opt-in

  const { wasLastMethod: wasEmailLastMethod, markAsUsed: markEmailAsUsed } = useAuthMethodTracking('email');

  useEffect(() => {
    if (!isLoading && user) {
      router.push(returnUrl || '/dashboard');
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

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isSuccessMessage) {
      setRegistrationSuccess(true);
    }
  }, [isSuccessMessage]);

  const handleAuth = async (prevState: any, formData: FormData) => {
    markEmailAsUsed();

    const email = formData.get('email') as string;
    setRegistrationEmail(email);

    const finalReturnUrl = returnUrl || '/dashboard';
    formData.append('returnUrl', finalReturnUrl);
    formData.append('origin', window.location.origin);
    formData.append('acceptedTerms', acceptedTerms.toString());

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


  const resetRegistrationSuccess = () => {
    setRegistrationSuccess(false);
    // Remove message from URL and set mode to signin
    const params = new URLSearchParams(window.location.search);
    params.delete('message');
    params.set('mode', 'signin');

    const newUrl =
      window.location.pathname +
      (params.toString() ? '?' + params.toString() : '');

    window.history.pushState({ path: newUrl }, '', newUrl);

    router.refresh();
  };

  // Don't block render while checking auth - let content show immediately
  // The useEffect will redirect if user is already authenticated

  // Registration success view
  if (registrationSuccess) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md mx-auto">
          <div className="text-center">
            <div className="bg-green-50 dark:bg-green-950/20 rounded-full p-4 mb-6 inline-flex">
              <MailCheck className="h-12 w-12 text-green-500 dark:text-green-400" />
            </div>

            <h1 className="text-3xl font-semibold text-foreground mb-4">
              {t('checkYourEmail')}
            </h1>

            <p className="text-muted-foreground mb-2">
              {t('magicLinkSent') || 'We sent a magic link to'}
            </p>

            <p className="text-lg font-medium mb-6">
              {registrationEmail || t('emailAddress')}
            </p>

            <div className="bg-green-50 dark:bg-green-950/20 border border-green-100 dark:border-green-900/50 rounded-lg p-4 mb-8">
              <p className="text-sm text-green-800 dark:text-green-400">
                {t('magicLinkDescription') || 'Click the link in your email to sign in. The link will expire in 1 hour.'}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
              <Link
                href="/"
                className="flex h-11 items-center justify-center px-6 text-center rounded-lg border border-border bg-background hover:bg-accent transition-colors"
              >
                {t('returnToHome')}
              </Link>
              <button
                onClick={resetRegistrationSuccess}
                className="flex h-11 items-center justify-center px-6 text-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {t('backToSignIn')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background relative">
      <div className="absolute top-6 left-6 z-10">
        <Link href="/" className="flex items-center space-x-2">
          <KortixLogo size={28} />
        </Link>
      </div>
      <div className="flex min-h-screen">
        <div className="relative flex-1 flex items-center justify-center p-4 lg:p-8">
          <div className="w-full max-w-sm">
            <div className="mb-4 flex items-center flex-col gap-3 sm:gap-4 justify-center">
              <h1 className="text-xl sm:text-2xl font-semibold text-foreground text-center leading-tight">
                {t('signInOrCreateAccount')}
              </h1>
            </div>
            <div className="space-y-3 mb-4">
              <Suspense fallback={<div className="h-11 bg-muted/20 rounded-full animate-pulse" />}>
                <GoogleSignIn returnUrl={returnUrl || undefined} />
              </Suspense>
              <Suspense fallback={<div className="h-11 bg-muted/20 rounded-full animate-pulse" />}>
                <GitHubSignIn returnUrl={returnUrl || undefined} />
              </Suspense>
            </div>
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-background text-muted-foreground">
                  {t('orEmail')}
                </span>
              </div>
            </div>
            <form className="space-y-4">
              <Input
                id="email"
                name="email"
                type="email"
                placeholder={t('emailAddress')}
                required
              />

              {/* Subtle GDPR-compliant checkbox */}
              <div className="flex items-start gap-2 py-1">
                <Checkbox
                  id="gdprConsent"
                  checked={acceptedTerms}
                  onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                  required
                  className="mt-0.5 h-3.5 w-3.5"
                />
                <label 
                  htmlFor="gdprConsent" 
                  className="text-xs text-muted-foreground leading-relaxed cursor-pointer select-none flex-1"
                >
                  {t.rich('acceptPrivacyTerms', {
                    privacyPolicy: (chunks) => (
                      <a 
                        href="https://www.kortix.com/legal?tab=privacy" 
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline underline-offset-2 text-primary"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {chunks}
                      </a>
                    ),
                    termsOfService: (chunks) => (
                      <a 
                        href="https://www.kortix.com/legal?tab=terms"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline underline-offset-2 text-primary"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {chunks}
                      </a>
                    )
                  })}
                </label>
              </div>

              <div className="relative">
                <SubmitButton
                  formAction={handleAuth}
                  className="w-full h-10"
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
              <p className="text-xs text-muted-foreground text-center">
                {t('magicLinkExplanation')}
              </p>
            </form>
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
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
