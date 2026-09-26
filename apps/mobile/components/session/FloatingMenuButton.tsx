/**
 * FloatingMenuButton — the floating hamburger at the top left of the project
 * screens without a header bar: project home, a thread, and a connecting
 * session. It opens the project drawer (every project page shows it).
 * `children` render at the right end of the same 40pt row: the thread's
 * sub-agent chip and `···` (`ProjectHeaderActions`).
 *
 * `fade` adds a header strip behind the button, for a screen whose content
 * scrolls under it (the thread). The strip is the page background: solid from
 * the screen edge to the bottom of the button (the header row), then a 24pt
 * gradient to transparent below it, ending at `FLOATING_MENU_CLEARANCE`.
 * Content that rests at that clearance is never dimmed; content that scrolls
 * above it fades out, then is hidden behind the header row and the status
 * bar. The mirror of the 24pt fade above the chat input.
 *
 * `title` (COR-140) is the thread's `SessionThreadTitle` (the session name),
 * centred on the SCREEN, not in the gap between the hamburger and `children`
 * (Jay, 2026-09-27: the trailing chip and `···` are wider than the hamburger,
 * so the gap's centre sat left of the screen's). It lies over the whole row
 * and may use all the width between the two measured ends; a spacer on the
 * narrower end, as wide as the difference, keeps a short title on the
 * screen's centre. That spacer gives way first, so a long title runs into
 * the free space — while a thread loads there are no trailing controls, and
 * the title fills their place until they arrive (Jay, 2026-09-27). The row
 * is inset 16pt on both sides, so its centre is the screen's. It takes the same 40pt row height, so the header
 * strip never grows for it. Omitted on project home and the connecting
 * state, which have no title to show.
 */

import * as React from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
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
  /** Centred content between the hamburger and `children` (COR-140's thread
   *  title + status). Takes the remaining row width; omit for a plain
   *  hamburger-and-trailing-controls row (project home, connecting). */
  title?: React.ReactNode;
  /** Header controls at the right end of the hamburger's 40pt row. */
  children?: React.ReactNode;
}

export function FloatingMenuButton({ onPress, fade = false, title, children }: FloatingMenuButtonProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const background = colorScheme === 'dark' ? THEME.dark.background : THEME.light.background;
  const fadeHeight = insets.top + FLOATING_MENU_CLEARANCE;
  // The widths of the row's two ends. Seeded at one button each, so the title
  // does not start full width and jump on the first layout.
  const [leading, setLeading] = React.useState(BUTTON_SIZE);
  const [trailing, setTrailing] = React.useState(BUTTON_SIZE);
  const onLeadingLayout = React.useCallback(
    (e: LayoutChangeEvent) => setLeading(Math.ceil(e.nativeEvent.layout.width)),
    []
  );
  const onTrailingLayout = React.useCallback(
    (e: LayoutChangeEvent) => setTrailing(Math.ceil(e.nativeEvent.layout.width)),
    []
  );
  // 4pt clear of each end, the old column's `px-1`.
  const balance = Math.abs(leading - trailing);
  const balanceSpacer = (
    // Shrinks long before the title does (flexShrink is weighted by basis).
    <View style={{ flexBasis: balance, flexShrink: 1000 }} pointerEvents="none" />
  );

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
        className="absolute inset-x-4 z-10 flex-row items-center"
        style={{ top: insets.top + BUTTON_TOP }}
        pointerEvents="box-none">
        {title ? (
          // Over the whole row, between the measured ends. Two growing
          // spacers centre the title; the balance spacer moves that centre to
          // the screen's. The title's wrapper shrinks, so `numberOfLines`
          // truncates against the real free width. First in the tree, so the
          // ends stay above it for touches.
          <View
            style={[StyleSheet.absoluteFill, { paddingLeft: leading + 4, paddingRight: trailing + 4 }]}
            className="flex-row items-center"
            pointerEvents="box-none">
            {trailing > leading ? balanceSpacer : null}
            <View style={{ flexGrow: 1, flexBasis: 0 }} pointerEvents="none" />
            <View style={{ flexShrink: 1, minWidth: 0 }} pointerEvents="box-none">
              {title}
            </View>
            <View style={{ flexGrow: 1, flexBasis: 0 }} pointerEvents="none" />
            {leading > trailing ? balanceSpacer : null}
          </View>
        ) : null}
        <View onLayout={onLeadingLayout}>
          <MenuButton onPress={onPress} />
        </View>
        {/* Pushes `children` to the row's trailing edge. */}
        <View className="flex-1" pointerEvents="none" />
        <View onLayout={onTrailingLayout} className="flex-row items-center">
          {children}
        </View>
      </View>
    </>
  );
}
