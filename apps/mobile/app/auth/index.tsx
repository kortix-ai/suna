/**
 * Auth Screen — login only (photo-hero lock screen).
 *
 * Mobile supports sign-in only; new accounts are created on the web. The email
 * auth method (magic link or password) and social providers render based on env
 * (see lib/auth/auth-config), never hardcoded:
 *   EXPO_PUBLIC_AUTH_METHODS    "magic" / "password"
 *   EXPO_PUBLIC_AUTH_PROVIDERS  "google" / "apple"
 *
 * Layout: full-bleed hero image on top, brand + provider pills below on a dark
 * base. Always-dark, independent of the app theme.
 */

import * as React from 'react';
import { View, Dimensions, Platform, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Mail } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { KortixCurrents } from '@/components/animations/kortix-currents';
import { AppleIcon, GoogleIcon } from '@/components/icons/auth-icons';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetBody, type SheetRef } from '@/components/ui/sheet';
import { useAuthContext } from '@/contexts';
import { supabase } from '@/api/supabase';
import { log } from '@/lib/logger';
import { magicLinkEnabled, passwordEnabled, type AuthMethod } from '@/lib/auth/auth-config';
import { useThemeStore } from '@/stores/theme-store';

const friendlySignInError = (msg?: string): string => {
  if (!msg) return 'Could not sign in';
  if (msg.includes('Invalid login credentials'))
    return 'Invalid email or password. Please try again.';
  if (msg.includes('Email not confirmed')) return 'Please confirm your email before signing in.';
  return msg;
};

const friendlyMagicError = (msg?: string): string => {
  if (!msg) return 'Could not send verification code.';
  if (/signups? not allowed|not allowed for otp|user not found|no user/i.test(msg)) {
    return 'No account found for that email. Create one on the web first.';
  }
  return msg;
};

// ── Lock-screen palette (fixed — always dark) ────────────────────────────────
const BG_DARK = '#000000';
const PILL_LIGHT_TEXT = '#0A0A0A'; // ActivityIndicator + Apple glyph on white pills
const TEXT_ON_DARK = '#FFFFFF'; // ActivityIndicator on dark pills

const SCREEN_H = Dimensions.get('window').height;
const HERO_H = Math.round(SCREEN_H * 0.8);

/**
 * Full-width auth pill built on the shared Button + Text primitives.
 * Uses `inverted` so light mode → dark pill / light text, dark mode → light
 * pill / dark text. Icon + spinner colors follow the resolved theme.
 */
function AuthPill({
  label,
  onPress,
  disabled,
  loading,
  leading,
  variant = 'white',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  leading?: React.ReactNode;
  variant?: React.ComponentProps<typeof Button>['variant'];
}) {
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  // Inverted: light mode = dark fill → light glyph; dark mode = light fill → dark glyph
  const onInverted = resolvedTheme === 'dark' ? PILL_LIGHT_TEXT : TEXT_ON_DARK;

  return (
    <Button
      onPress={onPress}
      disabled={disabled}
      variant={variant}
      size="lg"
      className="h-14 w-full text-base">
      {loading ? <ActivityIndicator size="small" color={onInverted} /> : (leading ?? null)}
      <Text variant="large">{label}</Text>
    </Button>
  );
}

export default function AuthScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const {
    isAuthenticated,
    signIn,
    signUp,
    signInWithMagicLink,
    signInWithOAuth,
    resetPassword,
    oauthRejection,
    clearOauthRejection,
  } = useAuthContext();

  const handleThemeToggle = React.useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void toggleTheme();
  }, [toggleTheme]);

  // Email sheet: sign in vs create account (registration happens in-app).
  const [mode, setMode] = React.useState<'signin' | 'signup'>('signin');
  const [method, setMethod] = React.useState<AuthMethod>(magicLinkEnabled ? 'magic' : 'password');

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');

  const [loading, setLoading] = React.useState(false);
  const [oauthLoading, setOauthLoading] = React.useState<'google' | 'apple' | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);

  // Magic-link OTP follow-up
  const [sentEmail, setSentEmail] = React.useState<string | null>(null);
  const [otpCode, setOtpCode] = React.useState('');
  const [verifying, setVerifying] = React.useState(false);

  const emailSheetRef = React.useRef<SheetRef>(null);
  const [emailSheetOpen, setEmailSheetOpen] = React.useState(false);

  const awaitingCode = method === 'magic' && !!sentEmail;

  // Already-signed-in users never see auth.
  React.useEffect(() => {
    if (isAuthenticated) router.replace('/projects');
  }, [isAuthenticated, router]);

  // A brand-new OAuth account was rejected (mobile is login-only) — surface it.
  React.useEffect(() => {
    if (!oauthRejection) return;
    setOauthLoading(null);
    setInfo(null);
    setErrorMessage(oauthRejection);
    clearOauthRejection();
  }, [oauthRejection, clearOauthRejection]);

  const resetTransient = React.useCallback(() => {
    setErrorMessage(null);
    setInfo(null);
    setSentEmail(null);
    setOtpCode('');
    setConfirmPassword('');
  }, []);

  // ── Create account (in-app registration, password) ────────────────────────
  const handleSignUp = React.useCallback(async () => {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }
    if (!password || password.length < 6) {
      setErrorMessage('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    setInfo(null);
    try {
      const res = await signUp({ email: trimmedEmail, password });
      if (!res?.success) {
        setErrorMessage(res?.error?.message || 'Could not create your account.');
        return;
      }
      if (res.requiresEmailConfirmation) {
        setInfo('Check your email to confirm your account, then sign in.');
        return;
      }
      router.replace('/projects');
    } catch (err: any) {
      log.error('Sign-up exception:', err);
      setErrorMessage(err?.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  }, [email, password, confirmPassword, signUp, router]);

  const openLegal = React.useCallback(async (tab: 'privacy' | 'terms') => {
    try {
      const WebBrowser = await import('expo-web-browser');
      await WebBrowser.openBrowserAsync(`https://www.kortix.com/legal?tab=${tab}`, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (error) {
      log.warn('Unable to open legal page:', error);
    }
  }, []);

  // ── Submit (email methods) ────────────────────────────────────────────────
  const handleSubmit = React.useCallback(async () => {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    setInfo(null);

    try {
      if (method === 'magic') {
        const res = await signInWithMagicLink({ email: trimmedEmail });
        if (!res?.success) {
          setErrorMessage(friendlyMagicError(res?.error?.message));
          return;
        }
        setSentEmail(trimmedEmail);
        setOtpCode('');
        setInfo(`We sent a 6-digit code to ${trimmedEmail}`);
        return;
      }

      // password sign-in
      if (!password || password.length < 6) {
        setErrorMessage('Password must be at least 6 characters.');
        return;
      }
      const res = await signIn({ email: trimmedEmail, password });
      if (!res?.success) {
        setErrorMessage(friendlySignInError(res?.error?.message));
        return;
      }
      router.replace('/projects');
    } catch (err: any) {
      log.error('Auth submit exception:', err);
      setErrorMessage(err?.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  }, [email, password, method, signIn, signInWithMagicLink, router]);

  // ── Verify OTP code ───────────────────────────────────────────────────────
  const handleVerifyOtp = React.useCallback(async () => {
    const code = otpCode.trim();
    if (code.length < 6) {
      setErrorMessage('Please enter the 6-digit code from your email.');
      return;
    }
    setVerifying(true);
    setErrorMessage(null);
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: (sentEmail ?? email).trim().toLowerCase(),
        token: code,
        type: 'email',
      });
      if (error) {
        setErrorMessage(
          /expired|invalid/i.test(error.message)
            ? 'Code expired or invalid. Please request a new one.'
            : error.message
        );
        return;
      }
      if (data.session) router.replace('/projects');
    } catch (err: any) {
      setErrorMessage(err?.message || 'Verification failed.');
    } finally {
      setVerifying(false);
    }
  }, [otpCode, sentEmail, email, router]);

  // ── Forgot password ───────────────────────────────────────────────────────
  const handleForgotPassword = React.useCallback(async () => {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setErrorMessage('Enter your email above, then tap reset.');
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    setInfo(null);
    try {
      const res = await resetPassword({ email: trimmedEmail });
      if (!res?.success) {
        setErrorMessage(res?.error?.message || 'Could not send reset email.');
        return;
      }
      setInfo('Check your email for a password reset link.');
    } finally {
      setLoading(false);
    }
  }, [email, resetPassword]);

  // ── OAuth ─────────────────────────────────────────────────────────────────
  const handleOAuth = React.useCallback(
    async (provider: 'google' | 'apple') => {
      try {
        setOauthLoading(provider);
        setErrorMessage(null);
        const res = await signInWithOAuth(provider);
        // Existing users are navigated by the isAuthenticated effect; a brand-new
        // account is rejected via oauthRejection (registration is web-only).
        if (!res?.success && res?.error?.message && !/cancel/i.test(res.error.message)) {
          setErrorMessage(res.error.message);
        }
      } catch (err: any) {
        setErrorMessage(err?.message || `${provider} sign-in failed.`);
      } finally {
        setOauthLoading(null);
      }
    },
    [signInWithOAuth]
  );

  const submitLoadingLabel = method === 'magic' ? 'Sending code...' : 'Signing in...';

  // Signing up always needs a password; signing in may use a code instead.
  const isSignup = mode === 'signup';
  const showPasswordField = isSignup || method === 'password';
  const canSwitchMethod = !isSignup && magicLinkEnabled && passwordEnabled;

  const toggleMode = React.useCallback(() => {
    void Haptics.selectionAsync();
    setMode((m) => (m === 'signin' ? 'signup' : 'signin'));
    resetTransient();
  }, [resetTransient]);

  const toggleMethod = React.useCallback(() => {
    void Haptics.selectionAsync();
    // The password field is about to unmount — don't keep its value around.
    setPassword('');
    setMethod((m) => (m === 'magic' ? 'password' : 'magic'));
    resetTransient();
  }, [resetTransient]);

  // Continue stays inert until the form can actually be submitted:
  // muted pill → solid pill the moment the email is valid.
  const emailValid = /\S+@\S+\.\S+/.test(email.trim());
  const canSubmit = isSignup
    ? emailValid && password.length >= 6 && confirmPassword.length >= 6
    : method === 'password'
      ? emailValid && password.length >= 6
      : emailValid;

  const statusBanner = errorMessage ? (
    <View
      className="mb-3 w-full rounded-2xl px-4 py-3"
      style={{ backgroundColor: 'rgba(255,69,58,0.16)' }}>
      <Text variant="small" className="text-center text-destructive">
        {errorMessage}
      </Text>
    </View>
  ) : info ? (
    <View
      className="mb-3 w-full rounded-2xl px-4 py-3"
      style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}>
      <Text variant="muted" className="text-center">
        {info}
      </Text>
    </View>
  ) : null;

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: BG_DARK }}>
        {/* Hero — the Kortix mark forming out of a flow field (top half) */}
        <View style={{ height: HERO_H, width: '100%' }}>
          {/* The hero runs 80% of the screen, so a centred mark lands near the
              middle. Bias it up into the field's clear upper half. */}
          <KortixCurrents markCenterY={0.4} />
          {/* Fade the field into the dark base */}
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.85)', BG_DARK]}
            locations={[0, 0.35, 0.78, 1]}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: HERO_H * 0.5 }}
            pointerEvents="none"
          />
        </View>

        {/* Bottom content */}
        <View
          style={{
            flex: 1,
            paddingHorizontal: 24,
            paddingBottom: insets.bottom + 14,
            justifyContent: 'flex-end',
          }}>
          {/* Brand + actions + footer */}
          <View style={{ width: '100%' }}>
            {/* The symbol is already forming in the field above, so this is the
                logomark — never the symbol a second time. */}
            <View style={{ alignItems: 'center', marginBottom: 28 }}>
              <KortixLogo variant="text" size={28} color="dark" />
            </View>

            {!emailSheetOpen && statusBanner}

            <View style={{ gap: 12 }}>
              {/* Apple — iOS only */}
              {Platform.OS === 'ios' && (
                <AuthPill
                  label={oauthLoading === 'apple' ? 'Signing in…' : 'Continue with Apple'}
                  loading={oauthLoading === 'apple'}
                  disabled={!!oauthLoading}
                  onPress={() => handleOAuth('apple')}
                  leading={<AppleIcon size={19} color={PILL_LIGHT_TEXT} />}
                />
              )}

              {/* Google — both platforms */}
              <AuthPill
                label={oauthLoading === 'google' ? 'Opening Google…' : 'Continue with Google'}
                loading={oauthLoading === 'google'}
                disabled={!!oauthLoading}
                onPress={() => handleOAuth('google')}
                leading={<GoogleIcon size={19} />}
              />

              {/* Email — both platforms */}
              <AuthPill
                variant="secondary"
                label="Continue with email"
                disabled={!!oauthLoading}
                onPress={() => {
                  setEmailSheetOpen(true);
                  emailSheetRef.current?.open();
                }}
              />
            </View>

            {/* Footer — legal */}
            <View
              style={{
                marginTop: 22,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 28,
              }}>
              <TouchableOpacity onPress={() => openLegal('privacy')} hitSlop={8}>
                <Text variant="muted" className="text-white/50">
                  Privacy policy
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => openLegal('terms')} hitSlop={8}>
                <Text variant="muted" className="text-white/50">
                  Terms of service
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>

      {/* Email auth sheet — full screen. With the back chevron gone, the swipe
          gesture is the only way out, so it has to be enabled. */}
      <Sheet
        ref={emailSheetRef}
        fullScreen
        enablePanDownToClose
        onDismiss={() => setEmailSheetOpen(false)}>
        <SheetBody className="flex-1 pt-4">
          {statusBanner}

          {awaitingCode ? (
            /* ── OTP code phase ── */
            <View className="flex-1">
              <View className="items-center gap-3 pt-6">
                <View className="h-16 w-16 items-center justify-center rounded-full bg-card">
                  <Icon as={Mail} size={26} className="text-muted-foreground" />
                </View>
                <Text variant="large">Check your email</Text>
                <Text variant="muted" className="text-center">
                  A temporary sign-in code has been sent to {(sentEmail ?? email).trim()}
                </Text>
              </View>

              <Input
                value={otpCode}
                onChangeText={setOtpCode}
                placeholder="Enter code"
                keyboardType="numeric"
                autoComplete="one-time-code"
                returnKeyType="go"
                onSubmitEditing={handleVerifyOtp}
                className="mt-8 text-center"
              />

              <View className="flex-1" />

              <Button
                size="lg"
                variant="default"
                className="h-14 w-full"
                onPress={handleVerifyOtp}
                disabled={verifying || otpCode.trim().length < 6}>
                {verifying && <ActivityIndicator size="small" color="#FFFFFF" />}
                <Text>{verifying ? 'Verifying...' : 'Continue'}</Text>
              </Button>

              <View className="mt-4 flex-row items-center justify-center gap-6">
                <Button variant="transparent" onPress={handleSubmit} disabled={loading}>
                  <Text>Resend code</Text>
                </Button>
                <Button variant="transparent" onPress={resetTransient}>
                  <Text>Use a different email</Text>
                </Button>
              </View>
            </View>
          ) : (
            /* ── Sign in / Create account ── */
            <View className="flex-1">
              {/* The heading carries the mode, so the form needs no tab bar. */}
              <View className="gap-1.5 pb-7">
                <Text variant="h3" className="font-roobert-semibold">
                  {isSignup ? 'Create account' : 'Sign in'}
                </Text>
                <Text variant="muted">
                  {isSignup
                    ? 'Choose a password to finish setting up your account.'
                    : showPasswordField
                      ? 'Enter your email and password to continue.'
                      : 'We’ll email you a 6-digit code — no password needed.'}
                </Text>
              </View>

              <View className="gap-3">
                <Input
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Email"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  returnKeyType={showPasswordField ? 'next' : 'go'}
                  onSubmitEditing={() => {
                    if (!showPasswordField) handleSubmit();
                  }}
                />

                {showPasswordField && (
                  <Input
                    value={password}
                    onChangeText={setPassword}
                    placeholder="Password"
                    secureTextEntry
                    autoComplete={isSignup ? 'new-password' : 'password'}
                    returnKeyType={isSignup ? 'next' : 'go'}
                    onSubmitEditing={() => {
                      if (!isSignup) handleSubmit();
                    }}
                  />
                )}

                {isSignup && (
                  <Input
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    placeholder="Confirm password"
                    secureTextEntry
                    autoComplete="new-password"
                    returnKeyType="go"
                    onSubmitEditing={handleSignUp}
                  />
                )}
              </View>

              {/* Recovery belongs to the password field it sits under. */}
              {!isSignup && showPasswordField && (
                <Button
                  variant="transparent"
                  size="sm"
                  className="mt-1 self-end"
                  onPress={handleForgotPassword}>
                  <Text variant="small">Forgot password?</Text>
                </Button>
              )}

              {/* Push the primary action to the bottom of the sheet */}
              <View className="flex-1" />

              <Button
                size="lg"
                variant="default"
                className="h-14 w-full"
                onPress={isSignup ? handleSignUp : handleSubmit}
                disabled={loading || !canSubmit}>
                {loading && <ActivityIndicator size="small" color="#FFFFFF" />}
                <Text>
                  {isSignup
                    ? loading
                      ? 'Creating account…'
                      : 'Create account'
                    : loading
                      ? submitLoadingLabel
                      : 'Continue'}
                </Text>
              </Button>

              {/* The method switch is an alternative to the button above it, so
                  that is where it lives — not floating among the inputs. */}
              {canSwitchMethod && (
                <Button
                  variant="transparent"
                  className="mt-2 self-center"
                  disabled={loading}
                  onPress={toggleMethod}>
                  <Text variant="small">
                    {method === 'magic' ? 'Use password instead' : 'Use email code instead'}
                  </Text>
                </Button>
              )}

              {/* Mode toggle — replaces the tab bar. */}
              <View className="mt-3 flex-row items-center justify-center gap-1">
                <Text variant="muted">
                  {isSignup ? 'Already have an account?' : 'New to Kortix?'}
                </Text>
                <Button
                  variant="transparent"
                  size="sm"
                  className="px-1"
                  disabled={loading}
                  onPress={toggleMode}>
                  <Text variant="small" className="font-roobert-medium text-foreground">
                    {isSignup ? 'Sign in' : 'Create account'}
                  </Text>
                </Button>
              </View>
            </View>
          )}
        </SheetBody>
      </Sheet>
    </>
  );
}
