'use client';

/**
 * Unified auth — wallpaper + lock-screen UX, password-based register + login.
 *
 * Identical in local and cloud. The only mode-dependent piece is whether
 * Supabase requires email confirmation (Supabase config, not ENV_MODE).
 * Social providers (Google, etc.) render only when listed in
 * `NEXT_PUBLIC_AUTH_PROVIDERS` — never as a hardcoded surface.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, ChevronRight, Loader2, ShieldCheck } from 'lucide-react';

import { signInWithPassword, signUpWithPassword } from './actions';
import { useAuth } from '@/components/AuthProvider';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { AuthBrowserNoiseGuard } from '@/components/auth/auth-browser-noise-guard';
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { invalidateTokenCache, setBootstrapAuthToken } from '@/lib/auth-token';
import { createClient as createBrowserSupabaseClient } from '@/lib/supabase/client';
import { getEnv } from '@/lib/env-config';
import { authRedirectUrl } from '@/lib/desktop';
import { resolveSsoDomainPolicy } from '@/lib/sso-client';

const GoogleSignIn = lazy(() => import('@/components/GoogleSignIn'));

type Mode = 'signin' | 'signup';

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
      <p
        className="text-foreground/35 text-[13px] font-light tracking-widest"
        suppressHydrationWarning
      >
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

/* ─── Form inside the frosted-glass card ───────────────────────────────── */

function AuthCardForm({
  returnUrl,
  initialEmail = '',
  initialError = null,
}: {
  returnUrl: string;
  initialEmail?: string;
  initialError?: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [pending, setPending] = useState(false);
  const [ssoPending, setSsoPending] = useState(false);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (initialError) setErrorMessage(initialError);
  }, [initialError]);

  const enabledProviders = useMemo(() => {
    const raw = getEnv().AUTH_PROVIDERS || '';
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }, []);
  const googleEnabled = enabledProviders.includes('google');
  const ssoEnabled = enabledProviders.includes('sso') || enabledProviders.includes('saml');

  const handleSsoSignIn = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setErrorMessage('Enter your work email to continue with SSO');
      return;
    }

    setErrorMessage(null);
    setInfo(null);
    setSsoPending(true);
    try {
      const policy = await resolveSsoDomainPolicy(trimmedEmail);
      if (!policy.sso_available || (!policy.provider_id && !policy.domain)) {
        const msg = 'SSO is not configured for this email domain';
        setErrorMessage(msg);
        toast.error(msg);
        return;
      }

      const callbackPath = `/auth/callback${returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : ''}`;
      const supabase = createBrowserSupabaseClient();
      const provider = policy.provider_id
        ? { providerId: policy.provider_id }
        : { domain: policy.domain || '' };
      const { error } = await supabase.auth.signInWithSSO({
        ...provider,
        options: {
          redirectTo: authRedirectUrl(callbackPath),
        },
      });
      if (error) throw error;
    } catch (err: any) {
      const msg = err?.message || 'Failed to start SSO sign-in';
      setErrorMessage(msg);
      toast.error(msg);
      setSsoPending(false);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);
    setInfo(null);
    setPending(true);

    const form = e.currentTarget;
    const formData = new FormData(form);
    formData.set('returnUrl', returnUrl);
    formData.set('origin', window.location.origin);

    try {
      const policy = await resolveSsoDomainPolicy(email.trim());
      if (policy.sso_required) {
        const msg = `${policy.account_name || policy.domain} requires SSO. Continue with SSO to sign in.`;
        setErrorMessage(msg);
        toast.error(msg);
        return;
      }

      const result =
        mode === 'signup'
          ? await signUpWithPassword(null, formData)
          : await signInWithPassword(null, formData);

      if (
        result &&
        typeof result === 'object' &&
        'message' in result &&
        !('success' in result)
      ) {
        const msg = result.message as string;
        setErrorMessage(msg);
        toast.error(msg);
        return;
      }

      if (result && (result as any).requiresEmailConfirmation) {
        setInfo((result as any).message || 'Check your email to confirm your account');
        return;
      }

      const tokens = result as { accessToken?: string | null; refreshToken?: string | null };
      if (tokens.accessToken && tokens.refreshToken) {
        try {
          const supabase = createBrowserSupabaseClient();
          await supabase.auth.setSession({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
          });
          setBootstrapAuthToken(tokens.accessToken);
          invalidateTokenCache();
        } catch {
          // Server cookies still carry the session; fall through to redirect.
        }
      }

      const dest = (result as any)?.redirectTo || returnUrl;
      router.push(dest);
      router.refresh();
    } catch (err: any) {
      if (err?.digest?.startsWith('NEXT_REDIRECT')) return;
      const msg = err?.message || 'An unexpected error occurred';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      {/* Tabs */}
      <div className="flex items-center gap-1 mb-5 bg-foreground/[0.05] rounded-full p-1 w-fit mx-auto">
        <button
          type="button"
          onClick={() => {
            setMode('signin');
            setErrorMessage(null);
            setInfo(null);
          }}
          className={cn(
            'px-5 py-1.5 rounded-full text-[13px] font-medium transition-colors',
            mode === 'signin'
              ? 'bg-background/80 text-foreground shadow-sm'
              : 'text-foreground/50 hover:text-foreground/80',
          )}
        >
          Sign in
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('signup');
            setErrorMessage(null);
            setInfo(null);
          }}
          className={cn(
            'px-5 py-1.5 rounded-full text-[13px] font-medium transition-colors',
            mode === 'signup'
              ? 'bg-background/80 text-foreground shadow-sm'
              : 'text-foreground/50 hover:text-foreground/80',
          )}
        >
          Register
        </button>
      </div>

      <div className="flex flex-col items-center mb-5">
        <h1 className="text-[17px] font-medium text-foreground/90 tracking-tight">
          {mode === 'signup' ? 'Create your account' : 'Sign in to Kortix'}
        </h1>
        <p className="text-[13px] text-foreground/40 mt-0.5">
          {mode === 'signup' ? 'Email and password is all you need' : 'Your AI Computer'}
        </p>
      </div>

      {errorMessage && (
        <div className="mb-4 p-3 rounded-2xl flex items-center gap-2 bg-destructive/10 border border-destructive/20 text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span className="text-[13px]">{errorMessage}</span>
        </div>
      )}

      {info && (
        <div className="mb-4 p-3 rounded-2xl flex items-center gap-2 bg-foreground/[0.05] border border-foreground/[0.08] text-foreground/80">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span className="text-[13px]">{info}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          id="email"
          name="email"
          type="email"
          placeholder="Email address"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="email"
          className="h-11 text-[15px] bg-foreground/[0.04] border-foreground/[0.08] rounded-xl shadow-none"
        />
        <Input
          id="password"
          name="password"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          className="h-11 text-[15px] bg-foreground/[0.04] border-foreground/[0.08] rounded-xl shadow-none"
        />
        {mode === 'signup' && (
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            autoComplete="new-password"
            className="h-11 text-[15px] bg-foreground/[0.04] border-foreground/[0.08] rounded-xl shadow-none"
          />
        )}

        <Button
          type="submit"
          disabled={pending}
          className="w-full h-11 text-[13px] rounded-xl shadow-none"
        >
          {pending
            ? mode === 'signup'
              ? 'Creating account…'
              : 'Signing in…'
            : mode === 'signup'
              ? 'Create account'
              : 'Sign in'}
        </Button>
      </form>

      {/* Social providers — only when configured */}
      {(googleEnabled || ssoEnabled) && (
        <>
          <div className="my-5 flex items-center gap-3">
            <div className="flex-1 h-px bg-foreground/[0.08]" />
            <span className="text-[11px] uppercase tracking-wider text-foreground/40">or</span>
            <div className="flex-1 h-px bg-foreground/[0.08]" />
          </div>
          {ssoEnabled && (
            <Button
              onClick={handleSsoSignIn}
              disabled={pending || ssoPending}
              variant="outline"
              size="lg"
              className="mb-3 w-full h-11 rounded-xl"
              type="button"
            >
              {ssoPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              <span>{ssoPending ? 'Starting SSO...' : 'Continue with SSO'}</span>
            </Button>
          )}
          {googleEnabled && (
            <Suspense fallback={null}>
              <GoogleSignIn returnUrl={returnUrl} />
            </Suspense>
          )}
        </>
      )}

      {mode === 'signin' && (
        <div className="mt-5 text-center">
          <Link
            href="/auth/reset-password"
            className="text-[12px] text-foreground/40 hover:text-foreground/70 underline-offset-4 hover:underline"
          >
            Forgot your password?
          </Link>
        </div>
      )}
    </div>
  );
}

/* ─── Lock-screen → frosted-glass form ─────────────────────────────────── */

function AuthContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();
  const returnUrl = sanitizeAuthReturnUrl(
    searchParams.get('returnUrl') || searchParams.get('redirect'),
  );
  const initialEmail = searchParams.get('email') || '';
  const initialError =
    searchParams.get('error') === 'sso_required'
      ? 'SSO is required for this email domain. Continue with SSO to sign in.'
      : null;
  const [phase, setPhase] = useState<'lock' | 'form'>('lock');

  // After auth, leave the auth flow.
  useEffect(() => {
    if (isLoading || !user) return;
    router.replace(returnUrl);
  }, [isLoading, user, returnUrl, router]);

  // Keyboard: Enter/Space opens form, Escape closes it.
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

  if (isLoading || user) {
    return <ConnectingScreen forceConnecting minimal title="Signing in" />;
  }

  return (
    <div
      className="fixed inset-0 overflow-hidden cursor-pointer"
      onClick={() => phase === 'lock' && setPhase('form')}
    >
      <WallpaperBackground wallpaperId="brandmark" />

      {/* Lock phase: clock + hint */}
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
                <p className="text-foreground/25 text-xs tracking-widest uppercase">
                  Click or press Enter to sign in
                </p>
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

      {/* Form phase */}
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
                    <AuthCardForm
                      returnUrl={returnUrl}
                      initialEmail={initialEmail}
                      initialError={initialError}
                    />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={<ConnectingScreen forceConnecting minimal title="Signing in" />}>
      <>
        <AuthBrowserNoiseGuard />
        <AuthContent />
      </>
    </Suspense>
  );
}
