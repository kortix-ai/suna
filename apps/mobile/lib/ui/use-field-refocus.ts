import * as React from 'react';
import { AppState, Keyboard, type TextInput } from 'react-native';

/**
 * Keeps a code field reachable after the user leaves the app to fetch the
 * code (authenticator, Mail) and comes back (Jay, 2026-10-20: "the keyboard
 * focus never comes to the input when I try to click it").
 *
 * iOS resigns the field's first responder when the app goes to the background
 * but sends no blur, so React Native still records the field as focused.
 * `TextInput.focus()` is then a no-op (TextInputState skips the field it
 * believes is focused), and a tap never brings the keyboard back.
 *
 * `refocus` blurs first, which clears that record, then focuses. Pass it as the
 * field's `onPressIn`; it does nothing while a keyboard is already up. The hook
 * also calls it when the app returns to the foreground, so the keyboard is open
 * and ready to paste. The app is `active` before its window is key again, and
 * iOS ignores a focus that lands earlier, hence the 300 ms beat.
 */
export function useFieldRefocus(ref: React.RefObject<TextInput | null>, editable = true): () => void {
  const refocus = React.useCallback(() => {
    const input = ref.current;
    if (!input || !editable || Keyboard.isVisible()) return;
    input.blur();
    requestAnimationFrame(() => input.focus());
  }, [ref, editable]);

  React.useEffect(() => {
    let previous = AppState.currentState;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && previous !== 'active') timer = setTimeout(refocus, 300);
      previous = next;
    });
    return () => {
      sub.remove();
      if (timer) clearTimeout(timer);
    };
  }, [refocus]);

  return refocus;
}
