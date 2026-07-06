import * as React from 'react';

const DialogDepthContext = React.createContext(0);
DialogDepthContext.displayName = 'DialogDepthContext';

export function DialogDepthProvider({
  depth,
  children,
}: {
  depth: number;
  children: React.ReactNode;
}) {
  return <DialogDepthContext.Provider value={depth}>{children}</DialogDepthContext.Provider>;
}

export function useDialogDepth(): number {
  return React.useContext(DialogDepthContext);
}

export function dialogOverlayZ(depth: number): number {
  const level = Math.max(1, depth);
  return 9998 + (level - 1) * 20;
}

export function dialogContentZ(depth: number): number {
  const level = Math.max(1, depth);
  return 9999 + (level - 1) * 20;
}

export function floatingZ(depth: number): number {
  if (depth <= 0) return 10001;
  return dialogContentZ(depth) + 2;
}

/** Portaled popovers/menus/selects rendered outside dialog DOM. */
export const FLOATING_LAYER_SELECTOR =
  '[role="menu"],[role="listbox"],[role="tooltip"],[data-radix-popper-content-wrapper]';

export function isFloatingLayerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(FLOATING_LAYER_SELECTOR));
}

export function hasOpenFloatingLayer(): boolean {
  return Boolean(
    document.querySelector(
      '[role="menu"][data-state="open"],[role="listbox"][data-state="open"],[data-radix-popper-content-wrapper] [data-state="open"]',
    ),
  );
}

/** Nested modals/sheets opened above the customize panel (or any parent dialog). */
export function hasOpenNestedDialog(): boolean {
  return document.querySelectorAll('[role="dialog"][data-state="open"]').length > 1;
}
