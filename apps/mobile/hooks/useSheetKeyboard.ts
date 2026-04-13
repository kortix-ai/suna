/**
 * useSheetKeyboard — keyboard-aware bottom padding for bottom sheets with inputs.
 *
 * When keyboard is hidden → full safe area padding (home indicator).
 * When keyboard is visible → minimal padding (keyboard provides the spacing).
 */

import { useState, useEffect } from 'react';
import { Keyboard, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Returns bottom padding that collapses when keyboard is shown.
 * Use in BottomSheetView style for sheets containing text inputs.
 */
export function useSheetBottomPadding(extra = 16): number {
  const insets = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  if (keyboardVisible) {
    return extra; // Minimal padding — keyboard provides the rest
  }

  return Math.max(insets.bottom, 20) + extra;
}
