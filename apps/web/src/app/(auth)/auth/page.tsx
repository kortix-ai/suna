'use client';

/**
 * Unified auth — quiet, flat, staged UX (email → credentials → code).
 *
 * Identical in local and cloud. The only mode-dependent piece is whether
 * Supabase requires email confirmation (Supabase config, not a billing flag).
 * Email auth methods and social providers render only when listed in
 * `NEXT_PUBLIC_AUTH_METHODS` / `NEXT_PUBLIC_AUTH_PROVIDERS` — never as a
 * hardcoded surface.
 */

import { Eye, EyeOff } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { AuthBrowserNoiseGuard } from '@/features/auth/auth-browser-noise-guard';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import {
  AuthTrustCue,
  CodeInput,
  FieldLabel,
  InfoStrip,
  StepHeader,
} from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { invalidateTokenCache, setBootstrapAuthToken } from '@/lib/auth-token';
import { buildMobileSessionHandoffUrl } from '@/lib/auth/mobile-handoff';
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';
import { authRedirectUrl } from '@/lib/desktop';
import { getEnv } from '@/lib/env-config';
import { emailDomain, isWorkEmail } from '@/lib/personal-email';
import { createClient as createBrowserSupabaseClient } from '@/lib/supabase/client';
import {
  signIn as signInWithMagicLink,
  signInWithPassword,
  signUp as signUpWithMagicLink,
  signUpWithPassword,
  verifyOtp,
} from './actions';

const GoogleSignIn = lazy(() => import('@/features/auth/google-signin'));

type Mode = 'signin' | 'signup';
type AuthMethod = 'magic' | 'password';
type Step = 'entry' | 'credentials' | 'code';

const RESEND_COOLDOWN_SECONDS = 30;
const EASE = [0.23, 1, 0.32, 1] as const;

/* ─── Small shared pieces ──────────────────────────────────────────────── */

function PasswordInput({
  id,
  name,
  placeholder,
  autoComplete,
  autoFocus,
  invalid,
}: {
  id: string;
  name: string;
  placeholder: string;
  autoComplete: string;
  autoFocus?: boolean;
  invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type={show ? 'text' : 'password'}
        size="md"
        placeholder={placeholder}
        required
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        className="pr-10"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center transition-colors"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

/* ─── The staged auth flow ─────────────────────────────────────────────── */

function AuthCardForm({
  mode,
  onModeChange,
  returnUrl,
  mobileCallbackState,
}: {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  returnUrl: string;
  mobileCallbackState: string | null;
}) {
  const router = useRouter();
  const prefersReducedMotion = useReducedMotion();
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

  const [step, setStep] = useState<Step>('entry');
  const [email, setEmail] = useState('');
  // Which button kicked off the in-flight request — every action button
  // disables while anything is pending, but only the clicked one spins.
  const [pendingAction, setPendingAction] = useState<'continue' | 'code' | 'resend' | null>(null);
  const pending = pendingAction !== null;
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // After a magic-link email is sent, the same email also carries a 6-digit
  // code. We keep the sent-to address around so the user can paste the code
  // directly (links sometimes break across mail clients / new tabs).
  const [sentEmail, setSentEmail] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const lastTriedCode = useRef('');
  const emailRef = useRef<HTMLInputElement>(null);

  // Gentle two-part entrance per step: header first, body 60ms behind.
  const rise = (delay = 0) => ({
    initial: { opacity: 0, y: prefersReducedMotion ? 0 : 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.3, delay, ease: EASE },
  });

  useEffect(() => {
    if (step !== 'code' || resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(t);
  }, [step, resendIn]);

  const enabledProviders = useMemo(() => {
    const raw = getEnv().AUTH_PROVIDERS || '';
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }, []);
  const googleEnabled = enabledProviders.includes('google');

  const clearNotices = () => {
    setErrorMessage(null);
    setInfo(null);
  };

  // Errors surface as a toast plus a shake on the offending field — no inline
  // block. `errorMessage` sticks around only to drive aria-invalid; clearing
  // it before each attempt lets the shake replay on repeat failures.
  const failWith = (msg: string) => {
    setErrorMessage(msg);
    errorToast(msg);
  };

  const goToEntry = () => {
    clearNotices();
    setSentEmail(null);
    setCode('');
    setStep('entry');
  };

  const switchMode = (next: Mode) => {
    onModeChange(next);
    clearNotices();
  };

  const establishSessionAndRedirect = async (result: any) => {
    const mobileHandoffUrl = result?.mobileHandoffUrl as string | null | undefined;
    if (mobileHandoffUrl) {
      window.location.assign(mobileHandoffUrl);
      return;
    }

    // Establish the session on the CLIENT immediately so useAuth() sees the
    // user synchronously and the redirect is instant — without this the
    // client waits for a background refresh and bounces back to /auth.
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

    const dest = result?.redirectTo || returnUrl;
    router.push(dest);
    router.refresh();
  };

  const buildBaseFormData = (target: string) => {
    const formData = new FormData();
    formData.set('email', target);
    formData.set('returnUrl', returnUrl);
    formData.set('origin', window.location.origin);
    if (mobileCallbackState) {
      formData.set('mobileCallback', 'true');
      formData.set('mobileCallbackState', mobileCallbackState);
    }
    return formData;
  };

  const sendMagic = async (to?: string, source: 'continue' | 'code' | 'resend' = 'code') => {
    const target = (to ?? email).trim();
    if (!target) return;
    clearNotices();
    setPendingAction(source);

    try {
      const formData = buildBaseFormData(target);
      if (mode === 'signup') formData.set('acceptedTerms', 'true');

      const result =
        mode === 'signup'
          ? await signUpWithMagicLink(null, formData)
          : await signInWithMagicLink(null, formData);

      if (result && (result as any).success) {
        setSentEmail((result as any).email || target);
        setCode('');
        lastTriedCode.current = '';
        setResendIn(RESEND_COOLDOWN_SECONDS);
        setStep('code');
      } else if (result && 'message' in result) {
        failWith((result as any).message as string);
      }
    } catch (err: any) {
      if (err?.digest?.startsWith('NEXT_REDIRECT')) return;
      failWith(err?.message || 'An unexpected error occurred');
    } finally {
      setPendingAction(null);
    }
  };

  const handleEntryContinue = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    clearNotices();
    setPendingAction('continue');

    // Enterprise home-realm discovery — zero-config. When the address is a WORK
    // email (isWorkEmail skiplists gmail/outlook/… in-memory, so consumer logins
    // never reach the network) whose domain is bound to a SAML provider, hand off
    // to the IdP instead of magic-link/password. signInWithSSO returns
    // { data: { url } } for a matching domain and an error otherwise, so a work
    // domain with no provider — or a Supabase without SAML enabled — falls
    // straight through to the email flow below. Runs in both sign-in and sign-up
    // (an SSO user is JIT-provisioned on first login). `emailDomain` mirrors the
    // parser isWorkEmail used, so we probe exactly the domain it validated.
    // "SSO required" enforcement is a server-side concern; this is opportunistic
    // routing with the email flow as the always-present fallback.
    try {
      const domain = emailDomain(trimmed);
      if (domain && isWorkEmail(trimmed)) {
        try {
          const supabase = createBrowserSupabaseClient();
          const callbackParams = new URLSearchParams();
          if (returnUrl) callbackParams.set('returnUrl', returnUrl);
          if (mobileCallbackState) {
            callbackParams.set('mobile_callback', '1');
            callbackParams.set('state', mobileCallbackState);
          }
          const callbackPath = `${mobileCallbackState ? '/auth/mobile/callback' : '/auth/callback'}${
            callbackParams.size ? `?${callbackParams.toString()}` : ''
          }`;
          const { data, error } = await supabase.auth.signInWithSSO({
            domain,
            // We own the redirect (below) so authRedirectUrl's desktop `?desktop=true`
            // bounce stays authoritative; without skipBrowserRedirect, auth-js also
            // calls window.location.assign(data.url) — a redundant double-navigation.
            options: { redirectTo: authRedirectUrl(callbackPath), skipBrowserRedirect: true },
          });
          if (!error && data?.url) {
            // Full navigation to the IdP; the callback route exchanges the code
            // on return (same PKCE path as Google OAuth).
            window.location.href = data.url;
            return;
          }
          // Work domain with no SAML provider → fall through to magic/password.
        } catch {
          // SAML not enabled on this Supabase, or a transient error — fall through.
        }
      }

      // Magic link is the default path: Continue emails a code and lands the
      // user on the code step. Password is the secondary route, reachable from
      // the button below the form — so it only loads for people who want it.
      if (magicLinkEnabled) {
        await sendMagic(trimmed, 'continue');
        return;
      }
      setStep('credentials');
    } finally {
      setPendingAction(null);
    }
  };

  // Escape hatch off the code step for people who'd rather type a password.
  // The address can live in either field depending on how the step was reached,
  // and the credentials step renders it read-only from `email` — so settle on
  // one before switching, and bounce focus back if we somehow have neither.
  const goToPassword = () => {
    const target = (email || sentEmail || '').trim();
    if (!target) {
      emailRef.current?.focus();
      return;
    }
    if (email !== target) setEmail(target);
    clearNotices();
    setCode('');
    setStep('credentials');
  };

  const handleCredentialsSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    clearNotices();
    setPendingAction('continue');

    const formData = new FormData(e.currentTarget);
    formData.set('email', email.trim());
    formData.set('returnUrl', returnUrl);
    formData.set('origin', window.location.origin);
    if (mobileCallbackState) {
      formData.set('mobileCallback', 'true');
      formData.set('mobileCallbackState', mobileCallbackState);
    }
    if (mode === 'signup') {
      // Single password field (with reveal toggle) — the server still expects
      // a confirmation value, so mirror it.
      formData.set('confirmPassword', (formData.get('password') as string) || '');
      formData.set('acceptedTerms', 'true');
    }

    try {
      const result =
        mode === 'signup'
          ? await signUpWithPassword(null, formData)
          : await signInWithPassword(null, formData);

      if (
        result &&
        typeof result === 'object' &&
        'message' in result &&
        (!('success' in result) || !(result as any).success) &&
        !(result as any).requiresEmailConfirmation
      ) {
        failWith(result.message as string);
        return;
      }

      if (result && (result as any).requiresEmailConfirmation) {
        setInfo((result as any).message || 'Check your email to confirm your account');
        return;
      }

      await establishSessionAndRedirect(result);
    } catch (err: any) {
      if (err?.digest?.startsWith('NEXT_REDIRECT')) return;
      failWith(err?.message || 'An unexpected error occurred');
    } finally {
      setPendingAction(null);
    }
  };

  const verifyCode = async () => {
    if (!sentEmail || code.length !== 6) return;
    setErrorMessage(null);
    setVerifying(true);

    const formData = buildBaseFormData(sentEmail);
    formData.set('token', code);

    try {
      const result = await verifyOtp(null, formData);

      if (result && (!('success' in result) || !(result as any).success)) {
        failWith(((result as any).message as string) || 'Invalid or expired code');
        return;
      }

      await establishSessionAndRedirect(result);
    } catch (err: any) {
      if (err?.digest?.startsWith('NEXT_REDIRECT')) return;
      failWith(err?.message || 'An unexpected error occurred');
    } finally {
      setVerifying(false);
    }
  };

  // Auto-verify the moment the sixth digit lands — no extra button press.
  useEffect(() => {
    if (step === 'code' && code.length === 6 && !verifying && lastTriedCode.current !== code) {
      lastTriedCode.current = code;
      void verifyCode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, step, verifying]);

  const handleResend = async () => {
    if (!sentEmail || pending || resendIn > 0) return;
    await sendMagic(sentEmail, 'resend');
  };

  /* ── Code step ── */
  if (step === 'code') {
    return (
      <>
        <motion.div {...rise(0)}>
          <StepHeader
            title="Check your email"
            description={
              <>
                We sent a code to{' '}
                <span className="text-foreground font-medium break-words">{sentEmail}</span>
              </>
            }
          />
        </motion.div>

        <motion.div {...rise(0.06)}>
          {info && <InfoStrip message={info} />}

          <CodeInput
            value={code}
            onChange={(next) => {
              if (errorMessage) setErrorMessage(null);
              setCode(next);
            }}
            disabled={verifying}
            invalid={!!errorMessage}
          />

          <div className="text-muted-foreground mt-6 space-y-2 text-sm">
            {verifying ? (
              <div className="flex items-center gap-2">
                <Loading className="text-muted-foreground size-4 shrink-0" />
                <span>Verifying…</span>
              </div>
            ) : (
              <>
                <p>
                  Didn&apos;t receive a code?{' '}
                  {resendIn > 0 ? (
                    <span className="tabular-nums">Resend in {resendIn}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={pending}
                      className="text-foreground underline-offset-4 hover:underline disabled:opacity-50"
                    >
                      {pendingAction === 'resend' ? 'Sending…' : 'Resend'}
                    </button>
                  )}
                </p>
                {/* The two ways off this step, side by side — same weight, same
                    dialect as the resend line above. `-my-2 py-2` grows the hit
                    area to ~40px without opening a gap between the rows. */}
                <p className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={goToEntry}
                    className="hover:text-foreground -my-2 py-2 underline-offset-4 transition-colors hover:underline"
                  >
                    Use a different email
                  </button>
                  {passwordEnabled && (
                    <>
                      <span aria-hidden className="text-muted-foreground/40 select-none">
                        ·
                      </span>
                      <button
                        type="button"
                        onClick={goToPassword}
                        disabled={pending}
                        className="hover:text-foreground -my-2 py-2 underline-offset-4 transition-colors hover:underline disabled:opacity-50"
                      >
                        Use password instead
                      </button>
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        </motion.div>
      </>
    );
  }

  /* ── Credentials step (password, with email-code alternative) ── */
  if (step === 'credentials') {
    return (
      <>
        <motion.div {...rise(0)}>
          <StepHeader title={mode === 'signup' ? 'Create your password' : 'Enter your password'} />
        </motion.div>

        <motion.div {...rise(0.06)}>
          {info && <InfoStrip message={info} />}

          <form onSubmit={handleCredentialsSubmit} className="space-y-5">
            <div className="space-y-3">
              <FieldLabel htmlFor="email-locked">Email</FieldLabel>
              <div className="relative">
                <Input
                  id="email-locked"
                  value={email}
                  readOnly
                  tabIndex={-1}
                  size="md"
                  className="text-muted-foreground pr-14"
                />
                <button
                  type="button"
                  onClick={goToEntry}
                  aria-label="Change email"
                  className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex items-center px-3 text-sm font-medium transition-colors"
                >
                  Edit
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="password">Password</FieldLabel>
                {mode === 'signin' && (
                  <Link
                    href="/auth/forgot-password"
                    className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Forgot your password?
                  </Link>
                )}
              </div>
              <PasswordInput
                id="password"
                name="password"
                placeholder={mode === 'signup' ? 'Create a password' : 'Your password'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                autoFocus
                invalid={!!errorMessage}
              />
            </div>

            <Button type="submit" size="lg" disabled={pending} className="w-full">
              {pendingAction === 'continue' ? <Loading className="size-4 shrink-0" /> : null}
              Continue
            </Button>
          </form>

          {magicLinkEnabled && (
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="mt-3 w-full"
              onClick={() => sendMagic()}
              disabled={pending}
            >
              {pendingAction === 'code' ? (
                <Loading className="text-foreground! size-4 shrink-0" />
              ) : null}
              {mode === 'signup' ? 'Continue with email code' : 'Email sign-in code'}
            </Button>
          )}
        </motion.div>
      </>
    );
  }

  /* ── Entry step ── */
  return (
    <>
      <motion.div {...rise(0)}>
        <StepHeader
          title={mode === 'signup' ? 'Create your account' : 'Welcome to Kortix'}
          tagline="Your AI Command Center"
        />
      </motion.div>

      <motion.div {...rise(0.06)}>
        {info && <InfoStrip message={info} />}

        {googleEnabled && (
          <div className="mb-8">
            <Suspense fallback={null}>
              <GoogleSignIn
                returnUrl={returnUrl}
                mobileCallbackState={mobileCallbackState ?? undefined}
              />
            </Suspense>
          </div>
        )}

        <form onSubmit={handleEntryContinue} className="space-y-5">
          <div className="space-y-3">
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              ref={emailRef}
              id="email"
              name="email"
              type="email"
              size="md"
              placeholder="Your email address"
              value={email}
              onChange={(e) => {
                if (errorMessage) setErrorMessage(null);
                setEmail(e.target.value);
              }}
              required
              autoComplete="email"
              autoFocus
              aria-invalid={!!errorMessage || undefined}
            />
          </div>
          <Button type="submit" size="lg" disabled={pending} className="w-full">
            {pendingAction === 'continue' ? <Loading className="size-4 shrink-0" /> : null}
            Continue
          </Button>
        </form>

        <p className="text-muted-foreground mt-8 text-sm">
          {mode === 'signup' ? 'Already have an account? ' : "Don't have an account? "}
          <button
            type="button"
            onClick={() => switchMode(mode === 'signup' ? 'signin' : 'signup')}
            className="text-foreground underline-offset-4 hover:underline"
          >
            {mode === 'signup' ? 'Sign in' : 'Sign up'}
          </button>
        </p>
      </motion.div>
    </>
  );
}

/* ─── Page shell ───────────────────────────────────────────────────────── */

function AuthContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, session, isLoading } = useAuth();
  const returnUrl = sanitizeAuthReturnUrl(
    searchParams.get('returnUrl') || searchParams.get('redirect'),
  );
  const mobileCallbackState =
    searchParams.get('mobile_callback') === '1' ? searchParams.get('state') : null;
  const hasStartedMobileHandoff = useRef(false);
  const [mode, setMode] = useState<Mode>('signin');

  // A web session may already exist when the mobile user returns to this page.
  // Preserve the native handoff instead of routing that browser session to the
  // web dashboard and stranding the mobile app on its auth screen.
  useEffect(() => {
    if (isLoading || !user) return;

    if (mobileCallbackState) {
      // Strict Mode re-runs effects after the deep-link navigation begins.
      // Do not fall through to the web dashboard on that second pass: it can
      // cancel the native handoff before the OS claims the app link.
      if (hasStartedMobileHandoff.current) return;
      if (!session?.access_token || !session.refresh_token) return;

      const handoffUrl = buildMobileSessionHandoffUrl({
        origin: window.location.origin,
        state: mobileCallbackState,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
      });
      if (handoffUrl) {
        hasStartedMobileHandoff.current = true;
        window.location.assign(handoffUrl);
        return;
      }
    }

    router.replace(returnUrl);
  }, [isLoading, mobileCallbackState, returnUrl, router, session, user]);

  // A session is already established — the effect above is redirecting (or
  // handing off to mobile). Keep the quiet branded frame up instead of a
  // spinner, a blank screen, or a dead form.
  if (user) {
    return (
      <AuthFrame footerVariant="default">
        <StepHeader title="Welcome to Kortix" tagline="Your AI Command Center" />
      </AuthFrame>
    );
  }

  // Render the form immediately — even while the session check is still in
  // flight. Signed-out visitors (the common case) get an instantly usable
  // page; a signed-in visitor sees the form for a beat before the redirect.
  return (
    <AuthFrame footerVariant={mode === 'signup' ? 'signup' : 'default'}>
      <AuthCardForm
        mode={mode}
        onModeChange={setMode}
        returnUrl={returnUrl}
        mobileCallbackState={mobileCallbackState}
      />
      <AuthTrustCue />
    </AuthFrame>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={<div className="bg-background min-h-svh" />}>
      <>
        <AuthBrowserNoiseGuard />
        <AuthContent />
      </>
    </Suspense>
  );
}
