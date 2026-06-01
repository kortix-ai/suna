/**
 * Auth Screen — login only.
 *
 * Mobile supports sign-in only; new accounts are created on the web. The email
 * auth method (magic link or password) and social providers render based on env
 * (see lib/auth/auth-config), never hardcoded:
 *   EXPO_PUBLIC_AUTH_METHODS    "magic" / "password"
 *   EXPO_PUBLIC_AUTH_PROVIDERS  "google" / "apple"
 */

import * as React from 'react';
import {
  View,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { Text } from '@/components/ui/text';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { AuthButton } from '@/components/auth/AuthButton';
import { AuthInput } from '@/components/auth/AuthInput';
import { useAuthContext } from '@/contexts';
import { supabase } from '@/api/supabase';
import { getFrontendUrl } from '@/api/config';
import { log } from '@/lib/logger';
import {
  magicLinkEnabled,
  passwordEnabled,
  googleEnabled,
  appleEnabled,
  type AuthMethod,
} from '@/lib/auth/auth-config';

const friendlySignInError = (msg?: string): string => {
  if (!msg) return 'Could not sign in';
  if (msg.includes('Invalid login credentials')) return 'Invalid email or password. Please try again.';
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

export default function AuthScreen() {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { isAuthenticated, signIn, signInWithMagicLink, signInWithOAuth, resetPassword } =
    useAuthContext();

  const [method, setMethod] = React.useState<AuthMethod>(magicLinkEnabled ? 'magic' : 'password');

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');

  const [loading, setLoading] = React.useState(false);
  const [oauthLoading, setOauthLoading] = React.useState<'google' | 'apple' | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);

  // Magic-link OTP follow-up
  const [sentEmail, setSentEmail] = React.useState<string | null>(null);
  const [otpCode, setOtpCode] = React.useState('');
  const [verifying, setVerifying] = React.useState(false);

  const passwordRef = React.useRef<TextInput>(null);

  const awaitingCode = method === 'magic' && !!sentEmail;
  const showProviders = googleEnabled || (appleEnabled && Platform.OS === 'ios');

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';

  // Already-signed-in users never see auth.
  React.useEffect(() => {
    if (isAuthenticated) router.replace('/projects');
  }, [isAuthenticated, router]);

  const resetTransient = React.useCallback(() => {
    setErrorMessage(null);
    setInfo(null);
    setSentEmail(null);
    setOtpCode('');
  }, []);

  const openWebRegister = React.useCallback(() => {
    const base = getFrontendUrl().replace(/\/$/, '');
    Linking.openURL(`${base}/auth`).catch(() => {});
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
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
            : error.message,
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
        if (res?.success) {
          router.replace('/projects');
        } else if (res?.error?.message && !/cancel/i.test(res.error.message)) {
          setErrorMessage(res.error.message);
        }
      } catch (err: any) {
        setErrorMessage(err?.message || `${provider} sign-in failed.`);
      } finally {
        setOauthLoading(null);
      }
    },
    [signInWithOAuth, router],
  );

  const submitLabel = method === 'magic' ? 'Email me a sign-in code' : 'Sign in';
  const submitLoadingLabel = method === 'magic' ? 'Sending code...' : 'Signing in...';

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <KeyboardAvoidingView
        className="flex-1 bg-background"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View
          className="flex-1 justify-center px-8"
          style={{ paddingTop: insets.top, paddingBottom: insets.bottom + 32 }}
        >
          {/* Logo + heading */}
          <View className="items-start mb-8">
            <KortixLogo variant="symbol" size={36} color={isDark ? 'dark' : 'light'} />
            <Text className="text-[28px] font-roobert-semibold text-foreground mt-5 leading-tight">
              {awaitingCode ? 'Check your\nemail' : 'Sign in to\nKortix'}
            </Text>
            <Text className="text-[15px] text-muted-foreground mt-2 font-roobert">
              {awaitingCode ? `We sent a code to ${(sentEmail ?? email).trim()}` : 'Your AI Computer'}
            </Text>
          </View>

          {/* Banners */}
          {errorMessage && (
            <View className="mb-4 rounded-2xl bg-destructive/10 px-4 py-3">
              <Text className="text-sm text-destructive text-center font-roobert">{errorMessage}</Text>
            </View>
          )}
          {info && !errorMessage && (
            <View
              className="mb-4 rounded-2xl px-4 py-3"
              style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
            >
              <Text className="text-sm text-center font-roobert" style={{ color: muted }}>
                {info}
              </Text>
            </View>
          )}

          {awaitingCode ? (
            /* ── OTP code phase ── */
            <View className="w-full">
              <View className="mb-5">
                <AuthInput
                  value={otpCode}
                  onChangeText={setOtpCode}
                  placeholder="Enter 6-digit code"
                  keyboardType="numeric"
                  autoComplete="one-time-code"
                  returnKeyType="go"
                  onSubmitEditing={handleVerifyOtp}
                />
              </View>
              <AuthButton
                label="Verify code"
                loadingLabel="Verifying..."
                onPress={handleVerifyOtp}
                isLoading={verifying}
                variant="primary"
                showArrow={false}
              />
              <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: 16, gap: 16 }}>
                <TouchableOpacity onPress={handleSubmit} disabled={loading}>
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>
                    Resend code
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={resetTransient}>
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>
                    Use a different email
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            /* ── Email + (password) form ── */
            <View className="w-full">
              <View className="mb-3">
                <AuthInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Email address"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  returnKeyType={method === 'password' ? 'next' : 'go'}
                  onSubmitEditing={() =>
                    method === 'password' ? passwordRef.current?.focus() : handleSubmit()
                  }
                />
              </View>

              {method === 'password' && (
                <View className="mb-3">
                  <AuthInput
                    value={password}
                    onChangeText={setPassword}
                    placeholder="Password"
                    secureTextEntry
                    autoComplete="password"
                    returnKeyType="go"
                    onSubmitEditing={handleSubmit}
                  />
                </View>
              )}

              <View className="mt-2">
                <AuthButton
                  label={submitLabel}
                  loadingLabel={submitLoadingLabel}
                  onPress={handleSubmit}
                  isLoading={loading}
                  variant="primary"
                  showArrow={false}
                />
              </View>

              {/* Method toggle (only when both email methods enabled) */}
              {magicLinkEnabled && passwordEnabled && (
                <TouchableOpacity
                  onPress={() => {
                    setMethod(method === 'magic' ? 'password' : 'magic');
                    resetTransient();
                  }}
                  style={{ marginTop: 16, alignSelf: 'center' }}
                >
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>
                    {method === 'magic' ? 'Use password instead' : 'Use email code instead'}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Forgot password (password method only) */}
              {method === 'password' && (
                <TouchableOpacity onPress={handleForgotPassword} style={{ marginTop: 12, alignSelf: 'center' }}>
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>
                    Forgot your password?
                  </Text>
                </TouchableOpacity>
              )}

              {/* Social providers */}
              {showProviders && (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 20 }}>
                    <View style={{ flex: 1, height: 1, backgroundColor: border }} />
                    <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginHorizontal: 12 }}>
                      or
                    </Text>
                    <View style={{ flex: 1, height: 1, backgroundColor: border }} />
                  </View>

                  {googleEnabled && (
                    <TouchableOpacity
                      onPress={() => handleOAuth('google')}
                      disabled={!!oauthLoading}
                      activeOpacity={0.7}
                      style={providerButtonStyle(isDark, border, oauthLoading, 'google')}
                    >
                      {oauthLoading === 'google' ? (
                        <ActivityIndicator size="small" color={fg} style={{ marginRight: 2 }} />
                      ) : (
                        <Ionicons name="logo-google" size={18} color={fg} />
                      )}
                      <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>
                        {oauthLoading === 'google' ? 'Opening Google...' : 'Continue with Google'}
                      </Text>
                    </TouchableOpacity>
                  )}

                  {appleEnabled && Platform.OS === 'ios' && (
                    <TouchableOpacity
                      onPress={() => handleOAuth('apple')}
                      disabled={!!oauthLoading}
                      activeOpacity={0.7}
                      style={{ ...providerButtonStyle(isDark, border, oauthLoading, 'apple'), marginTop: 10 }}
                    >
                      {oauthLoading === 'apple' ? (
                        <ActivityIndicator size="small" color={fg} style={{ marginRight: 2 }} />
                      ) : (
                        <Ionicons name="logo-apple" size={20} color={fg} />
                      )}
                      <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>
                        {oauthLoading === 'apple' ? 'Signing in...' : 'Continue with Apple'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </>
              )}

              {/* Register lives on the web */}
              <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: 24, gap: 5 }}>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>New to Kortix?</Text>
                <TouchableOpacity onPress={openWebRegister}>
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>
                    Register on the web
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

function providerButtonStyle(
  isDark: boolean,
  border: string,
  oauthLoading: 'google' | 'apple' | null,
  self: 'google' | 'apple',
) {
  return {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 10,
    height: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: border,
    backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
    opacity: oauthLoading && oauthLoading !== self ? 0.5 : 1,
  };
}
