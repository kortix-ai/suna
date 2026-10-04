import { accountHasAppAccess } from '@/lib/auth/account-access';
import { buildDesktopBounceHtml, buildMobileBounceHtml } from '@/lib/auth/desktop-bounce';
import {
  isInviteReturnUrl,
  isNewAccount,
  resolveAuthRedirectBaseUrl,
  resolveNewAccountReturnUrl,
  sanitizeAuthReturnUrl,
  shouldDemoteReturnUrl,
} from '@/lib/auth/return-url';
import {
  AUTH_BOUNCE_COOKIE,
  LAST_PROJECT_COOKIE,
  PROJECT_LANDING_PATH,
  parseAuthBounceOwner,
  parseLastProjectForUser,
  projectPathFromId,
} from '@/lib/onboarding/landing-destination';
import { getServerPublicEnv, serverBackendUrl } from '@/lib/public-env-server';
import { createClient } from '@/lib/supabase/server';
import { ACTIVE_INSTANCE_COOKIE, fetchAccountStateWithToken } from '@kortix/sdk';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Auth Callback Route - Web Handler
 *
 * Handles authentication callbacks for web browsers.
 *
 * Flow:
 * - If app is installed: Universal Links intercept HTTPS URLs and open app directly (bypasses this)
 * - If app is NOT installed: Opens in browser → this route handles auth and redirects to dashboard
 */

/** The auth page with the resend form armed — the one landing for an expired or invalid link. */
function expiredAuthRedirect(baseUrl: string, next: string) {
  const expiredUrl = new URL(`${baseUrl}/auth`);
  expiredUrl.searchParams.set('expired', 'true');
  if (next) expiredUrl.searchParams.set('returnUrl', next);
  return NextResponse.redirect(expiredUrl);
}

function authErrorRedirect(baseUrl: string, message: string) {
  return NextResponse.redirect(`${baseUrl}/auth?error=${encodeURIComponent(message)}`);
}

/** A `200` HTML page that bounces the flow to the desktop app / mobile app (see desktop-bounce). */
function htmlBounce(html: string) {
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Supabase's expired/invalid signal, as the callback's query params carry it. */
function isExpiredAuthParams(
  error: string,
  errorCode: string | null,
  errorDescription: string | null,
): boolean {
  return (
    errorCode === 'otp_expired' ||
    errorCode === 'expired_token' ||
    errorCode === 'token_expired' ||
    error.toLowerCase().includes('expired') ||
    error.toLowerCase().includes('invalid') ||
    (errorDescription?.toLowerCase().includes('expired') ?? false) ||
    (errorDescription?.toLowerCase().includes('invalid') ?? false)
  );
}

/** The same signal on the exchange failure itself. */
function isExpiredAuthError(error: { message?: string | null; status?: number; code?: string }): boolean {
  return (
    (error.message?.toLowerCase().includes('expired') ?? false) ||
    (error.message?.toLowerCase().includes('invalid') ?? false) ||
    error.status === 400 ||
    error.code === 'expired_token' ||
    error.code === 'token_expired' ||
    error.code === 'otp_expired'
  );
}

/**
 * Where a just-authenticated identity lands, and the analytics labels the
 * redirect carries. Owns the whole post-auth destination policy:
 *
 * - OAuth/SSO signups reach this handler seconds after the account is
 *   created, so this is where a provider signup gets the rule the email flows
 *   already applied when they minted their link: a return URL the new account
 *   cannot own does not survive the signup (`isNewAccount` +
 *   `resolveNewAccountReturnUrl`).
 * - The same rule covers an EXISTING account that signed in on a screen the
 *   middleware bounced here for somebody else — an IdP hop keeps the browser,
 *   so the bounce cookie is still readable and the account is now known. No
 *   cookie, or one with no owner, means the bounce was unattributed and the
 *   return URL stands (`shouldDemoteReturnUrl`).
 * - The ONLY backend call left on this redirect's critical path is the
 *   billing-aware landing override. First-project provisioning deliberately
 *   does NOT happen in this handler any more: it used to await accounts (8s) +
 *   projects (8s) + a managed git repo create AND a full starter push (90s)
 *   before the browser received any redirect at all, so a fresh signup stared
 *   at a blank callback page for the whole provision. `PROJECT_LANDING_PATH`
 *   now paints instantly and does that work behind the real UI.
 *   `/settings/billing`, not `/projects/start`: this branch exists so an
 *   account with no app access is NOT given a project, and the landing door
 *   provisions one. The settings route mounts the panel directly for exactly
 *   this reason — see `features/workspace/settings/standalone-settings-route.tsx`.
 * - Returning users skip the landing door's resolve step entirely: the
 *   browser already told us which project they had open last. Reading a cookie
 *   costs nothing, so this is a strictly free hop to remove.
 */
async function resolveCallbackDestination({
  supabase,
  user,
  next,
  request,
  runtimeEnv,
  termsAccepted,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  user: {
    id: string;
    created_at: string;
    app_metadata?: { provider?: string } | null;
    user_metadata?: Record<string, unknown> | null;
  } | null;
  next: string;
  request: NextRequest;
  runtimeEnv: ReturnType<typeof getServerPublicEnv>;
  termsAccepted: boolean;
}): Promise<{
  destination: string;
  authEvent: 'signup' | 'login';
  authMethod: string;
  clearReferralCookie: boolean;
}> {
  if (!user) {
    return { destination: next, authEvent: 'login', authMethod: 'email', clearReferralCookie: false };
  }

  let destination = next;
  let clearReferralCookie = false;
  const authEvent = isNewAccount(user.created_at) ? 'signup' : 'login';
  const authMethod = user.app_metadata?.provider || 'email';

  if (
    shouldDemoteReturnUrl({
      bouncedOwnerId: parseAuthBounceOwner(request.cookies.get(AUTH_BOUNCE_COOKIE)?.value),
      signedInUserId: user.id,
      isNewUser: authEvent === 'signup',
    })
  ) {
    destination = resolveNewAccountReturnUrl(next);
  }

  const pendingReferralCode = request.cookies.get('pending-referral-code')?.value;
  if (pendingReferralCode) {
    try {
      await supabase.auth.updateUser({
        data: {
          referral_code: pendingReferralCode,
        },
      });
      clearReferralCookie = true;
    } catch (error) {
      console.error('Failed to add referral code to OAuth user:', error);
    }
  }

  if (termsAccepted) {
    const currentMetadata = user.user_metadata || {};
    if (!currentMetadata.terms_accepted_at) {
      try {
        await supabase.auth.updateUser({
          data: {
            ...currentMetadata,
            terms_accepted_at: new Date().toISOString(),
          },
        });
      } catch (updateError) {
        console.warn('Failed to save terms acceptance:', updateError);
      }
    }
  }

  // Check subscription status via backend API (has direct DB access)
  const backendUrl = serverBackendUrl();
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;

  // Skip the billing-aware landing for invited users: a returnUrl pointing at
  // /invites/:id must be honored verbatim so they reach the accept/decline
  // dialog, instead of being bounced to the billing page or a freshly
  // provisioned first project (either of which skips the dialog and leaves
  // the invite unaccepted).
  if (runtimeEnv.BILLING_ENABLED && backendUrl && accessToken && !isInviteReturnUrl(next)) {
    try {
      const accountState = await fetchAccountStateWithToken({
        backendUrl,
        accessToken,
        timeoutMs: 5000,
      });
      if (accountState && !accountHasAppAccess(accountState)) {
        destination = '/settings/billing';
      }
    } catch (err) {
      console.warn('Could not check account state from backend:', err);
    }
  }

  if (destination === PROJECT_LANDING_PATH) {
    // Scoped to THIS user. The cookie survives sign-out, so an unscoped read
    // sent the next account to sign in on this browser straight into the
    // previous account's project — i.e. onto "Request access to this project",
    // on every login.
    const lastProjectPath = projectPathFromId(
      parseLastProjectForUser(request.cookies.get(LAST_PROJECT_COOKIE)?.value, user.id),
    );
    if (lastProjectPath) destination = lastProjectPath;
  }

  return { destination, authEvent, authMethod, clearReferralCookie };
}

/**
 * The web redirect after a successful exchange: the analytics params ride the
 * URL, and the spent cookies are cleared — the bounce attribution (used up by
 * the destination decision above, so it cannot demote the next sign-in), the
 * stale legacy instance cookie, and the referral cookie when it was consumed.
 */
function sessionRedirect(
  baseUrl: string,
  destination: string,
  authEvent: string,
  authMethod: string,
  clearReferralCookie: boolean,
) {
  const redirectUrl = new URL(`${baseUrl}${destination}`);
  redirectUrl.searchParams.set('auth_event', authEvent);
  redirectUrl.searchParams.set('auth_method', authMethod);
  const response = NextResponse.redirect(redirectUrl);
  response.cookies.set(AUTH_BOUNCE_COOKIE, '', { maxAge: 0, path: '/' });
  response.cookies.set(ACTIVE_INSTANCE_COOKIE, '', { maxAge: 0, path: '/' });
  if (clearReferralCookie) {
    response.cookies.set('pending-referral-code', '', { maxAge: 0, path: '/' });
  }
  return response;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const token = searchParams.get('token'); // Supabase verification token
  const type = searchParams.get('type'); // signup, recovery, etc.
  const next = sanitizeAuthReturnUrl(searchParams.get('returnUrl') || searchParams.get('redirect'));
  const termsAccepted = searchParams.get('terms_accepted') === 'true';
  const desktop = searchParams.get('desktop') === 'true';
  const mobile = searchParams.get('mobile_callback') === '1' && Boolean(searchParams.get('state'));

  // Desktop OAuth bounce: Supabase 302'd the user's BROWSER here. Don't
  // exchange the code on the web side — bounce to `kortix://auth/callback`
  // with the same params so the OS hands the code to the desktop app, and
  // leave the browser tab on a real page so it doesn't spin forever waiting
  // for a navigation that the kortix:// scheme never produces.
  if (desktop) {
    // The deep link is built from attacker-influenced query params, so the
    // HTML is rendered by a helper that escapes both the href attribute and the
    // inline <script> payload for their respective contexts (see desktop-bounce).
    return htmlBounce(buildDesktopBounceHtml(searchParams));
  }

  // Mobile registration begins in the installed app but completes in the web
  // browser. If a universal link was not intercepted, safely bounce the code
  // and opaque state back to the app; the app validates state before use.
  if (mobile) {
    return htmlBounce(buildMobileBounceHtml(searchParams));
  }

  // The request origin normally wins (local dev stays local); the self-host
  // wildcard-bind fall-back lives in resolveAuthRedirectBaseUrl.
  const runtimeEnv = getServerPublicEnv();
  const baseUrl = resolveAuthRedirectBaseUrl(request.nextUrl.origin, runtimeEnv.APP_URL);
  const error = searchParams.get('error');

  // Handle errors FIRST - before any Supabase operations that might affect session
  if (error) {
    console.error(
      'Auth callback error:',
      error,
      searchParams.get('error_code'),
      searchParams.get('error_description'),
    );
    if (isExpiredAuthParams(error, searchParams.get('error_code'), searchParams.get('error_description'))) {
      return expiredAuthRedirect(baseUrl, next);
    }
    return authErrorRedirect(baseUrl, error);
  }

  const supabase = await createClient();

  // Handle token-based verification (email confirmation, etc.)
  // Supabase sends these to the redirect URL for processing
  if (token && type) {
    // For token-based flows, redirect to auth page that can handle the verification client-side
    const verifyUrl = new URL(`${baseUrl}/auth`);
    verifyUrl.searchParams.set('token', token);
    verifyUrl.searchParams.set('type', type);
    if (termsAccepted) verifyUrl.searchParams.set('terms_accepted', 'true');

    return NextResponse.redirect(verifyUrl);
  }

  // No code or token - redirect to auth page
  if (!code) return NextResponse.redirect(`${baseUrl}/auth`);

  try {
    const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

    if (exchangeError) {
      console.error('Error exchanging code for session:', exchangeError);
      if (isExpiredAuthError(exchangeError)) return expiredAuthRedirect(baseUrl, next);
      return authErrorRedirect(baseUrl, exchangeError.message);
    }

    // TODO(sso-identity-mismatch-notice): an IdP can return an already
    // authenticated identity that differs from the email the user typed
    // on /auth (IdP session reuse) — they land signed in as someone else
    // with zero indication anything unusual happened. Once the typed
    // email travels through the redirect (query param or short-lived
    // cookie set before the IdP hop), compare it to data.user.email in
    // `resolveCallbackDestination` and carry a "You signed in as {actual_email}"
    // notice through to the redirect instead of proceeding silently.
    const { destination, authEvent, authMethod, clearReferralCookie } =
      await resolveCallbackDestination({
        supabase,
        user: data.user,
        next,
        request,
        runtimeEnv,
        termsAccepted,
      });

    // Web redirect - include auth event params for client-side tracking
    return sessionRedirect(baseUrl, destination, authEvent, authMethod, clearReferralCookie);
  } catch (error) {
    console.error('Unexpected error in auth callback:', error);
    return authErrorRedirect(baseUrl, 'unexpected_error');
  }
}
