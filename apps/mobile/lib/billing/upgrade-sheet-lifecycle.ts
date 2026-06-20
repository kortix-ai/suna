export type UpgradeSheetTransition = 'present' | 'dismiss' | 'none';

/**
 * Avoids sending an initial dismiss command to @gorhom/bottom-sheet.
 * That command can asynchronously trigger onDismiss after a user has already
 * opened the sheet, immediately clearing the global upgrade state.
 */
export function getUpgradeSheetTransition(
  isOpen: boolean,
  wasPresented: boolean,
): UpgradeSheetTransition {
  if (isOpen && !wasPresented) return 'present';
  if (!isOpen && wasPresented) return 'dismiss';
  return 'none';
}
