'use client';

/**
 * The Models page's ONE side sheet, shared by every tab.
 *
 * The page (and the quick provider dialog) wraps its whole shell in a
 * `SplitSheet` (`ProviderSheetSplit`, `gateway-view.tsx`). Providers open there
 * directly; any other tab (Logs, Custom, …) claims the same column with
 * `useModelsPageSheet` and renders its panel into it through a portal. The
 * section keeps its own state and handlers — only the DOM moves — so the
 * sheet sits beside the full page, never inside a section's column.
 */

import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ModelsPageSheetHost {
  /** The open sheet column's mount point, or null while it is closed. */
  target: HTMLElement | null;
  /** A section asks for the column (`onClose` set) or gives it back (null). */
  claim: (onClose: (() => void) | null) => void;
}

export const ModelsPageSheetContext = createContext<ModelsPageSheetHost | null>(null);

/**
 * Open the page sheet while `open` is true. Returns a render function: wrap the
 * panel (`SplitSheetHeader` / `SplitSheetBody` / `SplitSheetFooter`) in it.
 * The sheet's × and Escape call `onClose`.
 */
export function useModelsPageSheet(open: boolean, onClose: () => void) {
  const host = useContext(ModelsPageSheetContext);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const claim = host?.claim;
  useEffect(() => {
    if (!claim || !open) return;
    claim(() => onCloseRef.current());
    return () => claim(null);
  }, [claim, open]);
  return (panel: ReactNode) =>
    open && host?.target ? createPortal(panel, host.target) : null;
}
