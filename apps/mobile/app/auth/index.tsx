/**
 * Auth Screen — adaptive login based on environment mode.
 *
 * - Local mode: Email + password (self-hosted sandbox)
 * - Cloud/Production/Staging: Magic link (OTP) + Google OAuth (like web)
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
import type { TextInput as TextInputType } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts';
import { log } from '@/lib/logger';
import { supabase } from '@/api/supabase';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { AuthButton } from '@/components/auth/AuthButton';
import { AuthInput } from '@/components/auth/AuthInput';
import { isLocal } from '@/lib/utils/env-config';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as AppleAuthentication from 'expo-apple-authentication';

export default function AuthScreen() {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuthContext();

  // Redirect if already authenticated
  React.useEffect(() => {
    if (isAuthenticated) {
      router.replace('/home');
    }
  }, [isAuthenticated, router]);

  if (isLocal) {
    return <LocalAuthScreen />;
  }

  return <CloudAuthScreen />;
}

// ─── Local Auth: Email + Password ────────────────────────────────────────────

function LocalAuthScreen() {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const passwordRef = React.useRef<TextInput>(null);

  const handleSignIn = React.useCallback(async () => {
    const trimmedEmail = email.trim();
    const trimmedPassword = password.trim();
    if (!trimmedEmail || !trimmedPassword) {
      setErrorMessage('Please enter both email and password.');
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password: trimmedPassword,
      });
      if (error) {
        log.warn('Sign in failed:', error.message);
        if (error.message.includes('Invalid login credentials')) {
          setErrorMessage('Invalid email or password. Please try again.');
        } else if (error.message.includes('Email not confirmed')) {
          setErrorMessage('Email not confirmed. Check your Supabase settings.');
        } else {
          setErrorMessage(error.message);
        }
        setLoading(false);
        return;
      }
      if (data.session) {
        log.log('Signed in successfully');
        router.replace('/home');
      }
    } catch (err: any) {
      log.error('Auth exception:', err);
      setErrorMessage(err.message || 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }, [email, password, router]);

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
          <View className="items-start mb-10">
            <KortixLogo variant="symbol" size={36} color={isDark ? 'dark' : 'light'} />
            <Text className="text-[28px] font-roobert-semibold text-foreground mt-5 leading-tight">
              Sign in to{'\n'}Kortix
            </Text>
            <Text className="text-[15px] text-muted-foreground mt-2 font-roobert">
              Your AI Computer
            </Text>
          </View>

          <View className="w-full">
            {errorMessage && (
              <View className="mb-4 rounded-2xl bg-destructive/10 px-4 py-3">
                <Text className="text-sm text-destructive text-center font-roobert">{errorMessage}</Text>
              </View>
            )}
            <View className="mb-3">
              <AuthInput
                value={email}
                onChangeText={setEmail}
                placeholder="Email address"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
              />
            </View>
            <View className="mb-5">
              <AuthInput
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                secureTextEntry
                autoComplete="password"
                returnKeyType="go"
                onSubmitEditing={handleSignIn}
              />
            </View>
            <AuthButton label="Sign in" loadingLabel="Signing in..." onPress={handleSignIn} isLoading={loading} variant="primary" showArrow={false} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

// ─── Cloud Auth: Magic Link + Google OAuth ───────────────────────────────────

type CloudPhase = 'email' | 'otp-sent';

function CloudAuthScreen() {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = React.useState<CloudPhase>('email');
  const [email, setEmail] = React.useState('');
  const [otpCode, setOtpCode] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [oauthLoading, setOauthLoading] = React.useState<'google' | 'apple' | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const otpRef = React.useRef<TextInput>(null);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';

  // Send magic link / OTP
  const handleSendOtp = React.useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setErrorMessage('Please enter your email address.');
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          shouldCreateUser: true,
        },
      });
      if (error) {
        log.warn('OTP send failed:', error.message);
        setErrorMessage(error.message);
        setLoading(false);
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPhase('otp-sent');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to send verification code');
    } finally {
      setLoading(false);
    }
  }, [email]);

  // Verify OTP code
  const handleVerifyOtp = React.useCallback(async () => {
    const trimmed = otpCode.trim();
    if (!trimmed || trimmed.length < 6) {
      setErrorMessage('Please enter the 6-digit code from your email.');
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: trimmed,
        type: 'email',
      });
      if (error) {
        log.warn('OTP verify failed:', error.message);
        if (error.message.includes('expired') || error.message.includes('invalid')) {
          setErrorMessage('Code expired or invalid. Please request a new one.');
        } else {
          setErrorMessage(error.message);
        }
        setLoading(false);
        return;
      }
      if (data.session) {
        log.log('Signed in via OTP');
        router.replace('/home');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  }, [email, otpCode, router]);

  // Resend code
  const handleResend = React.useCallback(async () => {
    setOtpCode('');
    setErrorMessage(null);
    setPhase('email');
  }, []);

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
          {/* Logo */}
          <View className="items-start mb-10">
            <KortixLogo variant="symbol" size={36} color={isDark ? 'dark' : 'light'} />
            <Text className="text-[28px] font-roobert-semibold text-foreground mt-5 leading-tight">
              {phase === 'email' ? 'Sign in to\nKortix' : 'Check your\nemail'}
            </Text>
            <Text className="text-[15px] text-muted-foreground mt-2 font-roobert">
              {phase === 'email'
                ? 'Your AI Computer'
                : `We sent a code to ${email.trim()}`}
            </Text>
          </View>

          <View className="w-full">
            {errorMessage && (
              <View className="mb-4 rounded-2xl bg-destructive/10 px-4 py-3">
                <Text className="text-sm text-destructive text-center font-roobert">{errorMessage}</Text>
              </View>
            )}

            {phase === 'email' ? (
              <>
                {/* Email input */}
                <View className="mb-5">
                  <AuthInput
                    value={email}
                    onChangeText={setEmail}
                    placeholder="Email address"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoComplete="email"
                    returnKeyType="go"
                    onSubmitEditing={handleSendOtp}
                  />
                </View>

                {/* Continue button */}
                <AuthButton
                  label="Continue with email"
                  loadingLabel="Sending code..."
                  onPress={handleSendOtp}
                  isLoading={loading}
                  variant="primary"
                  showArrow={false}
                />

                {/* Divider */}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 20 }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: border }} />
                  <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginHorizontal: 12 }}>or</Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: border }} />
                </View>

                {/* Google Sign In */}
                <TouchableOpacity
                  onPress={async () => {
                    try {
                      setOauthLoading('google');
                      setErrorMessage(null);
                      const { data, error } = await supabase.auth.signInWithOAuth({
                        provider: 'google',
                        options: {
                          redirectTo: 'kortix://auth/callback',
                          skipBrowserRedirect: true,
                        },
                      });
                      if (error) throw error;
                      if (data.url) {
                        await Linking.openURL(data.url);
                      }
                    } catch (err: any) {
                      setErrorMessage(err.message || 'Google sign-in failed');
                    } finally {
                      setOauthLoading(null);
                    }
                  }}
                  disabled={!!oauthLoading}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    height: 52,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: border,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
                    opacity: oauthLoading && oauthLoading !== 'google' ? 0.5 : 1,
                  }}
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

                {/* Apple Sign In (iOS only) */}
                {Platform.OS === 'ios' && (
                  <TouchableOpacity
                    onPress={async () => {
                      try {
                        setOauthLoading('apple');
                        setErrorMessage(null);
                        const credential = await AppleAuthentication.signInAsync({
                          requestedScopes: [
                            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                            AppleAuthentication.AppleAuthenticationScope.EMAIL,
                          ],
                        });
                        if (!credential.identityToken) throw new Error('No identity token');
                        const { data, error } = await supabase.auth.signInWithIdToken({
                          provider: 'apple',
                          token: credential.identityToken,
                        });
                        if (error) throw error;
                        if (data.session) {
                          router.replace('/home');
                        }
                      } catch (err: any) {
                        if (err.code === 'ERR_REQUEST_CANCELED') {
                          setOauthLoading(null);
                          return;
                        }
                        setErrorMessage(err.message || 'Apple sign-in failed');
                      } finally {
                        setOauthLoading(null);
                      }
                    }}
                    disabled={!!oauthLoading}
                    activeOpacity={0.7}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 10,
                      height: 52,
                      borderRadius: 14,
                      borderWidth: 1,
                      borderColor: border,
                      backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
                      marginTop: 10,
                      opacity: oauthLoading && oauthLoading !== 'apple' ? 0.5 : 1,
                    }}
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
            ) : (
              <>
                {/* OTP code input */}
                <View className="mb-5">
                  <AuthInput
                    value={otpCode}
                    onChangeText={setOtpCode}
                    placeholder="Enter 6-digit code"
                    keyboardType="numeric"
                    autoCapitalize="none"
                    autoComplete="one-time-code"
                    returnKeyType="go"
                    onSubmitEditing={handleVerifyOtp}
                  />
                </View>

                {/* Verify button */}
                <AuthButton
                  label="Verify code"
                  loadingLabel="Verifying..."
                  onPress={handleVerifyOtp}
                  isLoading={loading}
                  variant="primary"
                  showArrow={false}
                />

                {/* Resend / change email */}
                <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: 16, gap: 16 }}>
                  <TouchableOpacity onPress={handleResend}>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: isDark ? '#60a5fa' : '#2563eb' }}>
                      Resend code
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setPhase('email'); setOtpCode(''); setErrorMessage(null); }}>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>
                      Change email
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
