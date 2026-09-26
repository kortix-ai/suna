/**
 * MentionChip — one `@mention` or `/command` token inside a sent user message.
 *
 * Mirrors apps/web `features/session/mention-chip.tsx` `chipClass`:
 * `rounded-sm border-[0.5px] px-1.5 py-[0.08rem] text-[0.95em] font-medium
 * bg-primary/[0.08] text-foreground`, and `active:scale-[0.97]` when the chip
 * opens something (a file or a session). Web's hover tint has no touch
 * equivalent, so a press only scales. Where the chip splits the text is
 * `lib/session/mention-segments.ts`.
 *
 * The chip renders as an inline view inside the bubble's `Text`, so it wraps
 * with the sentence. React Native seats an inline view's bottom edge on the
 * text baseline on both platforms; `BASELINE_SHIFT` moves it down so the chip's
 * own text baseline meets the sentence's.
 */

import { Pressable, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { chipAccessibilityLabel, chipText, type ChipKind } from '@/lib/session/mention-segments';
import { webSpace } from '@/lib/session/user-message';
import { usePressScale } from './use-press-scale';

/** The bubble's text size (web `text-[0.9rem]`). */
const BUBBLE_FONT_SIZE = 14.4;
/** `text-[0.95em]` of the bubble text. */
const CHIP_FONT_SIZE = BUBBLE_FONT_SIZE * 0.95;
const CHIP_LINE_HEIGHT = 18;
/** `py-[0.08rem]`. */
const CHIP_PADDING_Y = 0.08 * 16;
const CHIP_BORDER_WIDTH = 0.5;
/**
 * Padding + border + the chip line's descent below its baseline (Roobert
 * descends ~0.234em; the 18pt line adds ~0.45pt of half-leading). Estimated,
 * not measured on a device — adjust here if the chip rides high or low.
 */
const BASELINE_SHIFT = CHIP_PADDING_Y + CHIP_BORDER_WIDTH + 0.234 * CHIP_FONT_SIZE + 0.45;

export interface MentionChipProps {
  kind: ChipKind;
  /** The label WITHOUT its prefix; `chipText` adds `@` or `/`. */
  label: string;
  /** Makes the chip tappable. Omitted for agent and command chips. */
  onPress?: () => void;
}

export function MentionChip({ kind, label, onPress }: MentionChipProps) {
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme === 'dark' ? 'dark' : 'light'];
  const { onPressIn, onPressOut, animatedStyle } = usePressScale(0.97, 150);

  const surface = {
    borderRadius: 6,
    borderWidth: CHIP_BORDER_WIDTH,
    borderColor: colors.border,
    backgroundColor: withAlpha(colors.primary, 0.08),
    paddingHorizontal: webSpace(1.5),
    paddingVertical: CHIP_PADDING_Y,
  } as const;

  const content = (
    <Text
      numberOfLines={1}
      style={{
        fontFamily: 'Roobert-Medium',
        fontSize: CHIP_FONT_SIZE,
        lineHeight: CHIP_LINE_HEIGHT,
        color: colors.foreground,
      }}
    >
      {chipText(kind, label)}
    </Text>
  );

  if (!onPress) {
    return (
      <View
        accessible
        accessibilityLabel={chipAccessibilityLabel(kind, label)}
        style={[surface, { transform: [{ translateY: BASELINE_SHIFT }] }]}
      >
        {content}
      </View>
    );
  }

  return (
    <View style={{ transform: [{ translateY: BASELINE_SHIFT }] }}>
      <Reanimated.View style={animatedStyle}>
        <Pressable
          onPress={onPress}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={chipAccessibilityLabel(kind, label)}
          style={surface}
        >
          {content}
        </Pressable>
      </Reanimated.View>
    </View>
  );
}
