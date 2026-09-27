/**
 * SheetTextInput — the one canonical text field for bottom sheets. Fully-rounded
 * pill, standard input border/background, Roobert font. Wraps Gorhom's
 * BottomSheetTextInput so the keyboard behaves correctly inside a sheet.
 *
 * The pill's look comes from `usePillInputStyle` (./pill-input), shared with
 * `PillInput`, the same field for full screens outside a sheet.
 *
 * Pass `mono` for slug-style values, or override anything via `style`.
 */

import React from 'react';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';

import { usePillInputStyle } from './pill-input';

type BottomSheetTextInputProps = React.ComponentProps<typeof BottomSheetTextInput>;

/** The sheet field's established height. */
const SHEET_INPUT_HEIGHT = 48;

export interface SheetTextInputProps extends BottomSheetTextInputProps {
  /** Use a monospace font (for slugs / identifiers). */
  mono?: boolean;
}

export function SheetTextInput({ mono, style, placeholderTextColor, ...props }: SheetTextInputProps) {
  // BottomSheetTextInput isn't imported from 'react-native' directly, so
  // NativeWind never patches it with className support the way `<Input>`
  // gets it — the pill style is applied inline from THEME instead.
  const pill = usePillInputStyle({ height: SHEET_INPUT_HEIGHT, mono });
  return (
    <BottomSheetTextInput
      placeholderTextColor={placeholderTextColor ?? pill.placeholderTextColor}
      {...props}
      style={[pill.style, style]}
    />
  );
}
