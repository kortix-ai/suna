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
 * Style and colours: the default style (`DEFAULT_LOGO_STYLE_ID`, the dither)
 * in the default metal (Graphite: no palette, so `MetalKortixLogo` uses its
 * fixed brand colours). The hidden style/colour sheet behind a long press is
 * deleted (COR-156). A press on the symbol closes the keyboard, as a tap on
 * the page around it does.
 */
import { Keyboard, Pressable, useWindowDimensions } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Reanimated, { interpolate, useAnimatedStyle } from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';

import { MetalKortixLogo } from '@/components/kortix/MetalKortixLogo';
import { DEFAULT_LOGO_STYLE_ID } from '@/lib/effects/logo-style';
import { HERO_KEYBOARD_SCALE, heroLogoSize } from '@/lib/session/project-hero';

export function ProjectHero() {
  const { colorScheme } = useColorScheme();
  const tone = colorScheme === 'dark' ? 'dark' : 'light';
  const { width } = useWindowDimensions();
  const { progress } = useReanimatedKeyboardAnimation();

  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(progress.value, [0, 1], [1, HERO_KEYBOARD_SCALE]) }],
  }));

  return (
    <Reanimated.View
      style={scaleStyle}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Kortix">
      <Pressable onPress={Keyboard.dismiss}>
        <MetalKortixLogo
          size={heroLogoSize(width)}
          tone={tone}
          style={DEFAULT_LOGO_STYLE_ID}
        />
      </Pressable>
    </Reanimated.View>
  );
}
