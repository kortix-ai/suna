'use client';

/**
 * Unified auth — ONE flow for login and registration (email → code or
 * password). There is no sign-in/sign-up toggle: the visitor types an email,
 * Continue resolves whether that address already has an account, and the
 * password step renders in the mode the flow already knows — "Welcome back"
 * for existing accounts, "Create your account" for new ones. A wrong password
 * says wrong password; a new email is never told "Invalid login credentials".
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
import { CodeInput, FieldLabel, InfoStrip, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { invalidateTokenCache, setBootstrapAuthToken } from '@/lib/auth-token';
import { buildMobileSessionHandoffUrl } from '@/lib/auth/mobile-handoff';
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';
import {
  type CredentialsMode,
  type EmailFlowMode,
  SIGNUPS_CLOSED_MESSAGE,
  SSO_REQUIRED_MESSAGE,
  credentialsCopy,
  parseAuthMethods,
  passwordFailureCopy,
} from '@/lib/auth/unified-auth-flow';
import { authRedirectUrl } from '@/lib/desktop';
import { getEnv } from '@/lib/env-config';
import { emailDomain, isWorkEmail } from '@/lib/personal-email';
import {
  createClient as createBrowserSupabaseClient,
  fetchSamlEnabled,
} from '@/lib/supabase/client';
import {
  resolveAuthMode,
  sendEmailCode,
  signInWithPassword,
  signUpWithPassword,
  verifyOtp,
} from './actions';

const GoogleSignIn = lazy(() => import('@/features/auth/google-signin'));

type Step = 'entry' | 'sso' | 'credentials' | 'code';

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
  returnUrl,
  mobileCallbackState,
}: {
  returnUrl: string;
  mobileCallbackState: string | null;
}) {
  const router = useRouter();
  const prefersReducedMotion = useReducedMotion();
  const enabledMethods = useMemo(() => parseAuthMethods(getEnv().AUTH_METHODS), []);
  const magicLinkEnabled = enabledMethods.includes('magic');
  const passwordEnabled = enabledMethods.includes('password');

  const [step, setStep] = useState<Step>('entry');
  const [email, setEmail] = useState('');
  // What the flow knows about the address by the time the password step shows:
  // 'signin' (account exists), 'signup' (new), or 'unknown' (the existence
  // check couldn't answer — the adaptive signup action covers both).
  const [credMode, setCredMode] = useState<CredentialsMode>('unknown');
  // SSO interstitial state: the IdP redirect URL from the signInWithSSO probe,
  // plus what the existence check said the escape hatches should do.
  const [ssoUrl, setSsoUrl] = useState<string | null>(null);
  const [ssoFallbackMode, setSsoFallbackMode] = useState<EmailFlowMode>('unknown');
  // Which button kicked off the in-flight request — every action button
  // disables while anything is pending, but only the clicked one spins.
  const [pendingAction, setPendingAction] = useState<
    'continue' | 'code' | 'resend' | 'password' | 'sso' | null
  >(null);
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

  // Only probe SSO when the Supabase instance actually has SAML enabled. A fresh
  // self-hosted deployment has it off, so probing every work-email Continue would
  // just surface a scary `saml_provider_disabled` 404. Gate on the live setting so
  // SSO stays an opt-in path that lights up once an operator configures a provider.
  const [samlEnabled, setSamlEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void fetchSamlEnabled().then((enabled) => {
      if (active) setSamlEnabled(enabled);
    });
    return () => {
      active = false;
    };
  }, []);

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
    setSsoUrl(null);
    setSsoFallbackMode('unknown');
    setStep('entry');
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
      // One flow: continuing IS the agreement (the legal footer says so), and
      // the code path signs in existing accounts and registers new ones alike.
      formData.set('acceptedTerms', 'true');

      const result = await sendEmailCode(null, formData);

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


  /**
   * Probe the address's domain for a registered SAML provider and hand the
   * browser to the IdP (or the SSO interstitial) when one exists. Shared by
   * the silent home-realm discovery in handleEntryContinue and the explicit
   * "Use single sign-on" action — one redirect/callback construction, two
   * entry points. Returns 'handled' when navigation/step change happened,
   * 'none' when the domain has no provider (callers decide whether that is a
   * silent fall-through or a user-facing error).
   */
  const attemptSsoRedirect = async (address: string): Promise<'handled' | 'none'> => {
    const domain = emailDomain(address);
    if (!domain) return 'none';
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
        // The domain is bound to a SAML provider. Ask the flow how strict
        // the org is: enforced SSO redirects straight to the IdP (no
        // password door), everything else lands on an interstitial that
        // defaults to SSO but keeps the password/code escapes visible —
        // a pre-SSO password account must never dead-end here.
        const { mode: resolved } = await resolveAuthMode(address);
        if (resolved === 'sso') {
          // Full navigation to the IdP; the callback route exchanges the
          // code on return (same PKCE path as Google OAuth).
          window.location.href = data.url;
          return 'handled';
        }
        setSsoFallbackMode(resolved);
        setSsoUrl(data.url);
        setStep('sso');
        return 'handled';
      }
      // Work domain with no SAML provider.
    } catch {
      // SAML not enabled on this Supabase, or a transient error.
    }
    return 'none';
  };

  /**
   * Explicit "Use single sign-on" — the discoverable counterpart of the
   * silent home-realm discovery above. Two deliberate differences: it skips
   * the isWorkEmail consumer-domain gate (typing the button IS the intent),
   * and a domain with no provider surfaces a real error instead of silently
   * falling through to magic link — an invisible fall-through here reads as
   * "SSO is broken".
   */
  const handleSsoContinue = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      clearNotices();
      setInfo('Enter your work email above, then choose single sign-on.');
      emailRef.current?.focus();
      return;
    }
    clearNotices();
    setPendingAction('sso');
    try {
      const outcome = await attemptSsoRedirect(trimmed);
      if (outcome === 'none') {
        const domain = emailDomain(trimmed) ?? trimmed;
        failWith(
          `Single sign-on isn't set up for "${domain}". Ask your admin to configure it, or continue with email.`,
        );
      }
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
      if (samlEnabled && domain && isWorkEmail(trimmed)) {
        if ((await attemptSsoRedirect(trimmed)) === 'handled') return;
        // Work domain with no SAML provider → fall through to magic/password.
      }

      // Magic link is the default path: Continue emails a code and lands the
      // user on the code step (the code signs in existing accounts and
      // registers new ones — no mode needed). Password-only deployments go
      // through the existence check instead, so the password step opens
      // already knowing whether this is a sign-in or a registration.
      if (magicLinkEnabled) {
        await sendMagic(trimmed, 'continue');
        return;
      }
      const { mode: resolved } = await resolveAuthMode(trimmed);
      if (resolved === 'closed') {
        failWith(SIGNUPS_CLOSED_MESSAGE);
        return;
      }
      if (resolved === 'sso') {
        // Enforced-SSO domain that slipped past the probe above (e.g. SAML
        // temporarily unreachable) — never open the password door.
        failWith(SSO_REQUIRED_MESSAGE);
        return;
      }
      setCredMode(resolved);
      setStep('credentials');
    } finally {
      setPendingAction(null);
    }
  };

  // Escape hatch off the code step for people who'd rather type a password.
  // The address can live in either field depending on how the step was reached,
  // and the credentials step renders it read-only from `email` — so settle on
  // one before switching, and bounce focus back if we somehow have neither.
  // Resolves existence on the way so the step opens in the right mode.
  const goToPassword = async () => {
    const target = (email || sentEmail || '').trim();
    if (!target) {
      emailRef.current?.focus();
      return;
    }
    if (email !== target) setEmail(target);
    clearNotices();
    setPendingAction('password');
    try {
      const { mode: resolved } = await resolveAuthMode(target);
      if (resolved === 'closed') {
        failWith(SIGNUPS_CLOSED_MESSAGE);
        return;
      }
      if (resolved === 'sso') {
        failWith(SSO_REQUIRED_MESSAGE);
        return;
      }
      setCredMode(resolved);
      setCode('');
      setStep('credentials');
    } finally {
      setPendingAction(null);
    }
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
    const copy = credentialsCopy(credMode);
    if (copy.submitsAs === 'signup') {
      // Single password field (with reveal toggle) — the server still expects
      // a confirmation value, so mirror it.
      formData.set('confirmPassword', (formData.get('password') as string) || '');
      formData.set('acceptedTerms', 'true');
    }

    try {
      const result =
        copy.submitsAs === 'signup'
          ? await signUpWithPassword(null, formData)
          : await signInWithPassword(null, formData);

      if (
        result &&
        typeof result === 'object' &&
        'message' in result &&
        (!('success' in result) || !(result as any).success) &&
        !(result as any).requiresEmailConfirmation
      ) {
        const failure = passwordFailureCopy({
          mode: credMode,
          code: (result as any).code ?? null,
          fallback: result.message as string,
        });
        // The attempt itself proved the account exists (e.g. the existence
        // check was degraded, or it raced an account created elsewhere) —
        // relabel the step so the retry reads as the sign-in it really is.
        if (failure.switchToSignin) setCredMode('signin');
        failWith(failure.message);
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

  // Password escape off the SSO interstitial. The existence check already ran
  // when the interstitial opened, so this is a synchronous relabel + step move.
  const usePasswordFromSso = () => {
    if (ssoFallbackMode === 'closed') {
      failWith(SIGNUPS_CLOSED_MESSAGE);
      return;
    }
    clearNotices();
    setCredMode(
      ssoFallbackMode === 'signin' || ssoFallbackMode === 'signup' ? ssoFallbackMode : 'unknown',
    );
    setStep('credentials');
  };

  /* ── SSO step (domain matched a SAML provider, org does NOT enforce it) ── */
  if (step === 'sso' && ssoUrl) {
    return (
      <>
        <motion.div {...rise(0)}>
          <StepHeader
            title="Use single sign-on"
            description={
              <>
                <span className="text-foreground font-medium break-words">{email}</span> can sign in
                through your organization&apos;s identity provider.
              </>
            }
          />
        </motion.div>

        <motion.div {...rise(0.06)}>
          {info && <InfoStrip message={info} />}

          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={pending}
            onClick={() => {
              window.location.href = ssoUrl;
            }}
          >
            Continue with SSO
          </Button>

          <div className="text-muted-foreground mt-6 space-y-2 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              {passwordEnabled && (
                <button
                  type="button"
                  onClick={usePasswordFromSso}
                  disabled={pending}
                  className="hover:text-foreground -my-2 py-2 underline-offset-4 transition-colors hover:underline disabled:opacity-50"
                >
                  Use a password instead
                </button>
              )}
              {passwordEnabled && magicLinkEnabled && (
                <span aria-hidden className="text-muted-foreground/40 select-none">
                  ·
                </span>
              )}
              {magicLinkEnabled && (
                <button
                  type="button"
                  onClick={() => sendMagic(email, 'code')}
                  disabled={pending}
                  className="hover:text-foreground -my-2 py-2 underline-offset-4 transition-colors hover:underline disabled:opacity-50"
                >
                  {pendingAction === 'code' ? 'Sending…' : 'Email me a code instead'}
                </button>
              )}
            </p>
            <p>
              <button
                type="button"
                onClick={goToEntry}
                className="hover:text-foreground -my-2 py-2 underline-offset-4 transition-colors hover:underline"
              >
                Use a different email
              </button>
            </p>
          </div>
        </motion.div>
      </>
    );
  }

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
                        onClick={() => void goToPassword()}
                        disabled={pending}
                        className="hover:text-foreground -my-2 py-2 underline-offset-4 transition-colors hover:underline disabled:opacity-50"
                      >
                        {pendingAction === 'password' ? 'One moment…' : 'Use password instead'}
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
    const copy = credentialsCopy(credMode);
    return (
      <>
        <motion.div {...rise(0)}>
          <StepHeader title={copy.title} description={copy.description ?? undefined} />
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
                {copy.showForgotPassword && (
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
                placeholder={copy.passwordPlaceholder}
                autoComplete={copy.passwordAutoComplete}
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
              Email me a code instead
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
        <StepHeader title="Welcome to Kortix" tagline="Your AI Command Center" />
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

        {/* Explicit SSO entry — the discoverable counterpart of the silent
            home-realm discovery Continue already performs. Same dialect as the
            code-step footer links; only rendered when this deployment has SAML
            enabled, so self-hosted installs without SSO never show a dead door. */}
        {samlEnabled && (
          <p className="text-muted-foreground mt-4 text-sm">
            <button
              type="button"
              onClick={() => void handleSsoContinue()}
              disabled={pending}
              className="hover:text-foreground -my-2 py-2 underline-offset-4 transition-colors hover:underline disabled:opacity-50"
            >
              {pendingAction === 'sso' ? 'Looking up your identity provider…' : 'Use single sign-on (SSO)'}
            </button>
          </p>
        )}

        {/* One system: no sign-in/sign-up toggle. Continue routes new emails
            into registration and existing ones into sign-in automatically. */}
        <p className="text-muted-foreground mt-8 text-sm">
          New here? Continue creates your account automatically.
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
    <AuthFrame footerVariant="continue">
      <AuthCardForm returnUrl={returnUrl} mobileCallbackState={mobileCallbackState} />
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
