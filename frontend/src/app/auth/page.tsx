'use client';

import Link from 'next/link';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import GoogleSignIn from '@/components/GoogleSignIn';
import { useMediaQuery } from '@/hooks/utils';
import { useState, useEffect, Suspense } from 'react';
import { signIn, signUp, forgotPassword } from './actions';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  X,
  CheckCircle,
  AlertCircle,
  MailCheck,
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useAuth } from '@/components/AuthProvider';
import { useAuthMethodTracking } from '@/stores/auth-tracking';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import GitHubSignIn from '@/components/GithubSignIn';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { ReleaseBadge } from '@/components/auth/release-badge';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();
  const mode = searchParams.get('mode');
  const returnUrl = searchParams.get('returnUrl') || searchParams.get('redirect');
  const message = searchParams.get('message');
  const t = useTranslations('auth');

  const isSignUp = mode === 'signup';
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [mounted, setMounted] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

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

  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState('');
  const [forgotPasswordStatus, setForgotPasswordStatus] = useState<{
    success?: boolean;
    message?: string;
  }>({});

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isSuccessMessage) {
      setRegistrationSuccess(true);
    }
  }, [isSuccessMessage]);

  const handleSignIn = async (prevState: any, formData: FormData) => {
    markEmailAsUsed();

    const finalReturnUrl = returnUrl || '/dashboard';
    formData.append('returnUrl', finalReturnUrl);
    const result = await signIn(prevState, formData);

    if (
      result &&
      typeof result === 'object' &&
      'success' in result &&
      result.success &&
      'redirectTo' in result
    ) {
      window.location.href = result.redirectTo as string;
      return null;
    }

    if (result && typeof result === 'object' && 'message' in result) {
      toast.error(t('signInFailed'), {
        description: result.message as string,
        duration: 5000,
      });
      return {};
    }

    return result;
  };

  const handleSignUp = async (prevState: any, formData: FormData) => {
    markEmailAsUsed();

    const email = formData.get('email') as string;
    setRegistrationEmail(email);

    const finalReturnUrl = returnUrl || '/dashboard';
    formData.append('returnUrl', finalReturnUrl);

    // Add origin for email redirects
    formData.append('origin', window.location.origin);

    const result = await signUp(prevState, formData);

    // Check for success and redirectTo properties (direct login case)
    if (
      result &&
      typeof result === 'object' &&
      'success' in result &&
      result.success &&
      'redirectTo' in result
    ) {
      // Use window.location for hard navigation to avoid stale state
      window.location.href = result.redirectTo as string;
      return null; // Return null to prevent normal form action completion
    }

    // Check if registration was successful but needs email verification
    if (result && typeof result === 'object' && 'message' in result) {
      const resultMessage = result.message as string;
      if (resultMessage.includes('Check your email')) {
        setRegistrationSuccess(true);

        // Update URL without causing a refresh
        const params = new URLSearchParams(window.location.search);
        params.set('message', resultMessage);

        const newUrl =
          window.location.pathname +
          (params.toString() ? '?' + params.toString() : '');

        window.history.pushState({ path: newUrl }, '', newUrl);

        return result;
      } else {
        toast.error(t('signUpFailed'), {
          description: resultMessage,
          duration: 5000,
        });
        return {};
      }
    }

    return result;
  };

  const handleForgotPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setForgotPasswordStatus({});

    if (!forgotPasswordEmail || !forgotPasswordEmail.includes('@')) {
      setForgotPasswordStatus({
        success: false,
        message: t('pleaseEnterValidEmail'),
      });
      return;
    }

    const formData = new FormData();
    formData.append('email', forgotPasswordEmail);
    formData.append('origin', window.location.origin);

    const result = await forgotPassword(null, formData);

    setForgotPasswordStatus(result);
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

  // Show loading spinner while checking auth state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <KortixLoader size="large" />
      </div>
    );
  }

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
              {t('confirmationLinkSent')}
            </p>

            <p className="text-lg font-medium mb-6">
              {registrationEmail || t('emailAddress')}
            </p>

            <div className="bg-green-50 dark:bg-green-950/20 border border-green-100 dark:border-green-900/50 rounded-lg p-4 mb-8">
              <p className="text-sm text-green-800 dark:text-green-400">
                {t('clickLinkToActivate')}
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
                {isSignUp ? t('createAccount') : t('logIntoAccount')}
              </h1>
            </div>
            <div className="space-y-3 mb-4">
              <GoogleSignIn returnUrl={returnUrl || undefined} />
              <GitHubSignIn returnUrl={returnUrl || undefined} />
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
            <form className="space-y-3">
              <Input
                id="email"
                name="email"
                type="email"
                placeholder={t('emailAddress')}
                className=""
                required
              />
              <Input
                id="password"
                name="password"
                type="password"
                placeholder={t('password')}
                className=""
                required
              />
              {isSignUp && (
                <>
                  <Input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    placeholder={t('confirmPassword')}
                    className=""
                    required
                  />
                  
                  {/* GDPR Consent Checkbox */}
                  <div className="flex items-center gap-3 my-4">
                    <Checkbox
                      id="gdprConsent"
                      checked={acceptedTerms}
                      onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                      required
                    />
                    <label 
                      htmlFor="gdprConsent" 
                      className="text-sm text-muted-foreground leading-none cursor-pointer select-none"
                    >
                      {(() => {
                        // Get the base translation text
                        const baseText = t('acceptPrivacyTerms');
                        const privacyText = t('privacyPolicy');
                        const termsText = t('termsOfService');
                        
                        // For Italian: "Accetto l'<privacyPolicy>Informativa sulla Privacy</privacyPolicy> e i <termsOfService>Termini di Servizio</termsOfService>"
                        // For English: "I accept the <privacyPolicy>Privacy Policy</privacyPolicy> and <termsOfService>Terms of Service</termsOfService>"
                        // For German: "Ich akzeptiere die <privacyPolicy>Datenschutzerklärung</privacyPolicy> und die <termsOfService>Nutzungsbedingungen</termsOfService>"
                        
                        // Parse the string and replace tags with links
                        const parts: React.ReactNode[] = [];
                        let lastIndex = 0;
                        
                        // Find privacyPolicy tag
                        const privacyRegex = /<privacyPolicy>(.*?)<\/privacyPolicy>/;
                        const privacyMatch = baseText.match(privacyRegex);
                        
                        if (privacyMatch) {
                          // Add text before privacyPolicy tag
                          if (privacyMatch.index! > lastIndex) {
                            parts.push(baseText.substring(lastIndex, privacyMatch.index!));
                          }
                          // Add privacyPolicy link
                          parts.push(
                            <a 
                              key="privacy"
                              href="https://www.kortix.com/legal?tab=privacy" 
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline underline-offset-2 transition-colors text-primary"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {privacyMatch[1]}
                            </a>
                          );
                          lastIndex = privacyMatch.index! + privacyMatch[0].length;
                        }
                        
                        // Find termsOfService tag
                        const termsRegex = /<termsOfService>(.*?)<\/termsOfService>/;
                        const termsMatch = baseText.match(termsRegex);
                        
                        if (termsMatch) {
                          // Add text before termsOfService tag
                          if (termsMatch.index! > lastIndex) {
                            parts.push(baseText.substring(lastIndex, termsMatch.index!));
                          }
                          // Add termsOfService link
                          parts.push(
                            <a 
                              key="terms"
                              href="https://www.kortix.com/legal?tab=terms"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline underline-offset-2 transition-colors text-primary"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {termsMatch[1]}
                            </a>
                          );
                          lastIndex = termsMatch.index! + termsMatch[0].length;
                        }
                        
                        // Add remaining text
                        if (lastIndex < baseText.length) {
                          parts.push(baseText.substring(lastIndex));
                        }
                        
                        // If no tags found, fallback to simple text with manual links
                        if (parts.length === 0) {
                          // Fallback: try to find the text and replace manually
                          const privacyIndex = baseText.indexOf(privacyText);
                          const termsIndex = baseText.indexOf(termsText);
                          
                          if (privacyIndex !== -1 && termsIndex !== -1) {
                            parts.push(baseText.substring(0, privacyIndex));
                            parts.push(
                              <a 
                                key="privacy"
                                href="https://www.kortix.com/legal?tab=privacy" 
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:underline underline-offset-2 transition-colors text-primary"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {privacyText}
                              </a>
                            );
                            parts.push(baseText.substring(privacyIndex + privacyText.length, termsIndex));
                            parts.push(
                              <a 
                                key="terms"
                                href="https://www.kortix.com/legal?tab=terms"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:underline underline-offset-2 transition-colors text-primary"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {termsText}
                              </a>
                            );
                            parts.push(baseText.substring(termsIndex + termsText.length));
                          } else {
                            // Last resort: just show the text
                            parts.push(baseText);
                          }
                        }
                        
                        return <>{parts}</>;
                      })()}
                    </label>
                  </div>
                </>
              )}
              <div className="pt-2">
                <div className="relative">
                  <SubmitButton
                    formAction={isSignUp ? handleSignUp : handleSignIn}
                    className="w-full h-10"
                    pendingText={isSignUp ? t('creatingAccount') : t('signingIn')}
                    disabled={isSignUp && !acceptedTerms}
                  >
                    {isSignUp ? t('signUp') : t('signIn')}
                  </SubmitButton>
                  {wasEmailLastMethod && (
                    <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-background shadow-sm">
                      <div className="w-full h-full bg-green-500 rounded-full animate-pulse" />
                    </div>
                  )}
                </div>
              </div>
            </form>

            <div className="mt-4 space-y-3 text-center text-sm">
              {!isSignUp && (
                <button
                  type="button"
                  onClick={() => setForgotPasswordOpen(true)}
                  className="text-primary hover:underline"
                >
                  {t('forgotPassword')}
                </button>
              )}

              <div>
                <Link
                  href={isSignUp
                    ? `/auth${returnUrl ? `?returnUrl=${returnUrl}` : ''}`
                    : `/auth?mode=signup${returnUrl ? `&returnUrl=${returnUrl}` : ''}`
                  }
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isSignUp
                    ? t('alreadyHaveAccount')
                    : t('dontHaveAccount')
                  }
                </Link>
              </div>
            </div>
          </div>
        </div>
        <div className="hidden lg:flex flex-1 items-center justify-center relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-background via-background to-accent/10" />
          <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
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
          </div>
        </div>
      </div>
      <Dialog open={forgotPasswordOpen} onOpenChange={setForgotPasswordOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle>{t('resetPassword')}</DialogTitle>
            </div>
            <DialogDescription>
              {t('resetPasswordDescription')}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleForgotPassword} className="space-y-4">
            <Input
              id="forgot-password-email"
              type="email"
              placeholder={t('emailAddress')}
              value={forgotPasswordEmail}
              onChange={(e) => setForgotPasswordEmail(e.target.value)}
              className=""
              required
            />
            {forgotPasswordStatus.message && (
              <div
                className={`p-3 rounded-md flex items-center gap-3 ${forgotPasswordStatus.success
                  ? 'bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900/50 text-green-800 dark:text-green-400'
                  : 'bg-destructive/10 border border-destructive/20 text-destructive'
                  }`}
              >
                {forgotPasswordStatus.success ? (
                  <CheckCircle className="h-4 w-4 flex-shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                )}
                <span className="text-sm">{forgotPasswordStatus.message}</span>
              </div>
            )}
            <DialogFooter className="gap-2">
              <button
                type="button"
                onClick={() => setForgotPasswordOpen(false)}
                className="h-10 px-4 border border-border bg-background hover:bg-accent transition-colors rounded-md"
              >
                {t('cancel')}
              </button>
              <button
                type="submit"
                className="h-10 px-4 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors rounded-md"
              >
                {t('sendResetLink')}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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
