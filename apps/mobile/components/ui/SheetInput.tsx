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
import { accountColors } from '@/components/accounts/account-shared';

type BottomSheetTextInputProps = React.ComponentProps<typeof BottomSheetTextInput>;

export interface SheetTextInputProps extends BottomSheetTextInputProps {
  /** Use a monospace font (for slugs / identifiers). */
  mono?: boolean;
}

export function SheetTextInput({ mono, style, placeholderTextColor, ...props }: SheetTextInputProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const c = accountColors(isDark);
  return (
    <BottomSheetTextInput
      placeholderTextColor={placeholderTextColor ?? c.muted}
      {...props}
      style={[
        {
          height: 48,
          borderRadius: 9999,
          borderWidth: 1,
          borderColor: c.inputBorder,
          backgroundColor: c.inputBg,
          paddingHorizontal: 18,
          fontSize: 15,
          color: c.fg,
          fontFamily: mono ? 'Menlo' : 'Roobert',
        },
        style,
      ]}
    />
  );
}
