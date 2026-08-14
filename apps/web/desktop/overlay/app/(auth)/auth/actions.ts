'use client';

/**
 * Desktop-bundle replacement for the auth server actions.
 *
 * WHY THIS FILE EXISTS
 * `output: 'export'` cannot emit server actions, so the real `actions.ts`
 * ('use server') cannot ship in the desktop bundle. But the auth PAGE is worth
 * keeping exactly as-is — it owns the unified email→code-or-password flow, the
 * provider list driven by NEXT_PUBLIC_AUTH_*, the SSO/signups-closed copy, and
 * the "never tell a new email it has invalid credentials" behaviour. Replacing
 * the page would fork all of that.
 *
 * So the swap happens one layer down. `page.tsx` calls these as plain async
 * functions (`await signInWithPassword(null, formData)`), not through
 * useActionState, so this module only has to match their signatures and return
 * shapes. The real page then compiles and runs unchanged.
 *
 * These are the SAME Supabase calls the server actions make — the server half
 * existed for SSR cookie plumbing, which a bundle has no use for. The page
 * already finishes every successful login with `supabase.auth.setSession()`,
 * so the session lands in exactly the same place either way.
 *
 * KNOWN GAPS vs the server actions, deliberate and listed rather than hidden:
 *   · resolveAuthMode returns 'unknown'. The real one calls checkEmailFlowMode,
 *     a privileged lookup a client must not be able to make (it would be an
 *     account-existence oracle). The page already handles 'unknown' — it
 *     relabels the step once an attempt proves which case it was.
 *   · The `sso_required` and `signups_closed` gates are enforced server-side by
 *     the real actions. Supabase itself still rejects a password login for an
 *     SSO-only account, but the friendly copy is lost. See TODO below.
 */

import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { createClient } from '@/lib/supabase/client';

type ActionResult = Record<string, unknown>;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedEmail(formData: FormData): string {
  return field(formData, 'email').toLowerCase();
}

function destination(formData: FormData): string {
  const requested = sanitizeAuthReturnUrl(field(formData, 'returnUrl') || undefined);
  return requested || PROJECT_LANDING_PATH;
}

/**
 * Shape the page expects from a successful credential/OTP action: the tokens it
 * hands to `supabase.auth.setSession()`, plus where to go next.
 */
function sessionResult(
  session: { access_token?: string; refresh_token?: string } | null | undefined,
  redirectTo: string,
  extra: ActionResult = {},
): ActionResult {
  return {
    success: true,
    redirectTo,
    accessToken: session?.access_token ?? null,
    refreshToken: session?.refresh_token ?? null,
    // Desktop is never the mobile handoff target.
    mobileHandoffUrl: null,
    ...extra,
  };
}

/**
 * The real action decides sign-in vs sign-up before the user commits. That needs
 * a privileged lookup, so the bundle declines to guess.
 */
export async function resolveAuthMode(_email: string): Promise<{ mode: string }> {
  return { mode: 'unknown' };
}

export async function sendEmailCode(_prevState: unknown, formData: FormData) {
  const email = normalizedEmail(formData);
  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithOtp({ email });
  if (error) return { message: error.message || 'Could not send the code' };

  return { success: true, message: 'Check your email for a sign-in code', email };
}

export async function verifyOtp(_prevState: unknown, formData: FormData) {
  const email = normalizedEmail(formData);
  const token = field(formData, 'token');
  if (!email || !email.includes('@')) return { message: 'Please enter a valid email address' };
  if (!token) return { message: 'Please enter the 6-digit code from your email' };

  const supabase = createClient();
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) return { message: error.message || 'Invalid or expired code' };

  return sessionResult(data.session, destination(formData), {
    authEvent: 'sign_in',
    authMethod: 'email_otp',
  });
}

export async function signInWithPassword(_prevState: unknown, formData: FormData) {
  const email = normalizedEmail(formData);
  const password = (formData.get('password') as string) || '';
  if (!email || !email.includes('@')) return { message: 'Please enter a valid email address' };
  if (password.length < 6) return { message: 'Password must be at least 6 characters' };

  const supabase = createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // TODO(desktop): the server action maps an SSO-only account to
    // `code: 'sso_required'` with dedicated copy. Reproducing that needs a
    // server lookup, so for now the user sees Supabase's own message.
    return { message: error.message || 'Invalid email or password' };
  }

  return sessionResult(data.session, destination(formData));
}

export async function signUpWithPassword(_prevState: unknown, formData: FormData) {
  const email = normalizedEmail(formData);
  const password = (formData.get('password') as string) || '';
  const confirmPassword = (formData.get('confirmPassword') as string) || '';
  if (!email || !email.includes('@')) return { message: 'Please enter a valid email address' };
  if (password.length < 6) return { message: 'Password must be at least 6 characters' };
  if (password !== confirmPassword) return { message: 'Passwords do not match' };

  const supabase = createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { message: error.message || 'Could not create account' };

  // Email-confirmation projects return a user with no session. The page renders
  // this as an info strip rather than an error.
  if (!data.session) {
    return {
      requiresEmailConfirmation: true,
      message: 'Check your email to confirm your account',
    };
  }

  return sessionResult(data.session, destination(formData));
}

export async function forgotPassword(_prevState: unknown, formData: FormData) {
  const email = normalizedEmail(formData);
  if (!email || !email.includes('@')) return { message: 'Please enter a valid email address' };

  const supabase = createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/auth/reset-password`,
  });
  if (error) return { message: error.message || 'Could not send password reset email' };

  return { success: true, message: 'Check your email for a password reset link' };
}

export async function resetPassword(_prevState: unknown, formData: FormData) {
  const password = (formData.get('password') as string) || '';
  const confirmPassword = (formData.get('confirmPassword') as string) || '';
  if (password.length < 6) return { message: 'Password must be at least 6 characters' };
  if (password !== confirmPassword) return { message: 'Passwords do not match' };

  const supabase = createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { message: error.message || 'Could not update password' };

  return { success: true, message: 'Password updated' };
}

export async function signOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
  window.location.replace('/auth');
}

export async function requestAccess(_prevState: unknown, _formData: FormData) {
  // Waitlist/access requests post to a Next route handler that the bundle does
  // not ship. The desktop app is for existing accounts.
  return { message: 'Request access at kortix.com.' };
}
