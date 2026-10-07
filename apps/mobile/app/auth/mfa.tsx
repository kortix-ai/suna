/**
 * TOTP step-up: a session with a verified TOTP factor enters the code from the
 * authenticator app before it reaches the app (lib/auth/mfa). The routing
 * gates (`AuthProtection`, the auth layout, the start screen) send it here and
 * on to `/` once auth-js reports the aal2 session.
 *
 * The email screen's layout with web's six code cells (components/kortix/
 * code-cells). No back button: the only way out is Sign out, which signs this
 * device out.
 */

import * as React from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useTranslation } from 'react-i18next';

import { CODE_LENGTH, CodeCells } from '@/components/kortix/code-cells';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts';

export default function MfaScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const { t } = useTranslation();
  const { verifyTotp, signOut } = useAuthContext();

  const [code, setCode] = React.useState('');
  const [verifying, setVerifying] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  // `codeArg` lets the field submit the digits it just received, before the
  // `code` state update has re-rendered this callback.
  const handleVerify = React.useCallback(
    async (codeArg?: string) => {
      const value = codeArg ?? code;
      if (value.length < CODE_LENGTH) return;
      setVerifying(true);
      setErrorMessage(null);
      const error = await verifyTotp(value);
      setVerifying(false);
      // Success: the routing gates leave this screen.
      if (error) {
        setErrorMessage(
          error.code === 'mfa_verification_failed'
            ? t('auth.mfa.invalidCode')
            : t('auth.mfa.verifyFailed')
        );
      }
    },
    [code, verifyTotp, t]
  );

  // The code submits itself once complete.
  const handleCodeChange = React.useCallback(
    (digits: string) => {
      setCode(digits);
      setErrorMessage(null);
      if (digits.length === CODE_LENGTH && !verifying) void handleVerify(digits);
    },
    [handleVerify, verifying]
  );

  const handleSignOut = React.useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    const result = await signOut().catch(() => null);
    setSigningOut(false);
    if (result?.success) router.replace('/auth');
  }, [router, signOut, signingOut]);

  const busy = verifying || signingOut;

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />

      <View className="flex-1 bg-background">
        {/* The email screen's header row, without the back button. */}
        <View
          className="min-h-10 flex-row items-center px-5 pb-2"
          style={{ paddingTop: insets.top + 8 }}>
          <Text variant="large" className="flex-1" numberOfLines={1}>
            {t('auth.mfa.title')}
          </Text>
        </View>

        <KeyboardAwareScrollView
          bottomOffset={24}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: insets.bottom + 16,
          }}>
          <Text variant="muted">{t('auth.mfa.enterCode')}</Text>

          <View className="mt-5">
            <CodeCells
              value={code}
              onChangeText={handleCodeChange}
              invalid={!!errorMessage}
              editable={!busy}
              accessibilityLabel={t('auth.mfa.codeLabel')}
            />
          </View>

          {errorMessage ? (
            <Text variant="muted" className="mt-3 text-destructive">
              {errorMessage}
            </Text>
          ) : null}

          {/* The actions sit at the bottom, as the email screen's account switch. */}
          <View className="flex-1" />
          <View className="gap-3 pt-8">
            <Button
              size="lg"
              variant={verifying ? 'secondary' : 'default'}
              className="rounded-full"
              disabled={busy || code.length < CODE_LENGTH}
              onPress={() => void handleVerify()}>
              <Text>{verifying ? t('auth.mfa.verifying') : t('auth.mfa.verify')}</Text>
            </Button>
            <Button
              size="lg"
              variant="secondary"
              className="rounded-full"
              disabled={busy}
              onPress={() => void handleSignOut()}>
              <Text>{t('auth.signOut')}</Text>
            </Button>
          </View>
        </KeyboardAwareScrollView>
      </View>
    </>
  );
}
