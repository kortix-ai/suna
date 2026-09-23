/**
 * PlatformButton — a native SwiftUI button on iOS, the design-system `Button`
 * everywhere else.
 *
 * iOS renders `@expo/ui`'s SwiftUI `Button` (plain style on the `secondary`
 * token, clipped to a circle or capsule). Android renders
 * `@/components/ui/button` with `rounded-full`, so both platforms show a pill.
 *
 * `PlatformFullWidthButton` is the full-width sibling (the auth sign-in
 * pills): on iOS a native SwiftUI capsule drawn in the design-system variant's
 * own colours, elsewhere the design-system `Button`.
 *
 * OTA safety: `runtimeVersion` is a fixed string, so an OTA update can reach a
 * binary built before `@expo/ui` was added. The SwiftUI path is used only when
 * the `ExpoUI` native module is present in the running binary; otherwise iOS
 * falls back to the design-system button instead of crashing.
 */

import * as React from 'react';
import { Platform, View } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { useColorScheme } from 'nativewind';
import { type AppIcon } from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { THEME, toHexColor } from '@/lib/utils/theme';

type SwiftUIModule = typeof import('@expo/ui/swift-ui');
type SwiftUIModifiers = typeof import('@expo/ui/swift-ui/modifiers');
// `sf-symbols-typescript` is @expo/ui's own dependency and not resolvable from
// this package under pnpm, so take the symbol name type from the Image props.
type SFSymbol = NonNullable<React.ComponentProps<SwiftUIModule['Image']>['systemName']>;

const nativeUIAvailable = Platform.OS === 'ios' && requireOptionalNativeModule('ExpoUI') != null;
const swiftUI: SwiftUIModule | null = nativeUIAvailable
  ? (require('@expo/ui/swift-ui') as SwiftUIModule)
  : null;
const swiftUIModifiers: SwiftUIModifiers | null = nativeUIAvailable
  ? (require('@expo/ui/swift-ui/modifiers') as SwiftUIModifiers)
  : null;

/** Matches `Button size="icon"` (h-10 w-10). */
const ICON_BUTTON_SIZE = 40;
/**
 * Same height as the icon-only button, so a labelled pill ("+ New") and a
 * round icon button (search) sitting side by side in a header line up exactly.
 * Matches `Button size="default"` (h-10).
 */
const LABEL_BUTTON_HEIGHT = ICON_BUTTON_SIZE;

/** True when this binary can render the native SwiftUI button. */
export const hasNativeButtons = swiftUI != null;

/** Liquid Glass button styles exist from iOS 26. */
const IOS_MAJOR = Platform.OS === 'ios' ? parseInt(String(Platform.Version), 10) : 0;
/** True when this binary and OS can render a native Liquid Glass button. */
const hasLiquidGlass = hasNativeButtons && IOS_MAJOR >= 26;

/**
 * Room around a glass button inside its Host. Glass draws a ~17pt shadow
 * outside the button, and the Host clips to its bounds (a hard square halo
 * when there is no room). The Host is padded by this much and the React Native
 * wrapper takes it back with a negative margin, so layout sees only the button.
 */
const GLASS_SHADOW_BLEED = 18;

export interface PlatformButtonProps {
  /** Visible text. Omit for an icon-only button (then `accessibilityLabel` names it). */
  label?: string;
  /** SF Symbol for the native iOS button, e.g. "plus", "chevron.left". */
  systemImage?: SFSymbol;
  /** Icon (from `@/lib/icons`) for the design-system fallback. */
  icon?: AppIcon;
  /** Design-system variant used off iOS (and on iOS without the native module). */
  fallbackVariant?: 'default' | 'secondary' | 'outline' | 'ghost';
  /** Design-system size for a labelled fallback button; icon-only uses `icon`. */
  fallbackSize?: 'sm' | 'default' | 'lg';
  /**
   * iOS 26+: a native Liquid Glass icon button (`buttonStyle('glass')`, circle)
   * instead of the plain button on the `secondary` fill. Icon-only. Other
   * platforms and older iOS use the fallback.
   */
  glass?: boolean;
  accessibilityLabel: string;
  disabled?: boolean;
  onPress: () => void;
}

export function PlatformButton({
  label,
  systemImage,
  icon,
  fallbackVariant = 'default',
  fallbackSize = 'default',
  glass = false,
  accessibilityLabel,
  disabled,
  onPress,
}: PlatformButtonProps) {
  const { colorScheme } = useColorScheme();

  if (glass && hasLiquidGlass && swiftUI && swiftUIModifiers && systemImage && !label) {
    const { Host, Button: NativeButton, Image } = swiftUI;
    const {
      accessibilityLabel: a11yLabel,
      buttonBorderShape,
      buttonStyle,
      controlSize,
      disabled: disabledModifier,
      padding,
    } = swiftUIModifiers;
    return (
      <View style={{ margin: -GLASS_SHADOW_BLEED }} pointerEvents="box-none">
        <Host matchContents colorScheme={colorScheme === 'dark' ? 'dark' : 'light'}>
          <NativeButton
            modifiers={[
              buttonStyle('glass'),
              buttonBorderShape('circle'),
              controlSize('large'),
              disabledModifier(!!disabled),
              a11yLabel(accessibilityLabel),
              // Outside the glass: room for its shadow (see GLASS_SHADOW_BLEED).
              padding({ horizontal: GLASS_SHADOW_BLEED, vertical: GLASS_SHADOW_BLEED }),
            ]}
            onPress={onPress}>
            <Image systemName={systemImage} size={17} />
          </NativeButton>
        </Host>
      </View>
    );
  }

  // A native button needs visible content: a label, a symbol, or both.
  if (swiftUI && swiftUIModifiers && (label || systemImage)) {
    const { Host, Button: NativeButton, HStack, Image, Text: NativeText } = swiftUI;
    const {
      accessibilityLabel: a11yLabel,
      background,
      buttonStyle,
      clipShape,
      disabled: disabledModifier,
      fixedSize,
      font,
      frame,
      lineLimit,
      padding,
    } = swiftUIModifiers;
    // The label is an explicit HStack, not `label` + `systemImage`: that pair
    // renders a SwiftUI `Label`, which a styled button can collapse to
    // icon-only (seen on the iOS 26.5 simulator: "New" was dropped).
    // `fixedSize`: without it SwiftUI compresses the text to "…" inside the
    // Host's measured width (seen on the iOS 26.5 simulator).
    const content = label ? (
      <HStack spacing={6}>
        {systemImage ? <Image systemName={systemImage} size={15} /> : null}
        <NativeText modifiers={[font({ weight: 'medium' }), lineLimit(1), fixedSize({ horizontal: true })]}>
          {label}
        </NativeText>
      </HStack>
    ) : (
      <Image systemName={systemImage} size={17} />
    );
    // No Liquid Glass here (opt in with `glass`, above): glass (both
    // `buttonStyle('glass')` and `glassEffect`) draws a ~17pt drop shadow
    // outside the button, and a Host sized to the button clips it — a hard,
    // square-cornered halo (verified on the iOS 26.5 simulator). A plain SwiftUI button on the `secondary` token,
    // clipped to a circle / capsule, keeps native press behaviour with no
    // shadow to clip. The fill must be hex: the modifier silently drops hsl
    // and UIKit semantic names (`secondarySystemFill` rendered no fill at all).
    const fill = toHexColor(THEME[colorScheme === 'dark' ? 'dark' : 'light'].secondary);
    return (
      <Host matchContents colorScheme={colorScheme === 'dark' ? 'dark' : 'light'}>
        <NativeButton
          modifiers={[
            buttonStyle('plain'),
            label
              ? padding({ horizontal: 14 })
              : frame({ width: ICON_BUTTON_SIZE, height: ICON_BUTTON_SIZE }),
            ...(label ? [frame({ height: LABEL_BUTTON_HEIGHT })] : []),
            background(fill),
            label ? clipShape('capsule') : clipShape('circle'),
            disabledModifier(!!disabled),
            a11yLabel(accessibilityLabel),
          ]}
          onPress={onPress}>
          {content}
        </NativeButton>
      </Host>
    );
  }

  const iconOnly = !label;
  return (
    <Button
      variant={fallbackVariant}
      size={iconOnly ? 'icon' : fallbackSize}
      className="rounded-full"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}>
      {icon ? <Icon as={icon} size={iconOnly ? 20 : 16} /> : null}
      {label ? <Text>{label}</Text> : null}
    </Button>
  );
}

/** Native heights, equal to `Button` `size="lg"` (h-11) and `size="xl"` (h-12). */
const FULL_WIDTH_HEIGHT = { lg: 44, xl: 48 } as const;
/** `left-5`: the leading icon's inset from the pill's left edge. */
const FULL_WIDTH_INSET = 20;
/**
 * Width kept free on both sides of the label: the leading icon's slot on the
 * left, an empty slot of the same width on the right, so the label stays
 * centred on the pill like the design-system button's.
 */
const FULL_WIDTH_SLOT = 20;
/** A width larger than any screen: `frame(maxWidth:)` then fills the Host. */
const FILL_WIDTH = 10_000;
/**
 * Room below the pill for `shadow-sm` (1pt down, 2pt blur). The Host clips
 * what is outside it, so the Host grows by this much on both edges and the
 * wrapper takes it back with a negative margin.
 */
const FULL_WIDTH_SHADOW_BLEED = 3;

export interface PlatformFullWidthButtonProps {
  label: string;
  /**
   * Drawn at the pill's left edge: a brand icon or a spinner. On iOS it is a
   * React Native view hosted inside the native button, so it dims with the
   * label when pressed.
   */
  leading?: React.ReactElement;
  /** Design-system variant. The native button draws the same tokens. */
  variant?: 'default' | 'outline';
  size?: 'lg' | 'xl';
  disabled?: boolean;
  onPress: () => void;
}

/**
 * A full-width pill (`rounded-full`) with the label centred and `leading`
 * pinned to the left edge. iOS with the `ExpoUI` module: a native SwiftUI
 * button (plain style, so the system press dimming applies) filled and
 * stroked with the variant's tokens from `components/ui/button.tsx`.
 * Elsewhere: the design-system `Button`.
 */
export function PlatformFullWidthButton({
  label,
  leading,
  variant = 'default',
  size = 'lg',
  disabled,
  onPress,
}: PlatformFullWidthButtonProps) {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';

  if (swiftUI && swiftUIModifiers) {
    const { Host, Button: NativeButton, HStack, RNHostView, Spacer, Text: NativeText } = swiftUI;
    const {
      accessibilityLabel: a11yLabel,
      background,
      buttonStyle,
      disabled: disabledModifier,
      font,
      foregroundColor,
      frame,
      lineLimit,
      opacity,
      padding,
      shadow,
      shapes,
      strokeBorder,
    } = swiftUIModifiers;
    const colors = THEME[scheme];
    const height = FULL_WIDTH_HEIGHT[size];
    // The variant classes, as hex (the modifiers drop hsl):
    //   default  bg-primary, text-primary-foreground
    //   outline  bg-background + border-border; dark: bg-input/30 + border-input
    // Both carry `shadow-sm shadow-black/5`.
    const outline = variant === 'outline';
    const fill = outline
      ? scheme === 'dark'
        ? toHexColor(colors.input, 0.3)
        : toHexColor(colors.background)
      : toHexColor(colors.primary);
    const textColor = toHexColor(outline ? colors.foreground : colors.primaryForeground);
    const stroke = outline ? toHexColor(scheme === 'dark' ? colors.input : colors.border) : null;
    return (
      <View style={{ marginVertical: -FULL_WIDTH_SHADOW_BLEED }}>
        <Host
          colorScheme={scheme}
          style={{ width: '100%', height: height + 2 * FULL_WIDTH_SHADOW_BLEED }}>
          <NativeButton
            modifiers={[
              buttonStyle('plain'),
              disabledModifier(!!disabled),
              // `Button` renders `opacity-50` while disabled.
              opacity(disabled ? 0.5 : 1),
              a11yLabel(label),
            ]}
            onPress={onPress}>
            <HStack
              spacing={0}
              modifiers={[
                padding({ horizontal: FULL_WIDTH_INSET }),
                frame({ maxWidth: FILL_WIDTH, height }),
                background(fill, shapes.capsule()),
                ...(stroke
                  ? [strokeBorder({ color: stroke, style: { lineWidth: 1 }, shape: 'capsule' })]
                  : []),
                shadow({ radius: 1, y: 1, color: '#0000000d' }), // hex-allowlist: black at 5% alpha (#0000000d), the variants' shadow-black/5
              ]}>
              <HStack modifiers={[frame({ width: FULL_WIDTH_SLOT, alignment: 'leading' })]}>
                {leading ? (
                  // `pointerEvents="none"`: a tap on the icon reaches the
                  // native button. `collapsable={false}` keeps this wrapper a
                  // real view, so Fabric cannot flatten it away and leave the
                  // SVG to catch the touch.
                  <RNHostView matchContents>
                    <View pointerEvents="none" collapsable={false}>
                      {leading}
                    </View>
                  </RNHostView>
                ) : (
                  <Spacer />
                )}
              </HStack>
              <Spacer />
              <NativeText
                modifiers={[
                  font({ family: 'Roobert-Medium', size: 16 }),
                  foregroundColor(textColor),
                  lineLimit(1),
                ]}>
                {label}
              </NativeText>
              <Spacer />
              <Spacer modifiers={[frame({ width: FULL_WIDTH_SLOT })]} />
            </HStack>
          </NativeButton>
        </Host>
      </View>
    );
  }

  return (
    <Button variant={variant} size={size} className="rounded-full" disabled={disabled} onPress={onPress}>
      {leading ? (
        <View className="absolute bottom-0 left-5 top-0 justify-center">{leading}</View>
      ) : null}
      <Text>{label}</Text>
    </Button>
  );
}
