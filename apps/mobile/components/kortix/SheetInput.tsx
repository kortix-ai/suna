/**
 * SheetTextInput — the one canonical text field for bottom sheets. Fully-rounded
 * pill, standard input border/background, Roobert font. Wraps Gorhom's
 * BottomSheetTextInput so the keyboard behaves correctly inside a sheet.
 *
 * Pass `mono` for slug-style values, or override anything via `style`.
 */

import React from 'react';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { THEME, withAlpha } from '@/lib/utils/theme';

type BottomSheetTextInputProps = React.ComponentProps<typeof BottomSheetTextInput>;

export interface SheetTextInputProps extends BottomSheetTextInputProps {
  /** Use a monospace font (for slugs / identifiers). */
  mono?: boolean;
}

export function SheetTextInput({ mono, style, placeholderTextColor, ...props }: SheetTextInputProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  // BottomSheetTextInput isn't imported from 'react-native' directly, so
  // NativeWind never patches it with className support the way `<Input>`
  // gets it (confirmed by every other BottomSheetTextInput call site in this
  // app — all style it inline via a `style` prop). Colors below mirror
  // exactly what `<Input>` itself resolves to (`border-input`,
  // `bg-background` in light / `dark:bg-input/30` in dark, `text-foreground`,
  // `placeholder:text-muted-foreground`) — read from THEME, the hex-free
  // "className can't reach this prop" source (same contract documented in
  // lib/theme-colors.ts's header) instead of a local hex palette.
  const c = isDark ? THEME.dark : THEME.light;
  const inputBackground = isDark ? withAlpha(THEME.dark.input, 0.3) : THEME.light.background;
  return (
    <BottomSheetTextInput
      placeholderTextColor={placeholderTextColor ?? c.mutedForeground}
      {...props}
      style={[
        {
          height: 48,
          borderRadius: 9999,
          borderWidth: 1,
          borderColor: c.input,
          backgroundColor: inputBackground,
          paddingHorizontal: 18,
          fontSize: 15,
          color: c.foreground,
          fontFamily: mono ? 'Menlo' : 'Roobert',
        },
        style,
      ]}
    />
  );
}
