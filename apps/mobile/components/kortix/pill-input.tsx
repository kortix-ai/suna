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
import { THEME, withAlpha } from '@/lib/utils/theme';

/** Matches `Button size="lg"` (h-11, 44pt), so fields and buttons stack flush. */
export const PILL_INPUT_HEIGHT = 44;

/**
 * The pill's look, shared by `PillInput` and `SheetTextInput`. Colors mirror
 * what `<Input>` resolves to (`border-input`, `bg-background` in light /
 * `dark:bg-input/30` in dark, `text-foreground`, muted placeholder), read from
 * THEME because neither host input receives NativeWind `className` support.
 */
export function usePillInputStyle({ height, mono }: { height: number; mono?: boolean }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const c = isDark ? THEME.dark : THEME.light;
  const style: TextStyle = {
    height,
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: c.input,
    backgroundColor: isDark ? withAlpha(THEME.dark.input, 0.3) : THEME.light.background,
    paddingHorizontal: 18,
    fontSize: 15,
    color: c.foreground,
    fontFamily: mono ? 'Menlo' : 'Roobert',
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
