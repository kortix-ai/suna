'use server';

import { createTrialCheckout } from '@/lib/api/billing';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';


export async function signIn(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const returnUrl = formData.get('returnUrl') as string | undefined;
  const origin = formData.get('origin') as string;
  const acceptedTerms = formData.get('acceptedTerms') === 'true';
  const isDesktopApp = formData.get('isDesktopApp') === 'true';

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  const supabase = await createClient();

  // Use magic link (passwordless) authentication
  // For desktop app, use custom protocol (kortix://auth/callback) - same as mobile
  // For web, use standard origin (https://kortix.com/auth/callback)
  let emailRedirectTo: string;
  if (isDesktopApp && origin.startsWith('kortix://')) {
    // Match mobile implementation - simple protocol URL with optional terms_accepted
    const params = new URLSearchParams();
    if (acceptedTerms) {
      params.set('terms_accepted', 'true');
    }
    emailRedirectTo = `kortix://auth/callback${params.toString() ? `?${params.toString()}` : ''}`;
  } else {
    emailRedirectTo = `${origin}/auth/callback?returnUrl=${encodeURIComponent(returnUrl || '/dashboard')}${acceptedTerms ? '&terms_accepted=true' : ''}`;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
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
  const returnUrl = formData.get('returnUrl') as string | undefined;
  const acceptedTerms = formData.get('acceptedTerms') === 'true';
  const referralCode = formData.get('referralCode') as string | undefined;
  const isDesktopApp = formData.get('isDesktopApp') === 'true';

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  if (!acceptedTerms) {
    return { message: 'Please accept the terms and conditions' };
  }

  const supabase = await createClient();

  // Use magic link (passwordless) authentication - auto-creates account
  // For desktop app, use custom protocol (kortix://auth/callback) - same as mobile
  // For web, use standard origin (https://kortix.com/auth/callback)
  let emailRedirectTo: string;
  if (isDesktopApp && origin.startsWith('kortix://')) {
    // Match mobile implementation - simple protocol URL with optional terms_accepted
    const params = new URLSearchParams();
    if (acceptedTerms) {
      params.set('terms_accepted', 'true');
    }
    emailRedirectTo = `kortix://auth/callback${params.toString() ? `?${params.toString()}` : ''}`;
  } else {
    emailRedirectTo = `${origin}/auth/callback?returnUrl=${encodeURIComponent(returnUrl || '/dashboard')}${acceptedTerms ? '&terms_accepted=true' : ''}`;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
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

  // Return success message - user needs to check email
    return {
    success: true, 
    message: 'Check your email for a magic link to complete sign up',
    email: email.trim().toLowerCase(),
    };
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
  const returnUrl = formData.get('returnUrl') as string | undefined;
  const origin = formData.get('origin') as string;
  const acceptedTerms = formData.get('acceptedTerms') === 'true';
  const isDesktopApp = formData.get('isDesktopApp') === 'true';

  if (!email || !email.includes('@')) {
    return { message: 'Please enter a valid email address' };
  }

  const supabase = await createClient();

  // Use magic link (passwordless) authentication
  // For desktop app, use custom protocol (kortix://auth/callback) - same as mobile
  // For web, use standard origin (https://kortix.com/auth/callback)
  let emailRedirectTo: string;
  if (isDesktopApp && origin.startsWith('kortix://')) {
    // Match mobile implementation - simple protocol URL with optional terms_accepted
    const params = new URLSearchParams();
    if (acceptedTerms) {
      params.set('terms_accepted', 'true');
    }
    emailRedirectTo = `kortix://auth/callback${params.toString() ? `?${params.toString()}` : ''}`;
  } else {
    emailRedirectTo = `${origin}/auth/callback?returnUrl=${encodeURIComponent(returnUrl || '/dashboard')}${acceptedTerms ? '&terms_accepted=true' : ''}`;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
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

export async function signInWithPassword(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const returnUrl = formData.get('returnUrl') as string | undefined;

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
  
  // Return success - client will handle redirect with auth tracking params
  const finalReturnUrl = returnUrl || '/dashboard';
  const redirectUrl = new URL(finalReturnUrl, 'http://localhost');
  redirectUrl.searchParams.set('auth_event', authEvent);
  redirectUrl.searchParams.set('auth_method', 'email');
  redirect(`${redirectUrl.pathname}${redirectUrl.search}`);
}

export async function signUpWithPassword(prevState: any, formData: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const confirmPassword = formData.get('confirmPassword') as string;
  const returnUrl = formData.get('returnUrl') as string | undefined;
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

  const baseUrl = origin || process.env.NEXT_PUBLIC_URL || 'http://localhost:3000';
  const emailRedirectTo = `${baseUrl}/auth/callback?returnUrl=${encodeURIComponent(returnUrl || '/dashboard')}`;

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
  const finalReturnUrl = returnUrl || '/dashboard';
  redirect(finalReturnUrl);
}

export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();

  if (error) {
    return { message: error.message || 'Could not sign out' };
  }

  return redirect('/');
}
