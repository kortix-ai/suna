/**
 * Email auth screen — sign in or create an account with email.
 *
 * Pushed from the welcome screen's "Continue with email". Layout follows the
 * Raycast iOS sign-up screen: back button + title, stacked pill fields, one
 * primary button; the account switch and legal links sit at the bottom.
 * Google and Apple live only on the welcome screen.
 *
 * Email methods come from env (lib/auth/auth-config): a one-time code and/or a
 * password. The code step replaces the form in place; back returns to the form.
 */

import * as React from 'react';
import { BackHandler, View, type TextInput } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { ChevronLeft } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { PillInput } from '@/components/kortix/pill-input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { supabase } from '@/api/supabase';
import { useAuthContext } from '@/contexts';
import { magicLinkEnabled, passwordEnabled, type AuthMethod } from '@/lib/auth/auth-config';
import { openLegalPage } from '@/lib/auth/open-legal';
import { log } from '@/lib/logger';
import { THEME, withAlpha } from '@/lib/utils/theme';

/** Supabase email OTP length; the code field submits itself at this length. */
const OTP_LENGTH = 6;
const MIN_PASSWORD_LENGTH = 6;

const friendlySignInError = (msg?: string): string => {
  if (!msg) return 'Could not sign in.';
  if (msg.includes('Invalid login credentials')) return 'Incorrect email or password.';
  if (msg.includes('Email not confirmed')) return 'Confirm your email before signing in.';
  return msg;
};

const friendlyCodeError = (msg?: string): string => {
  if (!msg) return 'Could not send a code.';
  if (/signups? not allowed|not allowed for otp|user not found|no user/i.test(msg)) {
    return 'No account uses this email. Create an account first.';
  }
  return msg;
};

export default function EmailAuthScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme === 'dark' ? 'dark' : 'light'];
  const { signIn, signUp, signInWithMagicLink, resetPassword } = useAuthContext();

  const [mode, setMode] = React.useState<'signin' | 'signup'>('signin');
  const [method, setMethod] = React.useState<AuthMethod>(magicLinkEnabled ? 'magic' : 'password');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);
  const [sentEmail, setSentEmail] = React.useState<string | null>(null);
  const [otpCode, setOtpCode] = React.useState('');
  const [verifying, setVerifying] = React.useState(false);

  const passwordRef = React.useRef<TextInput>(null);
  // Set when the user switches to a password, so the new field takes focus.
  const focusPasswordOnMount = React.useRef(false);

  const isSignup = mode === 'signup';
  // Creating an account always takes a password; signing in may use a code.
  const showPasswordField = isSignup || method === 'password';
  const canSwitchMethod = !isSignup && magicLinkEnabled && passwordEnabled;
  const awaitingCode = !isSignup && method === 'magic' && !!sentEmail;
  const busy = loading || verifying;

  const emailValid = /\S+@\S+\.\S+/.test(email.trim());
  const canSubmit = showPasswordField
    ? emailValid && password.length >= MIN_PASSWORD_LENGTH
    : emailValid;

  const clearMessages = React.useCallback(() => {
    setErrorMessage(null);
    setInfo(null);
  }, []);

  const resetToForm = React.useCallback(() => {
    setSentEmail(null);
    setOtpCode('');
    clearMessages();
  }, [clearMessages]);

  // ── Sign in: send a code, or check the password ───────────────────────────
  const handleSignIn = React.useCallback(async () => {
    const trimmedEmail = email.trim().toLowerCase();
    if (!emailValid) {
      setErrorMessage('Enter a valid email address.');
      return;
    }
    const resending = !!sentEmail;
    setLoading(true);
    clearMessages();
    try {
      if (method === 'magic') {
        const res = await signInWithMagicLink({ email: trimmedEmail });
        if (!res?.success) {
          setErrorMessage(friendlyCodeError(res?.error?.message));
          return;
        }
        setSentEmail(trimmedEmail);
        setOtpCode('');
        if (resending) setInfo('New code sent.');
        return;
      }
      const res = await signIn({ email: trimmedEmail, password });
      if (!res?.success) {
        setErrorMessage(friendlySignInError(res?.error?.message));
        return;
      }
      router.replace('/');
    } catch (err: any) {
      log.error('Email sign-in exception:', err);
      setErrorMessage(err?.message || 'Could not sign in.');
    } finally {
      setLoading(false);
    }
  }, [email, emailValid, sentEmail, method, password, signIn, signInWithMagicLink, clearMessages, router]);

  // ── Create account ────────────────────────────────────────────────────────
  const handleSignUp = React.useCallback(async () => {
    if (!emailValid) {
      setErrorMessage('Enter a valid email address.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`);
      return;
    }
    setLoading(true);
    clearMessages();
    try {
      const res = await signUp({ email: email.trim().toLowerCase(), password });
      if (!res?.success) {
        setErrorMessage(res?.error?.message || 'Could not create your account.');
        return;
      }
      if (res.requiresEmailConfirmation) {
        setInfo('Check your email to confirm your account, then sign in.');
        return;
      }
      router.replace('/');
    } catch (err: any) {
      log.error('Sign-up exception:', err);
      setErrorMessage(err?.message || 'Could not create your account.');
    } finally {
      setLoading(false);
    }
  }, [email, emailValid, password, signUp, clearMessages, router]);

  const submit = isSignup ? handleSignUp : handleSignIn;

  // ── Verify the emailed code ───────────────────────────────────────────────
  // `codeArg` lets the field submit the digits it just received, before the
  // `otpCode` state update has re-rendered this callback.
  const handleVerifyCode = React.useCallback(
    async (codeArg?: string) => {
      const code = (codeArg ?? otpCode).trim();
      if (code.length < OTP_LENGTH) {
        setErrorMessage(`Enter the ${OTP_LENGTH}-digit code from your email.`);
        return;
      }
      setVerifying(true);
      clearMessages();
      try {
        const { data, error } = await supabase.auth.verifyOtp({
          email: (sentEmail ?? email).trim().toLowerCase(),
          token: code,
          type: 'email',
        });
        if (error) {
          setErrorMessage(
            /expired|invalid/i.test(error.message)
              ? 'This code is expired or incorrect. Request a new one.'
              : error.message
          );
          return;
        }
        if (data.session) router.replace('/');
      } catch (err: any) {
        setErrorMessage(err?.message || 'Could not verify the code.');
      } finally {
        setVerifying(false);
      }
    },
    [otpCode, sentEmail, email, clearMessages, router]
  );

  // Digits only; the code submits itself once complete.
  const handleCodeChange = React.useCallback(
    (value: string) => {
      const digits = value.replace(/\D/g, '').slice(0, OTP_LENGTH);
      setOtpCode(digits);
      setErrorMessage(null);
      if (digits.length === OTP_LENGTH && !verifying) void handleVerifyCode(digits);
    },
    [handleVerifyCode, verifying]
  );

  // ── Forgot password ───────────────────────────────────────────────────────
  const handleForgotPassword = React.useCallback(async () => {
    if (!emailValid) {
      setErrorMessage('Enter your email address first.');
      return;
    }
    setLoading(true);
    clearMessages();
    try {
      const res = await resetPassword({ email: email.trim().toLowerCase() });
      if (!res?.success) {
        setErrorMessage(res?.error?.message || 'Could not send the reset email.');
        return;
      }
      setInfo('Check your email for a link to reset your password.');
    } finally {
      setLoading(false);
    }
  }, [email, emailValid, resetPassword, clearMessages]);

  const toggleMode = React.useCallback(() => {
    void Haptics.selectionAsync();
    setMode((m) => (m === 'signin' ? 'signup' : 'signin'));
    resetToForm();
  }, [resetToForm]);

  const toggleMethod = React.useCallback(() => {
    void Haptics.selectionAsync();
    // Never carry a typed password across a method switch.
    setPassword('');
    focusPasswordOnMount.current = method === 'magic';
    setMethod((m) => (m === 'magic' ? 'password' : 'magic'));
    resetToForm();
  }, [method, resetToForm]);

  React.useEffect(() => {
    if (method !== 'password' || !focusPasswordOnMount.current) return;
    focusPasswordOnMount.current = false;
    passwordRef.current?.focus();
  }, [method]);

  // ── Back: the code step returns to the form; the form leaves the screen ──
  const handleBack = React.useCallback(() => {
    if (awaitingCode) {
      resetToForm();
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace('/auth');
  }, [awaitingCode, resetToForm, router]);

  React.useEffect(() => {
    if (!awaitingCode) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      resetToForm();
      return true;
    });
    return () => sub.remove();
  }, [awaitingCode, resetToForm]);

  const title = awaitingCode
    ? 'Check your email'
    : isSignup
      ? 'Create your account'
      : 'Sign in to your account';

  const primaryLabel = isSignup
    ? loading
      ? 'Creating account…'
      : 'Create account'
    : method === 'magic'
      ? loading
        ? 'Sending code…'
        : 'Continue'
      : loading
        ? 'Signing in…'
        : 'Sign in';

  const messageText = errorMessage ? (
    <Text variant="muted" className="mt-3 text-destructive">
      {errorMessage}
    </Text>
  ) : info ? (
    <Text variant="muted" className="mt-3">
      {info}
    </Text>
  ) : null;

  return (
    <>
      {/* During the code step, swipe-back would skip the form; the header
          back button and Android back return to it instead. */}
      <Stack.Screen options={{ headerShown: false, gestureEnabled: !awaitingCode }} />
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />

      <View className="flex-1 bg-background">
        {/* Header — back button + title */}
        <View className="flex-row items-center gap-3 px-5 pb-2" style={{ paddingTop: insets.top + 8 }}>
          <Button
            variant="outline"
            size="icon"
            className="rounded-full"
            accessibilityLabel={awaitingCode ? 'Back to email' : 'Back'}
            onPress={handleBack}>
            <Icon as={ChevronLeft} size={20} />
          </Button>
          <Text variant="large" className="flex-1" numberOfLines={1}>
            {title}
          </Text>
        </View>

        <KeyboardAwareScrollView
          bottomOffset={24}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            // flexGrow lets the spacer below pin the account switch + legal
            // line to the bottom of the screen when the form is short.
            flexGrow: 1,
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: insets.bottom + 16,
          }}>
          {awaitingCode ? (
            /* ── Code step ── */
            <View>
              <Text variant="muted">Enter the code we sent to</Text>
              <Text variant="small" className="mt-1.5">
                {sentEmail}
              </Text>

              <PillInput
                value={otpCode}
                onChangeText={handleCodeChange}
                placeholder="Code"
                accessibilityLabel="Verification code"
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={OTP_LENGTH}
                editable={!verifying}
                autoFocus
                style={{ marginTop: 20, fontVariant: ['tabular-nums'] }}
              />

              {messageText}

              <Button
                size="lg"
                variant={verifying ? 'secondary' : 'default'}
                className="mt-3 rounded-full"
                disabled={verifying || otpCode.length < OTP_LENGTH}
                onPress={() => void handleVerifyCode()}>
                <Text>{verifying ? 'Verifying…' : 'Verify'}</Text>
              </Button>

              <View className="mt-2 flex-row items-center justify-center">
                <Button variant="ghost" size="sm" disabled={busy} onPress={() => void handleSignIn()}>
                  <Text>Resend code</Text>
                </Button>
                <Button variant="ghost" size="sm" disabled={verifying} onPress={resetToForm}>
                  <Text>Change email</Text>
                </Button>
              </View>
            </View>
          ) : (
            /* ── Sign in / Create account ── */
            <View>
              <View className="gap-3">
                <PillInput
                  value={email}
                  onChangeText={(value) => {
                    setEmail(value);
                    clearMessages();
                  }}
                  placeholder="Email address"
                  accessibilityLabel="Email address"
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  returnKeyType={showPasswordField ? 'next' : 'go'}
                  submitBehavior={showPasswordField ? 'submit' : 'blurAndSubmit'}
                  onSubmitEditing={() => {
                    if (showPasswordField) passwordRef.current?.focus();
                    else void submit();
                  }}
                />

                {showPasswordField && (
                  <PillInput
                    ref={passwordRef}
                    value={password}
                    onChangeText={(value) => {
                      setPassword(value);
                      clearMessages();
                    }}
                    placeholder={
                      isSignup ? `Password (${MIN_PASSWORD_LENGTH}+ characters)` : 'Password'
                    }
                    accessibilityLabel="Password"
                    secureTextEntry
                    textContentType={isSignup ? 'newPassword' : 'password'}
                    autoComplete={isSignup ? 'new-password' : 'password'}
                    editable={!busy}
                    returnKeyType="go"
                    onSubmitEditing={() => void submit()}
                  />
                )}
              </View>

              {messageText}

              <Button
                size="lg"
                variant={loading ? 'secondary' : 'default'}
                className="mt-3 rounded-full"
                disabled={busy || !canSubmit}
                onPress={() => void submit()}>
                <Text>{primaryLabel}</Text>
              </Button>

              {!isSignup && method === 'password' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 self-center"
                  disabled={busy}
                  onPress={handleForgotPassword}>
                  <Text>Forgot password?</Text>
                </Button>
              )}

            </View>
          )}

          {/* Pinned to the bottom: the account switch, the sign-in method
              switch, then legal links. */}
          <View className="flex-1" />
          <View className="pt-8">
            {!awaitingCode && (
              <Button size="lg" className="rounded-full" disabled={busy} onPress={toggleMode}>
                <Text>{isSignup ? 'Sign in' : 'Create account'}</Text>
              </Button>
            )}
            {/* Also shown on the code step: switching to a password leaves the
                code step for the form, keeps the email, and focuses the
                password field. */}
            {canSwitchMethod && (
              <Button
                size="lg"
                variant="secondary"
                className={awaitingCode ? 'rounded-full' : 'mt-3 rounded-full'}
                disabled={busy}
                onPress={toggleMethod}>
                <Text>{method === 'magic' ? 'Use password' : 'Use email code'}</Text>
              </Button>
            )}
            {/* Same two links, labels, and style as the welcome screen. */}
            <View className="mt-2 flex-row items-center justify-center">
              <Button variant="link" size="sm" onPress={() => void openLegalPage('privacy')}>
                <Text style={{ color: withAlpha(colors.foreground, 0.5) }}>Privacy policy</Text>
              </Button>
              <Button variant="link" size="sm" onPress={() => void openLegalPage('terms')}>
                <Text style={{ color: withAlpha(colors.foreground, 0.5) }}>Terms of service</Text>
              </Button>
            </View>
          </View>
        </KeyboardAwareScrollView>
      </View>
    </>
  );
}
