/**
 * Which surface a subtree is drawn on, so a `SettingsGroup` picks a row fill
 * that stands apart from it (Jay, 2026-09-23).
 *
 * `KortixBottomSheetModal` provides `'sheet'`. Everything else is `'page'`.
 */
import * as React from 'react';

export type Surface = 'page' | 'sheet';

export const SurfaceContext = React.createContext<Surface>('page');

/**
 * Row fill of a `SettingsGroup` on a sheet (or a dialog, the same `popover`
 * colour). The page default, `bg-card`, IS the sheet colour in dark mode
 * (both 7.8%), so rows vanished there. Light: `secondary` 92.6% on the white
 * sheet. Dark: `background` 4.3% under the 7.8% sheet, a darker well.
 */
export const SHEET_ROW_SURFACE = 'bg-secondary dark:bg-background';
