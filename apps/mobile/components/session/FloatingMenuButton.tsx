/**
 * FloatingMenuButton — the floating hamburger at the top left of the project
 * screens without a header bar: project home, a thread, and a connecting
 * session. It opens the project drawer (every project page shows it).
 * `children` render at the right end of the same 40pt row: `AgentPill`.
 *
 * `fade` adds a header strip behind the button, for a screen whose content
 * scrolls under it (the thread). The strip is the page background: solid from
 * the screen edge to the bottom of the button (the header row), then a 24pt
 * gradient to transparent below it, ending at `FLOATING_MENU_CLEARANCE`.
 * Content that rests at that clearance is never dimmed; content that scrolls
 * above it fades out, then is hidden behind the header row and the status
 * bar. The mirror of the 24pt fade above the chat input.
 */

import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MenuButton } from '@/components/kortix/menu-button';
import { THEME, withAlpha } from '@/lib/utils/theme';

/** Button offset below the safe area. */
const BUTTON_TOP = 8;
/** `MenuButton` is a 40pt icon button. */
const BUTTON_SIZE = 40;
/** The gradient below the header row. Same height as the fade above the chat input. */
const FADE_HEIGHT = 18;

/**
 * Space below the safe-area edge that the header strip takes: 8pt offset +
 * 40pt button + 24pt fade. Scrolling content starts here, where the fade ends.
 */
export const FLOATING_MENU_CLEARANCE = BUTTON_TOP + BUTTON_SIZE + FADE_HEIGHT;

interface FloatingMenuButtonProps {
  onPress?: () => void;
  fade?: boolean;
  /** Header control at the right end of the hamburger's 40pt row (`AgentPill`). */
  children?: React.ReactNode;
}

export function FloatingMenuButton({ onPress, fade = false, children }: FloatingMenuButtonProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const background = colorScheme === 'dark' ? THEME.dark.background : THEME.light.background;
  const fadeHeight = insets.top + FLOATING_MENU_CLEARANCE;

  return (
    <>
      {fade ? (
        <View pointerEvents="none" className="absolute inset-x-0 top-0 z-10" style={{ height: fadeHeight }}>
          <LinearGradient
            colors={[withAlpha(background, 1), withAlpha(background, 1), withAlpha(background, 0)]}
            locations={[0, (fadeHeight - FADE_HEIGHT) / fadeHeight, 1]}
            style={StyleSheet.absoluteFill}
          />
        </View>
      ) : null}
      <View
        className="absolute inset-x-4 z-10 flex-row items-center justify-between"
        style={{ top: insets.top + BUTTON_TOP }}
        pointerEvents="box-none">
        <MenuButton onPress={onPress} />
        {children}
      </View>
    </>
  );
}
