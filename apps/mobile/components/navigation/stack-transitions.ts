/**
 * One push/pop transition for every stack in the app (root, `(settings)`,
 * `auth`).
 *
 * iOS: expo-router's native Stack — the UINavigationController push.
 *
 * Android: expo-router's JS stack with a layered, iOS-style card. No native
 * Android stack animation (react-native-screens 4.26) is spatially
 * consistent, and native animation XML cannot be tuned from JS or loaded by
 * Expo Go:
 * - `default` (Android 13+): back fades the leaving page out in 83ms, so the
 *   previous page is what you see move — in from the left — instead of the
 *   current page leaving to the right the way it came in.
 * - `ios_from_right`: right geometry, but a symmetric 200ms curve with no
 *   dim and no edge, so the two same-coloured pages smear together.
 * - `slide_from_right`: 400ms, and both pages travel the full width.
 *
 * The card, driven by one progress value in both directions, so back is the
 * exact mirror of push:
 * - push: the new page slides in from the right edge over the current one;
 *   the current page shifts 30% left and dims under it.
 * - back: the page leaves to the right; the previous one returns from -30%
 *   and brightens.
 * - a soft shadow on the moving page's leading edge keeps the layers
 *   readable in both themes (it sits off-screen once a page is at rest).
 * Timing: 320ms open, 260ms close (exit ≈ 80% of enter) on the iOS sheet
 * curve cubic-bezier(0.32, 0.72, 0, 1) — fast start, long soft settle.
 * Reduced motion replaces the slide with a 150ms crossfade.
 *
 * Swipe-back stays off on Android: the system back gesture owns that edge.
 */

import * as React from 'react';
import { Animated, Easing, Platform } from 'react-native';
import { Stack as NativeStack } from 'expo-router';
import JsStack from 'expo-router/js-stack';
import type {
  StackCardInterpolatedStyle,
  StackCardInterpolationProps,
  StackNavigationOptions,
} from 'expo-router/build/react-navigation/stack';
import { useReducedMotion } from 'react-native-reanimated';

import { THEME, withAlpha } from '@/lib/utils/theme';

/** True when stacks render the JS card stack (Android). */
export const usesJsStack = Platform.OS === 'android';

/**
 * The stack navigator for every layout. Typed as the native Stack so each
 * layout keeps one list of `AppStack.Screen` elements. On Android the JS
 * stack reads the shared keys (`headerShown`, `header`, `gestureEnabled`,
 * `presentation`) and ignores native-only ones (`fullScreenGestureEnabled`,
 * `contentStyle`).
 */
export const AppStack = (usesJsStack ? JsStack : NativeStack) as unknown as typeof NativeStack;

const SHEET_CURVE = Easing.bezier(0.32, 0.72, 0, 1);
const PARALLAX = -0.3;
const DIM = 0.1;
const EDGE_SHADOW = `-8px 0px 24px ${withAlpha(THEME.light.foreground, 0.16)}`;

type TransitionSpec = NonNullable<StackNavigationOptions['transitionSpec']>['open'];

const OPEN: TransitionSpec = { animation: 'timing', config: { duration: 320, easing: SHEET_CURVE } };
const CLOSE: TransitionSpec = { animation: 'timing', config: { duration: 260, easing: SHEET_CURVE } };
const FADE: TransitionSpec = { animation: 'timing', config: { duration: 150, easing: Easing.out(Easing.quad) } };

function forLayeredPush({
  current,
  next,
  inverted,
  layouts: { screen },
}: StackCardInterpolationProps): StackCardInterpolatedStyle {
  const translateFocused = Animated.multiply(
    current.progress.interpolate({
      inputRange: [0, 1],
      outputRange: [screen.width, 0],
      extrapolate: 'clamp',
    }),
    inverted
  );
  const translateUnfocused = next
    ? Animated.multiply(
        next.progress.interpolate({
          inputRange: [0, 1],
          outputRange: [0, screen.width * PARALLAX],
          extrapolate: 'clamp',
        }),
        inverted
      )
    : 0;

  return {
    cardStyle: {
      transform: [{ translateX: translateFocused }, { translateX: translateUnfocused }],
      boxShadow: EDGE_SHADOW,
    },
    // The overlay sits between this page and the one under it.
    overlayStyle: {
      opacity: current.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, DIM],
        extrapolate: 'clamp',
      }),
    },
  };
}

function forCrossfade({ current }: StackCardInterpolationProps): StackCardInterpolatedStyle {
  return { cardStyle: { opacity: current.progress } };
}

const JS_PUSH: StackNavigationOptions = {
  cardStyleInterpolator: forLayeredPush,
  transitionSpec: { open: OPEN, close: CLOSE },
  gestureDirection: 'horizontal',
  gestureEnabled: false,
  cardOverlayEnabled: true,
  cardShadowEnabled: false,
  headerMode: 'screen',
};

const JS_FADE: StackNavigationOptions = {
  cardStyleInterpolator: forCrossfade,
  transitionSpec: { open: FADE, close: FADE },
  gestureEnabled: false,
  cardOverlayEnabled: false,
  cardShadowEnabled: false,
  headerMode: 'screen',
};

/*
 * The option objects below are returned as `object`: they are spread into
 * `screenOptions` typed for the native Stack, which has no JS-stack keys.
 * Spreading keeps TypeScript's excess-property check off those keys while
 * the JS stack still receives them at runtime.
 */

/** Push/pop options for a stack's `screenOptions`. Spread last. */
export function usePushTransition(): object {
  const reducedMotion = useReducedMotion();
  return React.useMemo(() => {
    if (!usesJsStack) return { animation: 'default' };
    return reducedMotion ? JS_FADE : JS_PUSH;
  }, [reducedMotion]);
}

/**
 * Crossfade for screens with no spatial relationship to the previous one
 * (auth ⇄ tabs). Spread into that screen's `options`.
 */
export const fadeTransition: object = usesJsStack ? JS_FADE : { animation: 'fade' };
