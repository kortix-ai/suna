/**
 * LiquidGlass — the iOS 26 system Liquid Glass material, wrapped around the
 * control it belongs to.
 *
 * Native: `expo-glass-effect` `GlassView` is a UIKit `UIVisualEffectView`
 * with a `UIGlassEffect`. The React Native children mount inside the effect
 * view's `contentView`, so a touch on the button is a touch on the glass.
 * With `interactive` (the default), `UIGlassEffect.isInteractive` lets the
 * system run its own press response.
 *
 * Why not the earlier `LiquidGlassCapsule`: it drew SwiftUI `glassEffect` on
 * an empty `Spacer` in a separate `Host` behind the button, with
 * `pointerEvents="none"` and without `.interactive()`. The material was real,
 * but no touch ever reached it, so it never responded to a press. It
 * also drew nothing inside a `FullWindowOverlay` (no view controller), where
 * `GlassView` works.
 *
 * Where `LIQUID_GLASS_AVAILABLE` is false (Android, iOS before 26, a binary
 * without `ExpoGlassEffect`), `LiquidGlass` returns its children unchanged and
 * the caller keeps its opaque surface.
 *
 * Shape: `radius` for a fixed corner radius (the composer card). Without it
 * the glass is a capsule: the radius is half the measured height.
 */
import * as React from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { useColorScheme } from 'nativewind';

import { GlassButtonContext, type GlassButtonContent } from '@/components/kortix/glass-button-context';
import { supportsLiquidGlass } from '@/lib/ui/liquid-glass';

type GlassEffectModule = typeof import('expo-glass-effect');

// `require` only when the native module is in the binary: `GlassView`
// resolves its native view manager when the JS module loads.
const glassModule: GlassEffectModule | null =
  Platform.OS === 'ios' && requireOptionalNativeModule('ExpoGlassEffect') != null
    ? require('expo-glass-effect')
    : null;

export const LIQUID_GLASS_AVAILABLE =
  supportsLiquidGlass(Platform.OS, Platform.Version, glassModule != null) &&
  // False on early iOS 26 betas, where `UIGlassEffect` init fails.
  glassModule!.isGlassEffectAPIAvailable();

/** The capsule radius before the first layout: half the 44pt header button. */
const CAPSULE_RADIUS_GUESS = 22;

export function LiquidGlass({
  children,
  radius,
  interactive = true,
  style,
}: {
  children: React.ReactNode;
  /** Fixed corner radius. Omit for a capsule. */
  radius?: number;
  /** The system press response. */
  interactive?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colorScheme } = useColorScheme();
  const [capsuleRadius, setCapsuleRadius] = React.useState(CAPSULE_RADIUS_GUESS);
  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    setCapsuleRadius(e.nativeEvent.layout.height / 2);
  }, []);

  if (!LIQUID_GLASS_AVAILABLE || !glassModule) return <>{children}</>;
  const { GlassView } = glassModule;
  return (
    <GlassView
      glassEffectStyle="regular"
      isInteractive={interactive}
      // The app's theme, not the system's: the glass tints with the app.
      colorScheme={colorScheme === 'dark' ? 'dark' : 'light'}
      onLayout={radius == null ? onLayout : undefined}
      style={[{ borderRadius: radius ?? capsuleRadius }, style]}>
      {children}
    </GlassView>
  );
}

const FILL_CENTER: StyleProp<ViewStyle> = [StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }];

/**
 * Each button draws its own glass, inside its `Pressable`.
 * - An icon button has a fixed box: the glass fills it and holds the icon,
 *   so the icon moves with the glass.
 * - Any other size sizes to its padded content: the glass fills the whole
 *   button behind the content, and the content (the button's row and gap)
 *   takes no touches, so a press lands on the glass.
 */
const ownGlass: GlassButtonContent = (children, size) =>
  size?.startsWith('icon') ? (
    <LiquidGlass style={FILL_CENTER}>{children}</LiquidGlass>
  ) : (
    <>
      <LiquidGlass style={StyleSheet.absoluteFill}>{null}</LiquidGlass>
      <View pointerEvents="none" className={size === 'sm' ? 'flex-row items-center gap-1.5' : 'flex-row items-center gap-2'}>
        {children}
      </View>
    </>
  );
/** The group's shared capsule already draws the glass. */
const sharedGlass: GlassButtonContent = (children) => children;

/**
 * Puts every `Button` inside on iOS 26 Liquid Glass. The `Pressable` stays the
 * outer view, so its `hitSlop` keeps working: UIKit only hit-tests a child
 * inside its parent's bounds, so a glass view around the button would cut
 * the touch area to the glass. The glass sits inside the `Pressable` around
 * the content, so a press on the button is a press on the glass. The
 * ghost variant's pressed fill goes: the glass draws the press.
 *
 * `shared`: one glass capsule around the whole group (a button group); the
 * buttons inside draw no glass of their own.
 *
 * Elsewhere (Android, iOS before 26) it renders its children unchanged.
 */
export function GlassButtons({ children, shared = false }: { children: React.ReactNode; shared?: boolean }) {
  if (!LIQUID_GLASS_AVAILABLE) return <>{children}</>;
  const provided = (
    <GlassButtonContext.Provider value={shared ? sharedGlass : ownGlass}>{children}</GlassButtonContext.Provider>
  );
  return shared ? <LiquidGlass style={{ flexDirection: 'row', alignItems: 'center' }}>{provided}</LiquidGlass> : provided;
}
