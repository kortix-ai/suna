'use client';

import { useTranslations } from 'next-intl';

/**
 * Unified auth — wallpaper + lock-screen UX, password-based register + login.
 *
 * Identical in local and cloud. The only mode-dependent piece is whether
 * Supabase requires email confirmation (Supabase config, not ENV_MODE).
 * Email auth methods and social providers render only when listed in
 * `NEXT_PUBLIC_AUTH_METHODS` / `NEXT_PUBLIC_AUTH_PROVIDERS` — never as a
 * hardcoded surface.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, ChevronRight } from 'lucide-react';

import {
  signIn as signInWithMagicLink,
  signInWithPassword,
  signUp as signUpWithMagicLink,
  signUpWithPassword,
} from './actions';
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

const GoogleSignIn = lazy(() => import('@/components/GoogleSignIn'));

type Mode = 'signin' | 'signup';
type AuthMethod = 'magic' | 'password';

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
        className="text-foreground/35 text-sm font-light tracking-widest"
        suppressHydrationWarning
      >
        {day} {month} {date}
      </p>
      <p
        className="text-foreground/80 text-7xl sm:text-8xl font-extralight leading-none -tracking-[0.02em] tabular-nums"
        suppressHydrationWarning
      >
        {h}:{m}
      </p>
    </div>
  );
}

/* ─── Form inside the frosted-glass card ───────────────────────────────── */

function AuthCardForm({ returnUrl }: { returnUrl: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signup');
  const enabledMethods = useMemo(() => {
    const raw = getEnv().AUTH_METHODS || 'magic,password';
    const parsed = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is AuthMethod => s === 'magic' || s === 'password');
    return parsed.length ? parsed : ['magic', 'password'];
  }, []);
  const magicLinkEnabled = enabledMethods.includes('magic');
  const passwordEnabled = enabledMethods.includes('password');
  const [method, setMethod] = useState<AuthMethod>(magicLinkEnabled ? 'magic' : 'password');
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const enabledProviders = useMemo(() => {
    const raw = getEnv().AUTH_PROVIDERS || '';
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }, []);
  const googleEnabled = enabledProviders.includes('google');

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);
    setInfo(null);
    setPending(true);

    const form = e.currentTarget;
    const formData = new FormData(form);
    formData.set('returnUrl', returnUrl);
    formData.set('origin', window.location.origin);
    if (method === 'magic' && mode === 'signup') {
      formData.set('acceptedTerms', 'true');
    }

    try {
      const result =
        method === 'magic'
          ? mode === 'signup'
            ? await signUpWithMagicLink(null, formData)
            : await signInWithMagicLink(null, formData)
          : mode === 'signup'
            ? await signUpWithPassword(null, formData)
            : await signInWithPassword(null, formData);

      if (
        result &&
        typeof result === 'object' &&
        'message' in result &&
        (!('success' in result) || !(result as any).success)
      ) {
        const msg = result.message as string;
        setErrorMessage(msg);
        toast.error(msg);
        return;
      }

      if (result && method === 'magic' && (result as any).success) {
        setInfo((result as any).message || 'Check your email for a magic link');
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
            'px-5 py-1.5 rounded-full text-sm font-medium transition-colors',
            mode === 'signin'
              ? 'bg-background/80 text-foreground shadow-sm'
              : 'text-foreground/50 hover:text-foreground/80',
          )}
        >{tHardcodedUi.raw('appAuthPage.line167JsxTextSignIn')}</button>
        <button
          type="button"
          onClick={() => {
            setMode('signup');
            setErrorMessage(null);
            setInfo(null);
          }}
          className={cn(
            'px-5 py-1.5 rounded-full text-sm font-medium transition-colors',
            mode === 'signup'
              ? 'bg-background/80 text-foreground shadow-sm'
              : 'text-foreground/50 hover:text-foreground/80',
          )}
        >
          Register
        </button>
      </div>

      <div className="flex flex-col items-center mb-5">
        <h1 className="text-base font-medium text-foreground/90 tracking-tight">
          {mode === 'signup' ? 'Create your account' : 'Sign in to Kortix'}
        </h1>
        <p className="text-sm text-foreground/40 mt-0.5">
          {method === 'magic'
            ? 'We will email you a secure sign-in link'
            : mode === 'signup'
              ? 'Email and password is all you need'
              : 'Your AI Computer'}
        </p>
      </div>

      {errorMessage && (
        <div className="mb-4 p-3 rounded-2xl flex items-center gap-2 bg-destructive/10 border border-destructive/20 text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm">{errorMessage}</span>
        </div>
      )}

      {info && (
        <div className="mb-4 p-3 rounded-2xl flex items-center gap-2 bg-foreground/[0.05] border border-foreground/[0.08] text-foreground/80">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm">{info}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          id="email"
          name="email"
          type="email"
          aria-label={tHardcodedUi.raw('appAuthPage.line215JsxAttrPlaceholderEmailAddress')}
          placeholder={tHardcodedUi.raw('appAuthPage.line215JsxAttrPlaceholderEmailAddress')}
          required
          autoComplete="email"
          className="text-sm"
        />
        {method === 'password' && (
          <>
            <Input
              id="password"
              name="password"
              type="password"
              aria-label="Password"
              placeholder="Password"
              required
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              className="text-sm"
            />
            {mode === 'signup' && (
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                aria-label={tHardcodedUi.raw('appAuthPage.line234JsxAttrPlaceholderConfirmPassword')}
                placeholder={tHardcodedUi.raw('appAuthPage.line234JsxAttrPlaceholderConfirmPassword')}
                required
                autoComplete="new-password"
                className="text-sm"
              />
            )}
          </>
        )}

        <Button
          type="submit"
          size="lg"
          disabled={pending}
          className="w-full text-sm"
        >
          {pending
            ? method === 'magic'
              ? 'Sending link…'
              : mode === 'signup'
                ? 'Creating account…'
                : 'Signing in…'
            : method === 'magic'
              ? 'Email me a sign-in link'
              : mode === 'signup'
                ? 'Create account'
                : 'Sign in'}
        </Button>
      </form>

      {magicLinkEnabled && passwordEnabled && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => {
              setMethod(method === 'magic' ? 'password' : 'magic');
              setErrorMessage(null);
              setInfo(null);
            }}
            className="text-xs text-foreground/40 hover:text-foreground/70 underline-offset-4 hover:underline"
          >
            {method === 'magic' ? 'Use password instead' : 'Use email link instead'}
          </button>
        </div>
      )}

      {/* Social providers — only when configured */}
      {googleEnabled && (
        <>
          <div className="my-5 flex items-center gap-3">
            <div className="flex-1 h-px bg-foreground/[0.08]" />
            <span className="text-xs uppercase tracking-wider text-foreground/40">or</span>
            <div className="flex-1 h-px bg-foreground/[0.08]" />
          </div>
          <Suspense fallback={null}>
            <GoogleSignIn returnUrl={returnUrl} />
          </Suspense>
        </>
      )}

      {mode === 'signin' && passwordEnabled && (
        <div className="mt-5 text-center">
          <Link
            href="/auth/forgot-password"
            className="text-xs text-foreground/40 hover:text-foreground/70 underline-offset-4 hover:underline"
          >{tHardcodedUi.raw('appAuthPage.line277JsxTextForgotYourPassword')}</Link>
        </div>
      )}
    </div>
  );
}

/* ─── Lock-screen → frosted-glass form ─────────────────────────────────── */

function AuthContent() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();
  const returnUrl = sanitizeAuthReturnUrl(
    searchParams.get('returnUrl') || searchParams.get('redirect'),
  );
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
    return <ConnectingScreen forceConnecting minimal title={tHardcodedUi.raw('appAuthPage.line317JsxAttrTitleSigningIn')} />;
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
                <p className="text-foreground/25 text-xs tracking-widest uppercase">{tHardcodedUi.raw('appAuthPage.line355JsxTextClickOrPressEnterToSignIn')}</p>
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
                <AuthCardForm returnUrl={returnUrl} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function AuthPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <Suspense fallback={<ConnectingScreen forceConnecting minimal title={tHardcodedUi.raw('appAuthPage.line408JsxAttrTitleSigningIn')} />}>
      <>
        <AuthBrowserNoiseGuard />
        <AuthContent />
      </>
    </Suspense>
  );
}
