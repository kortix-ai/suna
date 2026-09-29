/**
 * Auth welcome screen — hero, brand, and the ways to sign in.
 *
 * Google and Apple sign in from here. "Continue with email" pushes the email
 * form (app/auth/email.tsx). The build shows Google + Apple (iOS); a private
 * deployment shows only the providers its web auth page shows, plus "Continue
 * with SSO" when its Supabase has SAML on (lib/auth/auth-config).
 *
 * The server row at the bottom opens the private-deployment sheet
 * (components/auth/DeploymentSheet): the host this screen signs in to.
 *
 * Layout: full-bleed hero on top, brand + provider pills below. Follows the
 * resolved color scheme (NativeWind), the same source the Button fills use.
 */

import * as React from 'react';
import { View, Platform, useWindowDimensions } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from 'expo-router/react-navigation';

import { KortixCurrents } from '@/components/animations/kortix-currents';
import { DeploymentSheet } from '@/components/auth/DeploymentSheet';
import { AppleIcon, GoogleIcon } from '@/components/icons/auth-icons';
import { KortixLogo } from '@/components/kortix/KortixLogo';
import { PlatformFullWidthButton } from '@/components/kortix/platform-button';
import type { SheetRef } from '@/components/kortix/sheet';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts';
import { useOAuthSignIn } from '@/hooks/useOAuthSignIn';
import { appleEnabled, googleEnabled } from '@/lib/auth/auth-config';
import { fetchSsoEnabled } from '@/lib/deployment/deployment';
import { activeDeployment } from '@/lib/deployment/store';
import { BuildingsIcon } from '@/lib/icons';
import { THEME, withAlpha } from '@/lib/utils/theme';

export default function AuthScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const heroH = Math.round(screenHeight * 0.8);
  // NativeWind's resolved scheme drives the CSS variables behind every
  // Button fill, so the screen's own colors read from the same source.
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const colors = THEME[scheme];
  // Glyph + spinner color on a `default` Button fill (CLAUDE.md Color rule 6).
  const onPrimary = colors.primaryForeground;
  const { isAuthenticated } = useAuthContext();
  const { pending: oauthPending, error: oauthError, signInWith } = useOAuthSignIn();
  // The auth stack keeps this screen mounted under the email screen; the hero
  // animation stops while it is covered.
  const isFocused = useIsFocused();
  const deploymentSheetRef = React.useRef<SheetRef>(null);
  // SSO is a private-deployment option, shown when its Supabase has SAML on
  // (the web auth page's own check). The cloud build is unchanged.
  const [ssoEnabled, setSsoEnabled] = React.useState(false);
  React.useEffect(() => {
    if (!activeDeployment) return;
    let active = true;
    void fetchSsoEnabled(activeDeployment, (url, init) => fetch(url, init)).then((enabled) => {
      if (active) setSsoEnabled(enabled);
    });
    return () => {
      active = false;
    };
  }, []);

  // Already-signed-in users never see auth.
  React.useEffect(() => {
    if (isAuthenticated) router.replace('/');
  }, [isAuthenticated, router]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {/* Hero — the Kortix mark forming out of a flow field (top half) */}
        <View style={{ height: heroH, width: '100%' }}>
          {/* The hero runs 80% of the screen, so a centred mark lands near the
              middle. Bias it up into the field's clear upper half. */}
          <KortixCurrents markCenterY={0.4} tone={scheme} paused={!isFocused} />
          {/* Fade the field into the base. Fade to the same color at zero
              alpha, not 'transparent' (black at zero alpha), or the light
              gradient passes through gray. */}
          <LinearGradient
            colors={[
              withAlpha(colors.background, 0),
              withAlpha(colors.background, 0.35),
              withAlpha(colors.background, 0.85),
              colors.background,
            ]}
            locations={[0, 0.35, 0.78, 1]}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: heroH * 0.5 }}
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
          {/* Brand + actions */}
          <View style={{ width: '100%' }}>
            {/* The symbol is already forming in the field above, so this is the
                logomark — never the symbol a second time. */}
            <View style={{ alignItems: 'center', marginBottom: 28 }}>
              {/* `color` names the background it sits on: dark → white wordmark. */}
              <KortixLogo variant="text" size={28} color={scheme} />
            </View>

            {oauthError ? (
              <View
                className="mb-3 w-full rounded-2xl px-4 py-3"
                style={{ backgroundColor: withAlpha(colors.destructive, 0.16) }}>
                <Text variant="small" className="text-center text-destructive">
                  {oauthError}
                </Text>
              </View>
            ) : null}

            {/* Two filled provider pills, then email — equal size, so Apple is
                as prominent as Google (App Store guideline 4.8). On iOS they
                are native SwiftUI buttons (`PlatformFullWidthButton`) in the
                same variants; elsewhere the design-system `Button`. Height
                and label come from `size="xl"` (48pt, one step above the 44pt
                `lg` pills elsewhere). Provider icons sit on the pill's left
                edge, so every label shares one center line. */}
            <View style={{ gap: 12 }}>
              {/* Google — both platforms */}
              {googleEnabled && (
                <PlatformFullWidthButton
                  size="xl"
                  label={oauthPending === 'google' ? 'Opening Google…' : 'Continue with Google'}
                  // Pending is an inline disabled state: the label says it,
                  // the icon stays (KRTX-244).
                  leading={<GoogleIcon size={18} />}
                  disabled={!!oauthPending}
                  onPress={() => void signInWith('google')}
                />
              )}

              {/* Apple — iOS only */}
              {appleEnabled && Platform.OS === 'ios' && (
                <PlatformFullWidthButton
                  size="xl"
                  label={oauthPending === 'apple' ? 'Opening Apple…' : 'Continue with Apple'}
                  leading={<AppleIcon size={18} color={onPrimary} />}
                  disabled={!!oauthPending}
                  onPress={() => void signInWith('apple')}
                />
              )}

              {/* Email — both platforms. Opens the email screen. */}
              <PlatformFullWidthButton
                size="xl"
                variant="outline"
                label="Continue with email"
                disabled={!!oauthPending}
                onPress={() => router.push('/auth/email')}
              />

              {/* SSO — self-hosted instances with SAML on. Email → IdP. */}
              {ssoEnabled && (
                <PlatformFullWidthButton
                  size="xl"
                  variant="outline"
                  label="Continue with SSO"
                  leading={<Icon as={BuildingsIcon} size={18} className="text-foreground" />}
                  disabled={!!oauthPending}
                  onPress={() => router.push('/auth/email?method=sso')}
                />
              )}

              {/* Self-hosted — the email pill's shape. Opens the
                  deployment sheet; names the host once one is chosen. */}
              <PlatformFullWidthButton
                size="xl"
                variant="outline"
                label={activeDeployment ? new URL(activeDeployment.origin).host : 'Self-hosted'}
                disabled={!!oauthPending}
                onPress={() => deploymentSheetRef.current?.open()}
              />
            </View>
          </View>
        </View>
      </View>
      <DeploymentSheet ref={deploymentSheetRef} />
    </>
  );
}
