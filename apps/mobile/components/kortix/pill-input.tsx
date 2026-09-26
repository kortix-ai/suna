/**
 * PillInput — the pill text field for full screens (the auth forms).
 *
 * Same pill as `SheetTextInput`, built from the same `usePillInputStyle`. It
 * renders a plain `TextInput` because gorhom's `BottomSheetTextInput` throws
 * outside a bottom sheet ("'useBottomSheetInternal' cannot be used out of the
 * BottomSheet!"). It forwards its ref, so a form can move focus field to field.
 */

import * as React from 'react';
import { TextInput, type TextStyle } from 'react-native';
import { useColorScheme } from 'nativewind';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { THEME } from '@/lib/utils/theme';

/** Matches `Button size="lg"` (h-11, 44pt), so fields and buttons stack flush. */
export const PILL_INPUT_HEIGHT = 44;

/**
 * Input text: one size, one family, one weight for every text field in the
 * app (`Input`, `PillInput`, `SheetTextInput`, `SearchHeader`, `SearchBar`).
 * 16pt — the iOS body size, and the size below which mobile browsers zoom a
 * focused field. `Roobert-Regular` is the loaded font name; the bare family
 * name 'Roobert' does not resolve on Android and fell back to the system font.
 * The placeholder uses the same size and weight, only a muted colour.
 */
export const INPUT_FONT_SIZE = 16;
export const INPUT_FONT_FAMILY = 'Roobert-Regular';

/**
 * The pill's look, shared by `PillInput` and `SheetTextInput`: a filled,
 * borderless `secondary` surface (no input has a border — design.md → Inputs).
 * Read from THEME because neither host input receives NativeWind `className`.
 */
export function usePillInputStyle({ height, mono }: { height: number; mono?: boolean }) {
  const { colorScheme } = useColorScheme();
  const c = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const style: TextStyle = {
    height,
    borderRadius: 9999,
    backgroundColor: c.secondary,
    paddingHorizontal: 18,
    fontSize: INPUT_FONT_SIZE,
    color: c.foreground,
    fontFamily: mono ? MONO_FONT_FAMILY : INPUT_FONT_FAMILY,
  };
  return { style, placeholderTextColor: c.mutedForeground };
}

export type PillInputProps = Omit<React.ComponentProps<typeof TextInput>, 'ref'>;

export const PillInput = React.forwardRef<TextInput, PillInputProps>(function PillInput(
  { style, placeholderTextColor, ...props },
  ref
) {
  const pill = usePillInputStyle({ height: PILL_INPUT_HEIGHT });
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={placeholderTextColor ?? pill.placeholderTextColor}
      {...props}
      style={[pill.style, style]}
    />
  );
});
