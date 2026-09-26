/**
 * ProjectHero — the Kortix symbol, alone. No sentence, no project name (Jay,
 * 2026-09-21). It is a shader that follows the phone's tilt
 * (`MetalKortixLogo`), and falls back to the flat symbol if the shader is not
 * ready.
 *
 * The one hero for an empty project surface. ProjectHome (no chat open) and
 * SessionPage's FreshSessionHero (a new chat with no messages) both render it,
 * so the two states cannot drift apart.
 *
 * Size: `heroLogoSize` of the window width at rest. While the keyboard is up
 * the symbol scales down to `HERO_KEYBOARD_SCALE`. The scale reads the
 * keyboard's own progress on the UI thread, so it moves 1:1 with the keyboard,
 * reverses with it mid-way, and needs no timing of its own. Only `transform`
 * animates: the parent centres the hero, and a scale about the centre keeps it
 * centred.
 *
 * Style and colours: the user's choice (`useLogoPaletteStore`), else the
 * dither in its default metal (Graphite). The palette feeds each style its
 * own colour: the dither's cell colour, the heatmap's pair.
 * The control is hidden: a press held for 5 seconds (`LOGO_SHEET_HOLD_MS`)
 * opens `LogoPaletteSheet`. A shorter press does nothing but close the
 * keyboard, as a tap on the page around the symbol does. No hint, no progress:
 * it is not a feature to discover by accident.
 */
import * as React from 'react';
import { Keyboard, Pressable, useWindowDimensions } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Reanimated, { interpolate, useAnimatedStyle } from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';

import { MetalKortixLogo } from '@/components/kortix/MetalKortixLogo';
import type { SheetRef } from '@/components/kortix/sheet';
import { LogoPaletteSheet } from '@/components/session/LogoPaletteSheet';
import { LOGO_PALETTES, logoFrontColor, logoPaletteColors } from '@/lib/effects/logo-palette';
import { haptics } from '@/lib/haptics';
import { HERO_KEYBOARD_SCALE, heroLogoSize } from '@/lib/session/project-hero';
import { THEME } from '@/lib/utils/theme';
import { useLogoPaletteStore } from '@/stores/logo-palette-store';

/** How long the symbol must be held before the colour sheet opens. */
const LOGO_SHEET_HOLD_MS = 5_000;

export function ProjectHero() {
  const { colorScheme } = useColorScheme();
  const tone = colorScheme === 'dark' ? 'dark' : 'light';
  const { width } = useWindowDimensions();
  const { progress } = useReanimatedKeyboardAnimation();
  const sheetRef = React.useRef<SheetRef>(null);

  const styleId = useLogoPaletteStore((s) => s.styleId);
  const paletteId = useLogoPaletteStore((s) => s.paletteId);
  // Memoized: the shader's uniforms rebuild only when the colours change.
  const colors = React.useMemo(() => {
    const chosen = LOGO_PALETTES.find((p) => p.id === paletteId);
    if (!chosen?.accent) return { palette: null, front: null };
    const accent = THEME.accent[chosen.accent];
    return {
      palette: logoPaletteColors(accent, tone),
      front: logoFrontColor(accent, tone),
    };
  }, [paletteId, tone]);

  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(progress.value, [0, 1], [1, HERO_KEYBOARD_SCALE]) }],
  }));

  return (
    <>
      <Reanimated.View
        style={scaleStyle}
        accessible
        accessibilityRole="image"
        accessibilityLabel="Kortix">
        <Pressable
          onPress={Keyboard.dismiss}
          delayLongPress={LOGO_SHEET_HOLD_MS}
          onLongPress={() => {
            haptics.success();
            Keyboard.dismiss();
            sheetRef.current?.open();
          }}>
          <MetalKortixLogo
            size={heroLogoSize(width)}
            tone={tone}
            style={styleId}
            palette={colors.palette}
            front={colors.front}
          />
        </Pressable>
      </Reanimated.View>
      <LogoPaletteSheet ref={sheetRef} />
    </>
  );
}
