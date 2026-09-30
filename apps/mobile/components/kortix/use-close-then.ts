import * as React from 'react';

/**
 * useCloseThen — the shared "close first, then run one thing" slot of the
 * session sheets ("never two overlays at once"). Four sheets held private
 * copies of this dance (`AttachSheet`, `PickerSheet`, `SessionActionsSheet`,
 * `useHandoffDismiss`): store the follow-up in the tap handler right before
 * the sheet dismisses, consume it exactly once from the sheet's `onDismiss`
 * — the close animation's end — and drop it stale on a re-open. A dismiss
 * that stored nothing takes null, so a swipe, a backdrop tap or "Not now"
 * never runs a follow-up.
 *
 * The dismiss itself stays at the call site: the refs differ (a `SheetRef`
 * closes, a gorhom modal dismisses) and `useHandoffDismiss` receives its
 * sheet ref per call. Store-then-dismiss is the whole dance.
 *
 * React-only, no React Native imports, so its characterization test runs
 * without mocking a native module. Re-exported through `sheet.tsx`, the
 * sheet module the sheets already import from.
 */
export function useCloseThen<A = () => void>() {
  const pendingRef = React.useRef<A | null>(null);
  // One stable handle per mount: members go into callbacks, deps and
  // imperative handles without churning them.
  return React.useMemo(
    () => ({
      /** Store the follow-up; dismiss the sheet right after. */
      deferAfterClose(action: A) {
        pendingRef.current = action;
      },
      /** Take the stored action once — null when this dismiss stored none. */
      takeAfterClose(): A | null {
        const action = pendingRef.current;
        pendingRef.current = null;
        return action;
      },
      /** Drop a stored action without running it (a re-open makes it stale). */
      clearAfterClose() {
        pendingRef.current = null;
      },
    }),
    [],
  );
}
