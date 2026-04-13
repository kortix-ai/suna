'use client';

import Link from 'next/link';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { useState, useEffect, Suspense, lazy, useRef, useCallback, useActionState } from 'react';
import { signUp, verifyOtp, requestAccess, signInWithPassword, sendOtpCode } from './actions';
import { useSearchParams, useRouter } from 'next/navigation';
import { Mail, MailCheck, Clock, ExternalLink, ChevronRight } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useAuth } from '@/components/AuthProvider';
import { useAuthMethodTracking } from '@/stores/auth-tracking';
import { toast } from '@/lib/toast';
import { useTranslations } from 'next-intl';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { ReferralCodeDialog } from '@/components/referrals/referral-code-dialog';
import { isElectron, getAuthOrigin } from '@/lib/utils/is-electron';
import { trackSendAuthLink } from '@/lib/analytics/gtm';
import { motion, AnimatePresence } from 'framer-motion';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { cn } from '@/lib/utils';
import { AuthBrowserNoiseGuard } from '@/components/auth/auth-browser-noise-guard';
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';

// Lazy load heavy components
const GoogleSignIn = lazy(() => import('@/components/GoogleSignIn'));


/* ─── Live clock ────────────────────────────────────────────────────────── */

function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);
  const day = now?.toLocaleDateString('en-US', { weekday: 'short' }) ?? '---';
  const month = now?.toLocaleDateString('en-US', { month: 'short' }) ?? '---';
  const date = now?.getDate() ?? '--';
  const h = now ? now.getHours() % 12 || 12 : '--';
  const m = now ? now.getMinutes().toString().padStart(2, '0') : '--';
  return (
    <div className="flex flex-col items-center select-none pointer-events-none">
      <p className="text-foreground/35 text-[13px] font-light tracking-widest" suppressHydrationWarning>
        {day} {month} {date}
      </p>
      <p
        className="text-foreground/80 text-[80px] sm:text-[104px] font-extralight leading-none -tracking-[0.02em] tabular-nums"
        suppressHydrationWarning
      >
        {h}:{m}
      </p>
    </div>
  );
}

/* ─── Email provider helper ─────────────────────────────────────────────── */

function getEmailProviderInfo(email: string, isMobileDevice: boolean) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  const providers: { [key: string]: { name: string; webUrl: string; mobileUrl: string } } = {
    'gmail.com': { name: 'Gmail', webUrl: 'https://mail.google.com', mobileUrl: 'googlegmail://' },
    'googlemail.com': { name: 'Gmail', webUrl: 'https://mail.google.com', mobileUrl: 'googlegmail://' },
    'outlook.com': { name: 'Outlook', webUrl: 'https://outlook.live.com', mobileUrl: 'ms-outlook://' },
    'hotmail.com': { name: 'Outlook', webUrl: 'https://outlook.live.com', mobileUrl: 'ms-outlook://' },
    'live.com': { name: 'Outlook', webUrl: 'https://outlook.live.com', mobileUrl: 'ms-outlook://' },
    'msn.com': { name: 'Outlook', webUrl: 'https://outlook.live.com', mobileUrl: 'ms-outlook://' },
    'yahoo.com': { name: 'Yahoo Mail', webUrl: 'https://mail.yahoo.com', mobileUrl: 'ymail://' },
    'icloud.com': { name: 'Mail', webUrl: 'https://www.icloud.com/mail', mobileUrl: 'message://' },
    'me.com': { name: 'Mail', webUrl: 'https://www.icloud.com/mail', mobileUrl: 'message://' },
    'mac.com': { name: 'Mail', webUrl: 'https://www.icloud.com/mail', mobileUrl: 'message://' },
    'protonmail.com': { name: 'ProtonMail', webUrl: 'https://mail.proton.me', mobileUrl: 'protonmail://' },
    'proton.me': { name: 'ProtonMail', webUrl: 'https://mail.proton.me', mobileUrl: 'protonmail://' },
    'pm.me': { name: 'ProtonMail', webUrl: 'https://mail.proton.me', mobileUrl: 'protonmail://' },
  };
  const provider = providers[domain];
  if (!provider) return null;
  return { name: provider.name, url: isMobileDevice ? provider.mobileUrl : provider.webUrl };
}

/* ─── Cloud auth main content ───────────────────────────────────────────── */

type AuthPhase = 'lock' | 'form';

function AccessRequestForm({ email, onSubmitted, onBack }: { email: string; onSubmitted: () => void; onBack: () => void }) {
  const handleRequestAccess = async (_prev: any, formData: FormData) => {
    formData.set('email', email);
    const result = await requestAccess(_prev, formData);
    if (result && typeof result === 'object' && 'success' in result && result.success) {
      onSubmitted();
    }
    return result || {};
  };

  return (
    <div className="bg-background/75 dark:bg-background/70 backdrop-blur-2xl border border-foreground/[0.08] rounded-2xl p-9 max-w-md w-full">
      <div className="flex flex-col items-center mb-7">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-foreground/[0.06] border border-foreground/[0.08] mb-4">
          <Mail className="h-5 w-5 text-foreground/50" />
        </div>
        <h1 className="text-[22px] font-semibold text-foreground/95 tracking-tight">
          Get Early Access
        </h1>
        <p className="text-sm text-foreground/45 mt-1.5 text-center leading-relaxed">
          We&apos;re onboarding new users in batches.
          <br />
          Reserve your spot and we&apos;ll notify you.
        </p>
      </div>

      <div className="bg-foreground/[0.04] border border-foreground/[0.08] rounded-xl px-4 py-3 mb-5">
        <p className="text-[11px] text-foreground/35 mb-0.5">Requesting for</p>
        <p className="text-[15px] text-foreground/80 font-medium">{email}</p>
      </div>

      <form className="space-y-3.5">
        <Input type="text"
          name="company"
          placeholder="Company (optional)"
          className="h-12 text-[15px] rounded-xl bg-foreground/[0.04] border-foreground/[0.08]"
        />
        <textarea
          name="useCase"
          placeholder="What will you build with Kortix?"
          rows={3}
          className="w-full rounded-xl bg-foreground/[0.04] border border-foreground/[0.08] text-[15px] text-foreground/80 placeholder:text-foreground/30 px-4 py-3 resize-none focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:border-foreground/15 transition-colors"
        />
        <SubmitButton formAction={handleRequestAccess} className="w-full h-10 text-[15px] font-medium rounded-xl shadow-none" pendingText="Submitting...">
          Request Early Access
        </SubmitButton>
      </form>

      <div className="flex justify-center mt-5">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-foreground/25 hover:text-foreground/45 transition-colors"
        >
          &larr; Back to sign in
        </button>
      </div>
    </div>
  );
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();
  const mode = searchParams.get('mode');
  const rawReturnUrl = searchParams.get('returnUrl') || searchParams.get('redirect');
  const returnUrl = sanitizeAuthReturnUrl(rawReturnUrl);
  const message = searchParams.get('message');
  const isExpired = searchParams.get('expired') === 'true';
  const expiredEmail = searchParams.get('email') || '';
  const referralCodeParam = searchParams.get('ref') || '';
  const isPasswordMode = searchParams.get('auth') === 'password';
  const t = useTranslations('auth');

  const [phase, setPhase] = useState<AuthPhase>('lock');
  const [referralCode, setReferralCode] = useState(referralCodeParam);
  const [showReferralDialog, setShowReferralDialog] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isMobileDevice, setIsMobileDevice] = useState(false);

  const { wasLastMethod: wasEmailLastMethod, markAsUsed: markEmailAsUsed } = useAuthMethodTracking('email');

  const isSuccessMessage =
    message &&
    (message.includes('Check your email') ||
      message.includes('Account created') ||
      message.includes('success'));

  const [registrationSuccess, setRegistrationSuccess] = useState(!!isSuccessMessage);
  const [registrationEmail, setRegistrationEmail] = useState('');

  const [signupClosed, setSignupClosed] = useState(false);
  const [signupClosedEmail, setSignupClosedEmail] = useState('');
  const [accessRequestSubmitted, setAccessRequestSubmitted] = useState(false);

  const [linkExpired, setLinkExpired] = useState(isExpired);
  const [expiredEmailState, setExpiredEmailState] = useState(expiredEmail);
  const [resendEmail, setResendEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [newCodeSent, setNewCodeSent] = useState(false);
  const [autoSendingCode, setAutoSendingCode] = useState(false);
  const [autoSendError, setAutoSendError] = useState(false);
  const [showOtpModal, setShowOtpModal] = useState(false);
  const autoSendAttempted = useRef(false);

  const sendOtpCodeForEmail = useCallback(async (email: string) => {
    const formData = new FormData();
    formData.set('email', email);
    formData.set('returnUrl', returnUrl);
    formData.set('origin', isElectron() ? getAuthOrigin() : window.location.origin);
    if (isElectron()) formData.set('isDesktopApp', 'true');
    return sendOtpCode({}, formData);
  }, [returnUrl]);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    setIsMobileDevice(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent));
  }, []);

  useEffect(() => {
    if (!isLoading && user) {
      router.replace(returnUrl);
    }
  }, [user, isLoading, router, returnUrl]);

  // If coming from an expired link, skip straight to form phase
  useEffect(() => {
    if (isExpired) {
      setLinkExpired(true);
      setPhase('form');
      if (expiredEmail) setExpiredEmailState(expiredEmail);
    }
  }, [isExpired, expiredEmail]);

  useEffect(() => {
    if (isSuccessMessage) setRegistrationSuccess(true);
  }, [isSuccessMessage]);

  // Auto-send new OTP code when link expires
  useEffect(() => {
    const autoSendNewCode = async () => {
      if (!isExpired || !expiredEmail || autoSendAttempted.current || isLoading || user) return;
      autoSendAttempted.current = true;
      setAutoSendingCode(true);
      try {
        const response = await sendOtpCodeForEmail(expiredEmail);
        if (response && typeof response === 'object' && 'success' in response && response.success) {
          setNewCodeSent(true);
          setAutoSendError(false);
        } else {
          setAutoSendError(true);
        }
      } catch {
        setAutoSendError(true);
      } finally {
        setAutoSendingCode(false);
      }
    };
    autoSendNewCode();
  }, [isExpired, expiredEmail, isLoading, user, sendOtpCodeForEmail]);

  // Keyboard controls: Enter/Space opens form, Escape closes it
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (phase === 'lock' && (e.key === 'Enter' || e.key === ' ')) {
        setPhase('form');
      }
      if (phase === 'form' && e.key === 'Escape') {
        setPhase('lock');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [phase]);

  const handleAuth = async (prevState: unknown, formData: FormData) => {
    trackSendAuthLink();
    markEmailAsUsed();
    const email = formData.get('email') as string;
    setRegistrationEmail(email);
    const finalReturnUrl = returnUrl;
    formData.append('returnUrl', finalReturnUrl);
    formData.append('origin', isElectron() ? getAuthOrigin() : window.location.origin);
    formData.append('acceptedTerms', acceptedTerms.toString());
    if (isElectron()) formData.append('isDesktopApp', 'true');
    const result = await signUp(prevState, formData);
    if (result && typeof result === 'object') {
      if ('signupClosed' in result && result.signupClosed) {
        const email = formData.get('email') as string;
        setSignupClosedEmail(email?.trim().toLowerCase() || '');
        setSignupClosed(true);
        return {};
      }
      if ('success' in result && result.success) {
        if ('email' in result && result.email) {
          setRegistrationEmail(result.email as string);
          setRegistrationSuccess(true);
          return result;
        }
      }
      if ('message' in result) {
        toast.error(t('signUpFailed'), { description: result.message as string, duration: 5000 });
        return {};
      }
    }
    return result;
  };

  const handlePasswordAuth = async (prevState: unknown, formData: FormData) => {
    formData.append('returnUrl', returnUrl);
    const result = await signInWithPassword(prevState, formData);
    if (result && typeof result === 'object') {
      if ('message' in result) {
        toast.error('Sign in failed', { description: result.message as string, duration: 5000 });
        return {};
      }
      if ('success' in result && result.success) {
        const redirectTo = (result as { redirectTo?: string }).redirectTo || '/dashboard';
        window.location.href = redirectTo;
        return result;
      }
    }
    return result;
  };

  const handleVerifyOtp = async (prevState: unknown, formData: FormData) => {
    const email = expiredEmailState || registrationEmail || formData.get('email') as string;
    if (!email) { toast.error(t('pleaseEnterValidEmail')); return {}; }
    formData.set('email', email);
    formData.set('token', otpCode);
    formData.set('returnUrl', returnUrl);
    const result = await verifyOtp(prevState, formData);
    if (result && typeof result === 'object') {
      if ('message' in result) {
        toast.error('Verification failed', { description: result.message as string, duration: 5000 });
        return {};
      }
      if ('success' in result && result.success) {
        const redirectTo = (result as { redirectTo?: string }).redirectTo || '/dashboard';
        const authEvent = (result as { authEvent?: string }).authEvent || 'login';
        const authMethod = (result as { authMethod?: string }).authMethod || 'email_otp';
        window.location.href = `${redirectTo}?auth_event=${authEvent}&auth_method=${authMethod}`;
        return result;
      }
    }
    return result;
  };

  const handleSendOtpCode = async (prevState: unknown, formData: FormData) => {
    trackSendAuthLink();
    markEmailAsUsed();
    const email = expiredEmailState || formData.get('email') as string;
    if (!email) { toast.error(t('pleaseEnterValidEmail')); return {}; }
    try {
      const response = await sendOtpCodeForEmail(email);
      if (response && typeof response === 'object' && 'success' in response && response.success) {
        setRegistrationEmail(email);
        setExpiredEmailState(email);
        setNewCodeSent(true);
        setOtpCode('');
        setAutoSendError(false);
        return { success: true };
      } else {
        toast.error('Failed to send code', { description: (response && typeof response === 'object' && 'message' in response ? response.message as string : 'Failed to send verification code'), duration: 5000 });
        return {};
      }
    } catch (error: unknown) {
      toast.error('Failed to send code', { description: error instanceof Error ? error.message : 'An error occurred', duration: 5000 });
      return {};
    }
  };

  if (isLoading || user) {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <KortixLoader size="medium" />
      </div>
    );
  }

  /* ── Registration success ── */
  if (registrationSuccess) {
    const provider = registrationEmail ? getEmailProviderInfo(registrationEmail, isMobileDevice) : null;
    return (
      <div className="fixed inset-0">
        <WallpaperBackground wallpaperId="brandmark" />
        <div className="relative z-10 flex flex-col items-center justify-center h-full px-4 gap-6">
          <KortixLogo size={28} />
          <h1 className="text-[36px] font-extralight tracking-tight text-foreground/80 leading-none">
            {t('checkYourEmail')}
          </h1>
          <p className="text-[15px] text-foreground/50 text-center">
            We sent a magic link to{' '}
            <span className="text-foreground/80 font-medium">{registrationEmail}</span>
          </p>
          <div className="flex flex-col gap-3 w-full max-w-[320px]">
            {provider && (
              <a
                href={provider.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 h-11 px-5 rounded-xl bg-foreground/[0.08] hover:bg-foreground/[0.12] border border-foreground/10 text-sm text-foreground/70 hover:text-foreground/90 transition-colors backdrop-blur-sm"
              >
                <ExternalLink className="size-3.5" />
                Open {provider.name}
              </a>
            )}
            <button
              onClick={() => { setOtpCode(''); setShowOtpModal(true); }}
              className="text-xs text-foreground/30 hover:text-foreground/50 transition-colors text-center"
            >
              Or <span className="underline underline-offset-2">enter 6-digit code</span>
            </button>
            <button
              onClick={() => setRegistrationSuccess(false)}
              className="text-xs text-foreground/30 hover:text-foreground/50 transition-colors text-center"
            >
              {t('didntReceiveEmail')} <span className="underline underline-offset-2">{t('resend')}</span>
            </button>
          </div>
        </div>

        {/* OTP verification modal */}
        <Dialog open={showOtpModal} onOpenChange={setShowOtpModal}>
          <DialogContent className="!max-w-[300px] sm:!max-w-[300px] p-5 gap-0 rounded-2xl" hideCloseButton aria-describedby="otp-modal-desc">
            <DialogTitle className="text-sm font-medium text-foreground/70 text-center">
              Enter code
            </DialogTitle>
            <DialogDescription id="otp-modal-desc" className="sr-only">
              Enter the 6-digit verification code from your email
            </DialogDescription>
            <form className="w-full space-y-2.5 mt-3">
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoFocus
                placeholder="000000"
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="h-11 text-center text-lg font-mono tracking-[0.3em] bg-foreground/[0.03] border-foreground/[0.08] rounded-xl shadow-none focus-visible:border-foreground/20 transition-colors"
              />
              <SubmitButton formAction={handleVerifyOtp} className="w-full h-10 text-[13px] font-medium rounded-xl shadow-none" pendingText="Verifying…" disabled={otpCode.length !== 6}>
                Verify
              </SubmitButton>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  /* ── Signup closed — access request form ── */
  if (signupClosed) {
    return (
      <div className="fixed inset-0 overflow-hidden">
        <WallpaperBackground wallpaperId="brandmark" />

        <motion.div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
          <motion.div className="absolute inset-0 bg-background/20 backdrop-blur-[2px]" />

          <motion.div
            className="relative z-10 w-full max-w-[360px] mx-4"
            initial={{ opacity: 0, y: 40, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            {accessRequestSubmitted ? (
              <div className="bg-background/75 dark:bg-background/70 backdrop-blur-2xl border border-foreground/[0.08] rounded-2xl p-7">
                <div className="flex flex-col items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/20">
                    <MailCheck className="h-5 w-5 text-emerald-500" />
                  </div>
                  <div className="text-center">
                    <h1 className="text-[17px] font-medium text-foreground/90 tracking-tight">
                      You&apos;re on the list
                    </h1>
                    <p className="text-[13px] text-foreground/40 mt-1.5 max-w-[260px] mx-auto">
                      We&apos;ll email <span className="text-foreground/60 font-medium">{signupClosedEmail}</span> when your access is ready.
                    </p>
                  </div>
                  <button
                    onClick={() => { setSignupClosed(false); setAccessRequestSubmitted(false); }}
                    className="text-[11px] text-foreground/25 hover:text-foreground/45 transition-colors mt-1"
                  >
                    &larr; Back to sign in
                  </button>
                </div>
              </div>
            ) : (
              <AccessRequestForm
                email={signupClosedEmail}
                onSubmitted={() => setAccessRequestSubmitted(true)}
                onBack={() => setSignupClosed(false)}
              />
            )}
          </motion.div>
        </motion.div>
      </div>
    );
  }

  /* ── Expired link / OTP flow ── */
  if (linkExpired) {
    const emailForProvider = expiredEmailState || resendEmail;
    const provider = emailForProvider ? getEmailProviderInfo(emailForProvider, isMobileDevice) : null;
    const otpDigits = otpCode.padEnd(6, '').split('');

    return (
      <div className="fixed inset-0">
        <WallpaperBackground wallpaperId="brandmark" />
        <div className="relative z-10 flex flex-col items-center justify-center h-full px-4 gap-6">
          {autoSendingCode ? (
            <div className="flex flex-col items-center gap-4">
              <KortixLogo size={28} />
              <KortixLoader size="medium" />
              <p className="text-[15px] text-foreground/50">Sending a fresh code…</p>
            </div>
          ) : newCodeSent ? (
            <div className="flex flex-col items-center gap-6 w-full max-w-[340px]">
              <KortixLogo size={28} />
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <MailCheck className="h-6 w-6 text-emerald-500" />
              </div>
              <div className="text-center space-y-1">
                <h1 className="text-[28px] font-extralight tracking-tight text-foreground/80">Check your email</h1>
                <p className="text-sm text-foreground/50">We sent a 6-digit code to <span className="text-foreground/70">{expiredEmailState || resendEmail}</span></p>
              </div>
              <label htmlFor="otp-input" className="w-full cursor-text">
                <div className="flex justify-center gap-2">
                  {[0,1,2,3,4,5].map((i) => (
                    <div
                      key={i}
                      className={cn(
                        "w-11 h-14 rounded-xl border-2 flex items-center justify-center text-xl font-medium font-mono transition-colors duration-200 bg-background/60 backdrop-blur-sm",
                        otpDigits[i] ? 'border-foreground/20' : 'border-border',
                        i === otpCode.length && otpCode.length < 6 ? 'border-foreground/40 ring-2 ring-foreground/10' : ''
                      )}
                    >
                      {otpDigits[i] || <span className="text-foreground/20">·</span>}
                    </div>
                  ))}
                </div>
                <input
                  type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                  value={otpCode} onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="sr-only" autoFocus id="otp-input"
                />
              </label>
              <form className="w-full space-y-3">
                <SubmitButton formAction={handleVerifyOtp} className="w-full h-11 text-sm" pendingText="Verifying…" disabled={otpCode.length !== 6}>
                  Verify code
                </SubmitButton>
                {provider && (
                  <Button asChild variant="outline" className="w-full h-11">
                    <a href={provider.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
                      <ExternalLink className="size-4" />{t('openProvider', { provider: provider.name })}
                    </a>
                  </Button>
                )}
              </form>
              <button
                type="button"
                onClick={async () => {
                  setAutoSendingCode(true);
                  try {
                    const res = await sendOtpCodeForEmail(expiredEmailState || resendEmail);
                    if (res && typeof res === 'object' && 'success' in res && res.success) {
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
                className="text-xs text-foreground/40 hover:text-foreground/60 transition-colors"
              >
                Didn&apos;t receive it? <span className="underline underline-offset-2">Send again</span>
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-6 w-full max-w-[340px]">
              <KortixLogo size={28} />
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10 border border-amber-500/20">
                <Clock className="h-6 w-6 text-amber-500" />
              </div>
              <div className="text-center space-y-1">
                <h1 className="text-[28px] font-extralight tracking-tight text-foreground/80">{t('magicLinkExpired')}</h1>
                <p className="text-sm text-foreground/50 max-w-[260px]">
                  {autoSendError ? "We couldn't send a code automatically. Try again below." : t('magicLinkExpiredDescription')}
                </p>
              </div>
              <form className="w-full space-y-3">
                {!expiredEmailState && (
                  <Input name="email" type="email" placeholder={t('emailAddress')} required onChange={(e) => setResendEmail(e.target.value)} className="h-11" />
                )}
                <SubmitButton formAction={handleSendOtpCode} className="w-full h-11 text-sm" pendingText="Sending…" disabled={!expiredEmailState && !resendEmail}>
                  Send verification code
                </SubmitButton>
              </form>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Lock screen + auth form ── */
  return (
    <div
      className="fixed inset-0 overflow-hidden cursor-pointer"
      onClick={() => phase === 'lock' && setPhase('form')}
    >
      {/* Wallpaper always visible */}
      <WallpaperBackground wallpaperId="brandmark" />

      {/* ── Lock phase: clock + hint ── */}
      <AnimatePresence>
        {phase === 'lock' && (
          <motion.div
            key="lock"
            className="absolute inset-0 z-10 flex flex-col pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            {/* Clock — upper area */}
            <motion.div
              className="flex justify-center pt-[12vh] sm:pt-[14vh]"
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            >
              <LiveClock />
            </motion.div>

            {/* Hint — bottom area */}
            <motion.div
              className="absolute bottom-[10vh] left-0 right-0 flex flex-col items-center gap-3"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="flex flex-col items-center gap-1.5">
                <p className="text-foreground/50 text-sm font-medium tracking-wide">
                  Kortix
                </p>
                <p className="text-foreground/25 text-xs tracking-widest uppercase">
                  Click or press Enter to sign in
                </p>
              </div>
              {/* Scroll indicator */}
              <motion.div
                animate={{ y: [0, 5, 0] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
              >
                <ChevronRight className="size-3.5 text-foreground/20 rotate-90" />
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Form phase: frosted glass card slides up ── */}
      <AnimatePresence>
        {phase === 'form' && (
          <motion.div
            key="form"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center cursor-default"
            onClick={() => setPhase('lock')}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            {/* Soft blur overlay */}
            <motion.div
              className="absolute inset-0 bg-background/20 backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
            />

            {/* Auth card — slides up from bottom */}
            <motion.div
              className="relative z-10 w-full max-w-[360px] mx-4"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, y: 40, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.97 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="bg-background/80 dark:bg-background/75 backdrop-blur-2xl border border-foreground/[0.06] rounded-[20px] px-7 py-8">
                {/* Shared header */}
                <p className="text-[11px] text-center text-foreground/30 tracking-[0.2em] uppercase mb-6">
                  Sign in to Kortix
                </p>

                {isPasswordMode ? (
                  /* ── Password auth (/auth?auth=password) ── */
                  <form className="space-y-3">
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      placeholder="Email"
                      required
                      autoComplete="email"
                      className="h-11 text-sm rounded-xl bg-foreground/[0.03] border-foreground/[0.08] shadow-none focus-visible:border-foreground/20 transition-colors"
                    />
                    <Input
                      id="password"
                      name="password"
                      type="password"
                      placeholder="Password"
                      required
                      autoComplete="current-password"
                      className="h-11 text-sm rounded-xl bg-foreground/[0.03] border-foreground/[0.08] shadow-none focus-visible:border-foreground/20 transition-colors"
                    />
                    <SubmitButton
                      formAction={handlePasswordAuth}
                      className="w-full h-11 text-[13px] font-medium rounded-xl shadow-none mt-1"
                      pendingText="Signing in…"
                    >
                      Sign in
                    </SubmitButton>
                  </form>
                ) : (
                  /* ── Cloud auth (Google + magic link) ── */
                  <>
                    {/* Google OAuth */}
                    <Suspense fallback={<div className="h-11 bg-foreground/[0.04] rounded-xl animate-pulse" />}>
                      <GoogleSignIn returnUrl={returnUrl} referralCode={referralCode} />
                    </Suspense>

                    {/* Divider */}
                    <div className="relative my-5">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-foreground/[0.06]" />
                      </div>
                      <div className="relative flex justify-center">
                        <span className="px-3 bg-background/80 dark:bg-background/75 text-[10px] text-foreground/20 tracking-[0.15em] uppercase">or</span>
                      </div>
                    </div>

                    {/* Email magic link form */}
                    <form className="space-y-3">
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        placeholder="Email"
                        required
                        autoComplete="email"
                        className="h-11 text-sm rounded-xl bg-foreground/[0.03] border-foreground/[0.08] shadow-none focus-visible:border-foreground/20 transition-colors"
                      />

                      {referralCodeParam && (
                        <div className="bg-foreground/[0.03] border border-foreground/[0.08] rounded-xl px-3 py-2">
                          <p className="text-[10px] text-foreground/35 mb-0.5">Referral</p>
                          <p className="text-[13px] font-semibold">{referralCode}</p>
                        </div>
                      )}
                      {!referralCodeParam && <input type="hidden" name="referralCode" value={referralCode} />}

                      {/* GDPR consent */}
                      <div className="flex items-center gap-2.5 pt-0.5">
                        <Checkbox
                          id="gdprConsent"
                          checked={acceptedTerms}
                          onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                          required
                          className="h-[14px] w-[14px] rounded-[4px] shrink-0"
                        />
                        <label htmlFor="gdprConsent" className="text-[11px] leading-[1.6] text-foreground/30 cursor-pointer select-none">
                          I agree to the{' '}
                          <a href="https://www.kortix.com/legal?tab=privacy" target="_blank" rel="noopener noreferrer" className="text-foreground/45 hover:text-foreground/65 transition-colors">
                            Privacy Policy
                          </a>
                          {' & '}
                          <a href="https://www.kortix.com/legal?tab=terms" target="_blank" rel="noopener noreferrer" className="text-foreground/45 hover:text-foreground/65 transition-colors">
                            Terms
                          </a>
                        </label>
                      </div>

                      <div className="relative pt-0.5">
                        <SubmitButton
                          formAction={handleAuth}
                          className="w-full h-11 text-[13px] font-medium rounded-xl shadow-none"
                          pendingText="Sending…"
                          disabled={!acceptedTerms}
                        >
                          Continue with email
                        </SubmitButton>
                        {wasEmailLastMethod && (
                          <div className="absolute -top-0.5 -right-1 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-background shadow-sm">
                            <div className="w-full h-full bg-emerald-500 rounded-full animate-pulse" />
                          </div>
                        )}
                      </div>
                    </form>

                    {/* Referral link */}
                    {!referralCodeParam && (
                      <div className="flex justify-center mt-4">
                        <button
                          type="button"
                          onClick={() => setShowReferralDialog(true)}
                          className="text-[11px] text-foreground/20 hover:text-foreground/40 transition-colors cursor-pointer"
                        >
                          Have a referral code?
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <ReferralCodeDialog
        open={showReferralDialog}
        onOpenChange={setShowReferralDialog}
        referralCode={referralCode}
        onCodeChange={(code) => { setReferralCode(code); setShowReferralDialog(false); }}
      />
    </div>
  );
}

/* ─── Self-hosted check ─────────────────────────────────────────────────── */

import { isSelfHosted, isBillingEnabled } from '@/lib/config';
import { SelfHostedForm, useInstallStatus } from '@/components/auth/self-hosted-auth';

function SelfHostedLoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();
  const { installed, loading: statusLoading } = useInstallStatus();
  const rawReturnUrl = searchParams.get('returnUrl') || searchParams.get('redirect');
  const returnUrl = sanitizeAuthReturnUrl(rawReturnUrl);
  const [phase, setPhase] = useState<'lock' | 'form'>('lock');

  // After auth, redirect to /instances. The /instances page handles
  // sandbox creation, and /instances/[id] handles setup (provider, keys).
  useEffect(() => {
    if (isLoading || !user) return;
    if (installed === false) return; // installer flow handles its own redirect
    router.replace(returnUrl);
  }, [isLoading, user, installed, returnUrl, router]);

  // Keyboard controls: Enter/Space opens form, Escape closes it
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (phase === 'lock' && (e.key === 'Enter' || e.key === ' ')) {
        setPhase('form');
      }
      if (phase === 'form' && e.key === 'Escape') {
        setPhase('lock');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [phase]);

  if (isLoading || statusLoading || (user && installed !== false)) {
    return <ConnectingScreen forceConnecting minimal title="Signing in" />;
  }

  // Lock screen → frosted glass auth form
  return (
    <div
      className="fixed inset-0 overflow-hidden cursor-pointer"
      onClick={() => phase === 'lock' && setPhase('form')}
    >
      <WallpaperBackground wallpaperId="brandmark" />

      {/* ── Lock phase: clock + hint ── */}
      <AnimatePresence>
        {phase === 'lock' && (
          <motion.div
            key="lock"
            className="absolute inset-0 z-10 flex flex-col pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            <motion.div
              className="flex justify-center pt-[12vh] sm:pt-[14vh]"
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            >
              <LiveClock />
            </motion.div>
            <motion.div
              className="absolute bottom-[10vh] left-0 right-0 flex flex-col items-center gap-3"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="flex flex-col items-center gap-1.5">
                <p className="text-foreground/50 text-sm font-medium tracking-wide">Kortix</p>
                <p className="text-foreground/25 text-xs tracking-widest uppercase">Click or press Enter to sign in</p>
              </div>
              <motion.div
                animate={{ y: [0, 5, 0] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
              >
                <ChevronRight className="size-3.5 text-foreground/20 rotate-90" />
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Form phase: frosted glass card with SelfHostedForm ── */}
      <AnimatePresence>
        {phase === 'form' && (
          <motion.div
            key="form"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center cursor-default"
            onClick={() => setPhase('lock')}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <motion.div
              className="absolute inset-0 bg-background/20 backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
            />
            <motion.div
              className="relative z-10 w-full max-w-[400px] mx-4"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, y: 40, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.97 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="bg-background/75 dark:bg-background/70 backdrop-blur-2xl border border-foreground/[0.08] rounded-2xl p-7 max-h-[calc(100vh-4rem)] overflow-y-auto">

                <SelfHostedForm
                  returnUrl={returnUrl}
                  installed={installed}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── Default export ────────────────────────────────────────────────────── */

export default function Login() {
  if (isSelfHosted()) {
    return (
      <Suspense fallback={<ConnectingScreen forceConnecting minimal title="Signing in" />}>
        <>
          <AuthBrowserNoiseGuard />
          <SelfHostedLoginContent />
        </>
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<ConnectingScreen forceConnecting minimal title="Signing in" />}>
      <>
        <AuthBrowserNoiseGuard />
        <LoginContent />
      </>
    </Suspense>
  );
}
