'use server';

import { createTrialCheckout } from '@/lib/api/billing';
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';
import { createClient } from '@/lib/supabase/server';
import { getServerPublicEnv } from '@/lib/public-env-server';
import { redirect } from 'next/navigation';


export async function signIn(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  const origin = formData.get('origin') as string;
  const acceptedTerms = formData.get('acceptedTerms') === 'true';
  const isDesktopApp = formData.get('isDesktopApp') === 'true';

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  const supabase = await createClient();
  const normalizedEmail = email.trim().toLowerCase();

  // Use magic link (passwordless) authentication
  // For desktop app, use custom protocol (kortix://auth/callback) - same as mobile
  // For web, use standard origin (https://kortix.com/auth/callback)
  // Include email in redirect URL so it's available if the link expires
  let emailRedirectTo: string;
  if (isDesktopApp && origin.startsWith('kortix://')) {
    // Match mobile implementation - simple protocol URL with optional terms_accepted
    const params = new URLSearchParams();
    if (acceptedTerms) {
      params.set('terms_accepted', 'true');
    }
    emailRedirectTo = `kortix://auth/callback${params.toString() ? `?${params.toString()}` : ''}`;
  } else {
    emailRedirectTo = `${origin}/auth/callback?returnUrl=${encodeURIComponent(returnUrl)}&email=${encodeURIComponent(normalizedEmail)}${acceptedTerms ? '&terms_accepted=true' : ''}`;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo,
      shouldCreateUser: true, // Auto-create account if doesn't exist
    },
  });

  if (error) {
    return { message: error.message || 'Could not send magic link' };
  }

  // Return success message - user needs to check email
  return {
    success: true,
    message: 'Check your email for a magic link to sign in',
    email: email.trim().toLowerCase(),
  };
}

export async function signUp(prevState: any, formData: FormData) {
  const origin = formData.get('origin') as string;
  const email = formData.get('email') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  const acceptedTerms = formData.get('acceptedTerms') === 'true';
  const referralCode = formData.get('referralCode') as string | undefined;
  const isDesktopApp = formData.get('isDesktopApp') === 'true';

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  if (!acceptedTerms) {
    return { message: 'Please accept the terms and conditions' };
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Check access control — if signups are closed and email isn't allowlisted, block
  let shouldCreateUser = true;
  try {
    const backendUrl = getServerPublicEnv().BACKEND_URL || 'http://localhost:8008/v1';
    const res = await fetch(`${backendUrl}/access/check-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normalizedEmail }),
    });
    if (res.ok) {
      const data = await res.json();
      shouldCreateUser = data.allowed;
    }
    // If fetch fails, fail-open (allow signup)
  } catch {
    // Fail open — allow signup if access control service is unreachable
  }

  if (!shouldCreateUser) {
    return { signupClosed: true, message: 'Signups are currently closed. Request access below.' };
  }

  const supabase = await createClient();

  // Use magic link (passwordless) authentication - auto-creates account
  let emailRedirectTo: string;
  if (isDesktopApp && origin.startsWith('kortix://')) {
    const params = new URLSearchParams();
    if (acceptedTerms) {
      params.set('terms_accepted', 'true');
    }
    emailRedirectTo = `kortix://auth/callback${params.toString() ? `?${params.toString()}` : ''}`;
  } else {
    emailRedirectTo = `${origin}/auth/callback?returnUrl=${encodeURIComponent(returnUrl)}&email=${encodeURIComponent(normalizedEmail)}${acceptedTerms ? '&terms_accepted=true' : ''}`;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo,
      shouldCreateUser: true,
      data: referralCode ? {
        referral_code: referralCode.trim().toUpperCase(),
      } : undefined,
    },
  });

  if (error) {
    return { message: error.message || 'Could not send magic link' };
  }

  return {
    success: true,
    message: 'Check your email for a magic link to complete sign up',
    email: email.trim().toLowerCase(),
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
    const res = await fetch(`${backendUrl}/access/request-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        company: company?.trim() || undefined,
        useCase: useCase?.trim() || undefined,
      }),
    });
    if (res.ok) {
      return { success: true, message: 'Your access request has been submitted. We\'ll be in touch!' };
    }
    return { message: 'Failed to submit request. Please try again.' };
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
    redirectTo: `${origin}/auth/reset-password`,
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

export async function resendMagicLink(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  const origin = formData.get('origin') as string;
  const acceptedTerms = formData.get('acceptedTerms') === 'true';
  const isDesktopApp = formData.get('isDesktopApp') === 'true';

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  const supabase = await createClient();
  const normalizedEmail = email.trim().toLowerCase();

  // Use magic link (passwordless) authentication
  // For desktop app, use custom protocol (kortix://auth/callback) - same as mobile
  // For web, use standard origin (https://kortix.com/auth/callback)
  // Include email in redirect URL so it's available if the link expires
  let emailRedirectTo: string;
  if (isDesktopApp && origin.startsWith('kortix://')) {
    // Match mobile implementation - simple protocol URL with optional terms_accepted
    const params = new URLSearchParams();
    if (acceptedTerms) {
      params.set('terms_accepted', 'true');
    }
    emailRedirectTo = `kortix://auth/callback${params.toString() ? `?${params.toString()}` : ''}`;
  } else {
    emailRedirectTo = `${origin}/auth/callback?returnUrl=${encodeURIComponent(returnUrl)}&email=${encodeURIComponent(normalizedEmail)}${acceptedTerms ? '&terms_accepted=true' : ''}`;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo,
      shouldCreateUser: true, // Auto-create account if doesn't exist
    },
  });

  if (error) {
    return { message: error.message || 'Could not send magic link' };
  }

  // Return success message - user needs to check email
  return {
    success: true,
    message: 'Check your email for a magic link to sign in',
    email: email.trim().toLowerCase(),
  };
}

export async function sendOtpCode(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  const origin = formData.get('origin') as string;
  const isDesktopApp = formData.get('isDesktopApp') === 'true';

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  const supabase = await createClient();
  const normalizedEmail = email.trim().toLowerCase();

  let emailRedirectTo: string;
  if (isDesktopApp && origin.startsWith('kortix://')) {
    emailRedirectTo = 'kortix://auth/callback';
  } else {
    emailRedirectTo = `${origin}/auth/callback?returnUrl=${encodeURIComponent(returnUrl)}&email=${encodeURIComponent(normalizedEmail)}`;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo,
      shouldCreateUser: true,
    },
  });

  if (error) {
    return { message: error.message || 'Could not send verification code' };
  }

  return {
    success: true,
    message: 'Check your email for a 6-digit verification code',
    email: normalizedEmail,
  };
}

export async function signInWithPassword(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  if (!password || password.length < 6) {
    return { message: 'Password must be at least 6 characters' };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error) {
    return { message: error.message || 'Invalid email or password' };
  }

  // Determine if new user (for analytics)
  const isNewUser = data.user && (Date.now() - new Date(data.user.created_at).getTime()) < 60000;
  const authEvent = isNewUser ? 'signup' : 'login';
  
  // Return success — let the client redirect after auth state hydrates.
  const finalReturnUrl = returnUrl;
  const redirectUrl = new URL(finalReturnUrl, 'http://localhost');
  redirectUrl.searchParams.set('auth_event', authEvent);
  redirectUrl.searchParams.set('auth_method', 'email');

  return {
    success: true,
    redirectTo: `${redirectUrl.pathname}${redirectUrl.search}`,
  };
}

export async function signUpWithPassword(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const confirmPassword = formData.get('confirmPassword') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  const origin = formData.get('origin') as string;

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  if (!password || password.length < 6) {
    return { message: 'Password must be at least 6 characters' };
  }

  if (password !== confirmPassword) {
    return { message: 'Passwords do not match' };
  }

  const supabase = await createClient();

  const baseUrl = origin || getServerPublicEnv().APP_URL || 'http://localhost:3000';
  const emailRedirectTo = `${baseUrl}/auth/callback?returnUrl=${encodeURIComponent(returnUrl)}`;

  const { error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      emailRedirectTo,
    },
  });

  if (error) {
    return { message: error.message || 'Could not create account' };
  }

  // Return success - client will handle redirect
  const finalReturnUrl = returnUrl;
  redirect(finalReturnUrl);
}

/**
 * Self-hosted installer: create the owner account + immediately sign in.
 * Only works when email confirmations are disabled (self-hosted Supabase).
 *
 * This runs SERVER-SIDE so it uses runtime env vars (SUPABASE_URL,
 * SUPABASE_ANON_KEY) instead of NEXT_PUBLIC_ vars that are baked at build
 * time — critical for Docker deployments where the baked values are stale.
 *
 * Returns the access_token so the client-side wizard can continue with
 * sandbox provisioning (which requires the JWT for Bearer auth to the
 * backend API, and may involve async polling for Docker image pulls).
 */
export async function installOwner(_prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const confirmPassword = formData.get('confirmPassword') as string;

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  if (!password || password.length < 6) {
    return { message: 'Password must be at least 6 characters' };
  }

  if (password !== confirmPassword) {
    return { message: 'Passwords do not match' };
  }

  const supabase = await createClient();

  // Sign up (auto-confirmed when enable_confirmations = false)
  const { error: signUpError } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
  });

  // If user already exists, fall through to sign-in instead of erroring
  const alreadyExists = signUpError &&
    (signUpError.message?.toLowerCase().includes('already registered') ||
     signUpError.message?.toLowerCase().includes('already exists') ||
     signUpError.status === 422);

  if (signUpError && !alreadyExists) {
    return { message: signUpError.message || 'Could not create account' };
  }

  // Sign in (either after fresh signup or if user already existed)
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (signInError) {
    return { message: signInError.message || 'Account created but could not sign in' };
  }

  // Return the access token so the client wizard can provision the sandbox.
  // We intentionally do NOT provision the sandbox here because the local
  // Docker flow involves async image pulling with progress polling that
  // the client-side wizard handles with its own UI.
  return {
    success: true,
    accessToken: signInData.session?.access_token || null,
    refreshToken: signInData.session?.refresh_token || null,
  };
}

/**
 * Self-hosted sign-in for returning users.
 * Runs SERVER-SIDE to use runtime env vars instead of baked NEXT_PUBLIC_ vars.
 */
export async function selfHostedSignIn(_prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  if (!password || password.length < 6) {
    return { message: 'Password must be at least 6 characters' };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error) {
    return { message: error.message || 'Invalid email or password' };
  }

  return {
    success: true,
    redirectTo: returnUrl,
    accessToken: data.session?.access_token || null,
    refreshToken: data.session?.refresh_token || null,
  };
}

export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();

  if (error) {
    return { message: error.message || 'Could not sign out' };
  }

  return redirect('/');
}

export async function verifyOtp(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const token = formData.get('token') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);

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
  const isNewUser = data.user && (Date.now() - new Date(data.user.created_at).getTime()) < 60000;
  const authEvent = isNewUser ? 'signup' : 'login';

  // For new cloud users with no plan yet, send them to /subscription first.
  const runtimeEnv = getServerPublicEnv();
  const billingEnabled = runtimeEnv.ENV_MODE === 'cloud';
  let finalDestination = returnUrl;

  if (billingEnabled && isNewUser && data.session?.access_token) {
    try {
      const backendUrl = (process.env.BACKEND_URL || runtimeEnv.BACKEND_URL || '').replace(/\/v1\/?$/, '');
      if (backendUrl) {
        const accountStateRes = await fetch(`${backendUrl}/v1/billing/account-state`, {
          headers: { 'Authorization': `Bearer ${data.session.access_token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (accountStateRes.ok) {
          const accountState = await accountStateRes.json();
          const tierKey = accountState?.subscription?.tier_key || accountState?.tier?.name || '';
          if (!tierKey || tierKey === 'none') {
            finalDestination = '/subscription';
          }
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
  };
}
