'use server';

import { accountHasAppAccess } from '@/lib/auth/account-access';
import { buildMobileSessionHandoffUrl } from '@/lib/auth/mobile-handoff';
import { clearAuthBounceCookie } from '@/lib/auth/sign-out-actions';
import {
  isInviteReturnUrl,
  resolveNewAccountReturnUrl,
  sanitizeAuthReturnUrl,
  shouldDemoteReturnUrl,
} from '@/lib/auth/return-url';
import {
  type EmailFlowMode,
  SIGNUPS_CLOSED_MESSAGE,
  SSO_REQUIRED_MESSAGE,
  resolveEmailFlowMode,
} from '@/lib/auth/unified-auth-flow';
import { getServerPublicEnv } from '@/lib/public-env-server';
import { createClient } from '@/lib/supabase/server';
import {
  checkAccessEmail,
  fetchAccountStateWithToken,
  submitAccessRequest,
} from '@kortix/sdk';
import { AUTH_BOUNCE_COOKIE, parseAuthBounceOwner } from '@/lib/onboarding/landing-destination';
import { cookies, headers } from 'next/headers';

/**
 * Who the middleware bounced to `/auth` on this browser, or `''` when the
 * bounce was unattributed (or there was no bounce at all — a visitor who typed
 * the address, or a link opened on a different device).
 */
async function readBouncedOwnerId(): Promise<string> {
  return parseAuthBounceOwner((await cookies()).get(AUTH_BOUNCE_COOKIE)?.value);
}

function normalizeTrustedOrigin(value?: string | null): string | null {
  if (!value) return null;
  // Reject values that are clearly not a host/URL — e.g. an undecrypted dotenvx
  // ciphertext ("encrypted:...") leaking through a Vercel build that ran plain
  // `next build` without DOTENV_PRIVATE_KEY. Without this guard `new URL()`
  // throws and we silently fall back to localhost, which breaks the magic-link
  // redirect_to on every deployed environment.
  if (value.startsWith('encrypted:')) return null;
  const candidate = value.startsWith('http') ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function trustedWebOrigin(origin?: string | null): string {
  const configured =
    getServerPublicEnv().APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL;
  // Prefer the configured app URL, but if it is missing or malformed fall back
  // to the real browser origin the request came from before localhost. Supabase's
  // redirect-URL allowlist is the authority on where the link may actually land,
  // so trusting the request origin here cannot widen the redirect surface.
  return (
    normalizeTrustedOrigin(configured) || normalizeTrustedOrigin(origin) || 'http://localhost:3000'
  );
}

function mobileCallbackState(formData: FormData): string | null {
  if (formData.get('mobileCallback') !== 'true') return null;
  const state = formData.get('mobileCallbackState');
  return typeof state === 'string' && state.length > 0 ? state : null;
}

function emailRedirectUrl({
  origin,
  returnUrl,
  email,
  acceptedTerms = false,
  mobileState,
}: {
  origin: string;
  returnUrl: string;
  email: string;
  acceptedTerms?: boolean;
  mobileState?: string | null;
}): string {
  // This route intentionally is not an app universal-link path: the browser
  // owns the PKCE verifier and must exchange the code before bouncing the
  // resulting session to the installed app.
  const url = new URL(
    mobileState ? '/auth/mobile/callback' : '/auth/callback',
    trustedWebOrigin(origin),
  );
  url.searchParams.set('returnUrl', returnUrl);
  url.searchParams.set('email', email);
  if (acceptedTerms) url.searchParams.set('terms_accepted', 'true');
  if (mobileState) {
    url.searchParams.set('mobile_callback', '1');
    url.searchParams.set('state', mobileState);
  }
  return url.toString();
}

/**
 * Ask the API how this email should proceed through the flow: 'signin' when
 * the account exists, 'signup' when it may register, 'closed' when signups
 * are off and the address isn't allowlisted, 'unknown' when the API can't
 * say (unreachable, rate-limited, or an older build without `mode`).
 *
 * The visitor's IP is forwarded so the API's per-IP rate limit lands on the
 * actual client rather than pooling every visitor into the web server's
 * single outbound address.
 */
async function checkEmailFlowMode(email: string): Promise<EmailFlowMode> {
  try {
    const backendUrl = getServerPublicEnv().BACKEND_URL || 'http://localhost:8008/v1';
    const requestHeaders = await headers();
    const forwardedFor = requestHeaders.get('x-forwarded-for') || requestHeaders.get('x-real-ip');
    const body = await checkAccessEmail(email, {
      backendUrl,
      headers: {
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
      signal: AbortSignal.timeout(4_000),
    });
    return resolveEmailFlowMode(body);
  } catch {
    // Fail open — 'unknown' routes through the adaptive signup action, which
    // signs in existing users and registers new ones.
    return 'unknown';
  }
}

/**
 * The unified flow's existence resolution. Never exposed as a raw endpoint to
 * the browser beyond this server action; the API behind it is rate-limited
 * per IP and returns a flow directive, not a bare "exists" flag.
 */
export async function resolveAuthMode(email: string): Promise<{ mode: EmailFlowMode }> {
  if (!email || !email.includes('@')) return { mode: 'unknown' };
  return { mode: await checkEmailFlowMode(email.trim().toLowerCase()) };
}

/**
 * Send the sign-in/sign-up email code — ONE action for both cases. GoTrue's
 * OTP with `shouldCreateUser: true` already treats new and existing addresses
 * identically, so the only gate is access control: a brand-new address while
 * signups are closed is turned away before any email goes out (previously the
 * "sign in" tab skipped this check entirely and quietly created accounts).
 */
export async function sendEmailCode(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const requestedReturnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  const origin = formData.get('origin') as string;
  const acceptedTerms = formData.get('acceptedTerms') === 'true';
  const referralCode = formData.get('referralCode') as string | undefined;
  const mobileState = mobileCallbackState(formData);

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  const normalizedEmail = email.trim().toLowerCase();

  const flowMode = await checkEmailFlowMode(normalizedEmail);
  if (flowMode === 'closed') {
    return { code: 'signups_closed', message: SIGNUPS_CLOSED_MESSAGE };
  }
  if (flowMode === 'sso') {
    return { code: 'sso_required', message: SSO_REQUIRED_MESSAGE };
  }

  // Resolve the return URL HERE — before it is baked into the email link. That
  // link can be opened minutes or days later, on a device that never held the
  // bounced session, so this is the LAST point at which either rule can still
  // reach it:
  //  - `flowMode === 'signup'` means the API just confirmed this address has no
  //    account. The link outlives the callback's "created in the last 60s?"
  //    heuristic, and a stale link is precisely how a fresh account ends up
  //    staring at a stranger's "Request access" page.
  //  - an ATTRIBUTED bounce cannot be matched against a signer here, because no
  //    identity exists yet — the address has not been proven. Fail closed: a
  //    path bounced from a named session does not get minted into an email.
  //    Nothing is lost in the common case; the same-browser code-entry path
  //    (`verifyOtp`) still carries the full return URL from the form, and it
  //    CAN compare identities.
  const returnUrl = shouldDemoteReturnUrl({
    bouncedOwnerId: await readBouncedOwnerId(),
    signedInUserId: null,
    isNewUser: flowMode === 'signup',
  })
    ? resolveNewAccountReturnUrl(requestedReturnUrl)
    : requestedReturnUrl;

  const supabase = await createClient();
  const emailRedirectTo = emailRedirectUrl({
    origin,
    returnUrl,
    email: normalizedEmail,
    acceptedTerms,
    mobileState,
  });

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo,
      shouldCreateUser: true,
      data: referralCode
        ? {
            referral_code: referralCode.trim().toUpperCase(),
          }
        : undefined,
    },
  });

  if (error) {
    return { message: error.message || 'Could not send the code' };
  }

  return {
    success: true,
    message: 'Check your email for a sign-in code',
    email: normalizedEmail,
  };
}

export async function requestAccess(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const company = formData.get('company') as string | undefined;
  const useCase = formData.get('useCase') as string | undefined;

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  try {
    const backendUrl = getServerPublicEnv().BACKEND_URL || 'http://localhost:8008/v1';
    await submitAccessRequest(
      {
        email: email.trim().toLowerCase(),
        company: company?.trim() || undefined,
        useCase: useCase?.trim() || undefined,
      },
      { backendUrl },
    );
    return {
      success: true,
      message: "Your access request has been submitted. We'll be in touch!",
    };
  } catch {
    return { message: 'Failed to submit request. Please try again.' };
  }
}

export async function forgotPassword(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const origin = formData.get('origin') as string;

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  const supabase = await createClient();

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${trustedWebOrigin(origin)}/auth/reset-password`,
  });

  if (error) {
    return { message: error.message || 'Could not send password reset email' };
  }

  return {
    success: true,
    message: 'Check your email for a password reset link',
  };
}

export async function resetPassword(prevState: any, formData: FormData) {
  const password = formData.get('password') as string;
  const confirmPassword = formData.get('confirmPassword') as string;

  if (!password || password.length < 6) {
    return { message: 'Password must be at least 6 characters' };
  }

  if (password !== confirmPassword) {
    return { message: 'Passwords do not match' };
  }

  const supabase = await createClient();

  const { error } = await supabase.auth.updateUser({
    password,
  });

  if (error) {
    return { message: error.message || 'Could not update password' };
  }

  return {
    success: true,
    message: 'Password updated successfully',
  };
}

export async function signInWithPassword(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  const origin = formData.get('origin') as string;
  const mobileState = mobileCallbackState(formData);

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  if (!password || password.length < 6) {
    return { message: 'Password must be at least 6 characters' };
  }

  // SSO enforcement: when the domain's org has flipped `enforce_sso`, the
  // password door is closed even for pre-SSO password accounts — the IdP is
  // the only way in. Fail-open ('unknown') keeps logins working if the API is
  // briefly unreachable; the UI hides the password path independently.
  const flowMode = await checkEmailFlowMode(email.trim().toLowerCase());
  if (flowMode === 'sso') {
    return { code: 'sso_required', message: SSO_REQUIRED_MESSAGE };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error) {
    // Thread GoTrue's error code through so the flow — which already resolved
    // that this account exists — can say "wrong password" instead of the
    // deliberately ambiguous "Invalid login credentials".
    const code =
      (error as { code?: string }).code ||
      (error.message?.toLowerCase().includes('invalid login credentials')
        ? 'invalid_credentials'
        : null);
    return { message: error.message || 'Invalid email or password', code };
  }

  // Determine if new user (for analytics)
  const isNewUser = data.user && Date.now() - new Date(data.user.created_at).getTime() < 60000;
  const authEvent = isNewUser ? 'signup' : 'login';

  // Return success — let the client redirect after auth state hydrates. An
  // account this young signed up moments ago (the sign-up form ends in a
  // password sign-in), so it gets the signup destination rule, not a return URL
  // pointing at a resource that predates it. The same rule applies when the
  // return URL was bounced here from somebody ELSE's session — an existing
  // account is exactly the case `isNewUser` alone never covered.
  const finalReturnUrl = shouldDemoteReturnUrl({
    bouncedOwnerId: await readBouncedOwnerId(),
    signedInUserId: data.user?.id ?? null,
    isNewUser,
  })
    ? resolveNewAccountReturnUrl(returnUrl)
    : returnUrl;
  await clearAuthBounceCookie();
  const redirectUrl = new URL(finalReturnUrl, 'http://localhost');
  redirectUrl.searchParams.set('auth_event', authEvent);
  redirectUrl.searchParams.set('auth_method', 'email');

  return {
    success: true,
    redirectTo: `${redirectUrl.pathname}${redirectUrl.search}`,
    accessToken: data.session?.access_token || null,
    refreshToken: data.session?.refresh_token || null,
    mobileHandoffUrl: buildMobileSessionHandoffUrl({
      origin: trustedWebOrigin(origin),
      state: mobileState,
      accessToken: data.session?.access_token,
      refreshToken: data.session?.refresh_token,
    }),
  };
}

/**
 * Unified signup: works identically in local and cloud.
 *
 * Strategy: signUp → immediately try signInWithPassword. When Supabase
 * confirmations are off (local default, and recommended for self-host),
 * sign-in succeeds and the user is in. When confirmations are on (cloud),
 * sign-in returns `email_not_confirmed` and we surface "check your email".
 *
 * Cloud and local share this function. The only configuration-dependent
 * behavior is whether the inner signIn succeeds — driven by Supabase's
 * `enable_confirmations`, not by any billing flag.
 */
export async function signUpWithPassword(prevState: any, formData: FormData) {
  const email = (formData.get('email') as string | null)?.trim().toLowerCase();
  const password = formData.get('password') as string;
  const confirmPassword = formData.get('confirmPassword') as string;
  const requestedReturnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  // This is the sign-up form: unless the account turns out to already exist
  // (`alreadyExists` below), the identity about to be created cannot own
  // anything the visitor was looking at before they got here.
  const newAccountReturnUrl = resolveNewAccountReturnUrl(requestedReturnUrl);
  const origin = formData.get('origin') as string;
  const mobileState = mobileCallbackState(formData);

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }
  if (!password || password.length < 6) {
    return { message: 'Password must be at least 6 characters' };
  }
  if (password !== confirmPassword) {
    return { message: 'Passwords do not match' };
  }

  // Access control gate — same rule the email-code path enforces: a brand-new
  // address while signups are closed never reaches GoTrue, and an SSO-enforced
  // domain never gets a password identity created. Existing accounts resolve
  // to 'signin' and pass straight through to the sign-in attempt.
  const flowMode = await checkEmailFlowMode(email);
  if (flowMode === 'closed') {
    return { code: 'signups_closed', message: SIGNUPS_CLOSED_MESSAGE };
  }
  if (flowMode === 'sso') {
    return { code: 'sso_required', message: SSO_REQUIRED_MESSAGE };
  }

  const supabase = await createClient();
  const emailRedirectTo = emailRedirectUrl({
    origin,
    // The confirmation link outlives the "new user" heuristic downstream, so
    // the signup rule has to be applied before it is minted, not after.
    returnUrl: newAccountReturnUrl,
    email,
    mobileState,
  });

  const { error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo },
  });

  const alreadyExists =
    signUpError &&
    (signUpError.message?.toLowerCase().includes('already registered') ||
      signUpError.message?.toLowerCase().includes('already exists') ||
      signUpError.status === 422);

  if (signUpError && !alreadyExists) {
    return { message: signUpError.message || 'Could not create account' };
  }

  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    if (
      signInError.message?.toLowerCase().includes('email_not_confirmed') ||
      signInError.message?.toLowerCase().includes('not confirmed')
    ) {
      return {
        success: true,
        message: 'Check your email to confirm your account',
        email,
        requiresEmailConfirmation: true,
      };
    }
    if (alreadyExists) {
      // The signup attempt just proved the account exists AND the password is
      // wrong — hand the client a structured code so it can flip the step to
      // sign-in with honest "wrong password" copy.
      return {
        code: 'existing_account_wrong_password',
        message: 'An account with this email already exists. Try signing in instead.',
      };
    }
    return { message: signInError.message || 'Account created but could not sign in' };
  }

  // A signup enters through the landing door, which paints instantly and
  // provisions the first project behind the UI. This action used to await a
  // managed git repo create + a full starter push here (up to 90s) before it
  // could return a redirect, which blocked the sign-up form itself.
  //
  // `alreadyExists` means the address had an account and the password was
  // right — that is a sign-IN, so the visitor's own return URL still stands…
  // unless the path was bounced here from a DIFFERENT account's session. This
  // form is a real sign-in door for anyone who already has an account, which is
  // the second-paid-account case, so it needs the same identity gate the
  // sign-in action has.
  const redirectTo = shouldDemoteReturnUrl({
    bouncedOwnerId: await readBouncedOwnerId(),
    signedInUserId: signInData.user?.id ?? null,
    isNewUser: !alreadyExists,
  })
    ? newAccountReturnUrl
    : requestedReturnUrl;
  await clearAuthBounceCookie();

  return {
    success: true,
    redirectTo,
    accessToken: signInData.session?.access_token || null,
    refreshToken: signInData.session?.refresh_token || null,
    mobileHandoffUrl: buildMobileSessionHandoffUrl({
      origin: trustedWebOrigin(origin),
      state: mobileState,
      accessToken: signInData.session?.access_token,
      refreshToken: signInData.session?.refresh_token,
    }),
  };
}

// `signOut()` used to live here. It moved to `lib/auth/sign-out-actions.ts` as
// `finalizeServerSignOut()`, which every logout control now reaches through
// `performSignOut()`. Two behaviours changed on the way, both deliberate:
//
//  - the server-side revoke + audit ran on ONE of six controls; it runs on all
//    six now;
//  - it no longer deletes `kortix_last_project`. That cookie is owner-bound, so
//    the next account cannot follow it, and the middleware reads its owner half
//    to attribute a bounce once identity resolution has returned `user: null` —
//    which is what happens after a logout. Deleting it un-attributed every
//    post-logout bounce.

export async function verifyOtp(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const token = formData.get('token') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  const origin = formData.get('origin') as string;
  const mobileState = mobileCallbackState(formData);

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  if (!token || token.length !== 6) {
    return { message: 'Please enter the 6-digit code from your email' };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: token.trim(),
    type: 'magiclink',
  });

  if (error) {
    return { message: error.message || 'Invalid or expired code' };
  }

  // Determine if new user (for analytics)
  const isNewUser = data.user && Date.now() - new Date(data.user.created_at).getTime() < 60000;
  const authEvent = isNewUser ? 'signup' : 'login';

  // For new cloud users with no plan yet, land in account management. The
  // repo-first app surface starts from /projects; the old plan route is not v1.
  const runtimeEnv = getServerPublicEnv();
  const billingEnabled = runtimeEnv.BILLING_ENABLED;
  // `sendEmailCode` already applied this rule when the API could tell us the
  // address was new. Re-applying it here covers the case where it could not
  // (a fail-open 'unknown' flow mode), so a fresh account never rides a
  // pre-signup return URL into a project it cannot open. This is also the one
  // place the bounce owner CAN be matched against a real identity: the code was
  // entered in the same browser that was bounced, and the account is now known.
  let finalDestination = shouldDemoteReturnUrl({
    bouncedOwnerId: await readBouncedOwnerId(),
    signedInUserId: data.user?.id ?? null,
    isNewUser,
  })
    ? resolveNewAccountReturnUrl(returnUrl)
    : returnUrl;
  await clearAuthBounceCookie();

  // Invited users (returnUrl → /invites/:id) must land on the accept/decline
  // dialog verbatim — skip the billing-aware landing (account page or a freshly
  // provisioned first project), which would otherwise skip the dialog.
  if (billingEnabled && isNewUser && !isInviteReturnUrl(returnUrl) && data.session?.access_token) {
    try {
      const backendUrl = (process.env.BACKEND_URL || runtimeEnv.BACKEND_URL || '').replace(
        /\/v1\/?$/,
        '',
      );
      if (backendUrl) {
        const accountState = await fetchAccountStateWithToken({
          backendUrl,
          accessToken: data.session.access_token,
          timeoutMs: 5000,
        });
        // Entitlement is the only reason to override the destination here.
        // First-project provisioning used to run on this path too and blocked
        // the OTP form for the length of a managed git repo create plus a full
        // starter push; PROJECT_LANDING_PATH now absorbs that behind the UI.
        // Same destination, same reason as the OAuth/magic-link path in
        // `auth/callback/route.ts` — see the comment there.
        if (accountState && !accountHasAppAccess(accountState)) {
          finalDestination = '/settings/billing';
        }
      }
    } catch {
      // If check fails, fall through to default destination
    }
  }

  return {
    success: true,
    authEvent,
    authMethod: 'email_otp',
    redirectTo: finalDestination,
    // Hand the session back so the client can establish it synchronously
    // (supabase.auth.setSession) before navigating. Without this the client
    // only picks up the session on a later background token refresh, which
    // bounces the user back to /auth for ~15s until the session lands.
    accessToken: data.session?.access_token ?? null,
    refreshToken: data.session?.refresh_token ?? null,
    mobileHandoffUrl: buildMobileSessionHandoffUrl({
      origin: trustedWebOrigin(origin),
      state: mobileState,
      accessToken: data.session?.access_token,
      refreshToken: data.session?.refresh_token,
    }),
  };
}
