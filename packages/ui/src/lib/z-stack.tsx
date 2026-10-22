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

// ─── Runtime layer stack ────────────────────────────────────────────────────
// Context depth alone only stacks modals nested in each other's JSX. A modal
// mounted as a sibling (a global host, a store-driven dialog, one opened from a
// toast or the palette) resolves depth 1 however many modals are open, so its
// overlay lands UNDER the open modal's content. This registry sees every open
// layer regardless of tree position: opening one takes the next level above
// the highest open layer. Radix's DismissableLayer already stacks Escape and
// outside-click this way (one global list), so only z-index needed it.

type DialogLayer = { level: number; open: boolean };

const dialogLayers = new Map<string, DialogLayer>();
const dialogLayerListeners = new Set<() => void>();

function subscribeDialogLayers(listener: () => void) {
  dialogLayerListeners.add(listener);
  return () => {
    dialogLayerListeners.delete(listener);
  };
}

/** Level held by `id`, or 0 when unregistered. Kept after close on purpose. */
export function dialogLayerLevel(id: string): number {
  return dialogLayers.get(id)?.level ?? 0;
}

/**
 * Mark `id` open and return its level. A layer that is already open keeps its
 * level (it only rises to `minLevel`, its React-tree floor), so a sibling
 * opening above it never reshuffles it. A layer that is opening takes the next
 * level above every other open layer.
 */
export function openDialogLayer(id: string, minLevel: number): number {
  const current = dialogLayers.get(id);
  let level: number;
  if (current?.open) {
    level = Math.max(current.level, minLevel);
    if (level === current.level) return level;
  } else {
    let highest = 0;
    for (const [otherId, layer] of dialogLayers) {
      if (otherId !== id && layer.open) highest = Math.max(highest, layer.level);
    }
    level = Math.max(minLevel, highest + 1);
  }
  dialogLayers.set(id, { level, open: true });
  dialogLayerListeners.forEach((listener) => listener());
  return level;
}

/**
 * Mark `id` closed. Its level is kept so the exit animation stays above the
 * layer beneath it; it just stops raising layers that open afterwards.
 */
export function closeDialogLayer(id: string): void {
  const current = dialogLayers.get(id);
  if (current?.open) dialogLayers.set(id, { level: current.level, open: false });
}

export function removeDialogLayer(id: string): void {
  dialogLayers.delete(id);
}

const serverDialogLayerLevel = () => 0;

/**
 * Depth for a layer that is `open`: its runtime level, never below the depth
 * its React ancestors imply. Provide the result through `DialogDepthProvider`
 * so nested selects, menus, and modals stack above it.
 */
export function useDialogLayerDepth(open: boolean): number {
  const id = React.useId();
  const parentDepth = useDialogDepth();
  const level = React.useSyncExternalStore(
    subscribeDialogLayers,
    () => dialogLayerLevel(id),
    serverDialogLayerLevel,
  );

  // Layout effect: the level lands in the store, and the store update
  // re-renders synchronously before paint — the first open frame is never
  // drawn at the wrong z-index.
  React.useLayoutEffect(() => {
    if (open) openDialogLayer(id, parentDepth + 1);
    else closeDialogLayer(id);
  }, [id, open, parentDepth]);

  React.useLayoutEffect(() => () => removeDialogLayer(id), [id]);

  return Math.max(level, parentDepth + 1);
}

type DialogRootOpenProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * `useDialogLayerDepth` for a Radix dialog root. The stack needs the open state
 * of uncontrolled roots too, so this owns it and hands Radix a controlled
 * `open` / `onOpenChange` pair — observable behaviour is unchanged.
 */
export function useDialogRootLayer({ open, defaultOpen, onOpenChange }: DialogRootOpenProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const isControlled = open !== undefined;
  const resolvedOpen = isControlled ? open : uncontrolledOpen;

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  return {
    depth: useDialogLayerDepth(resolvedOpen),
    open: resolvedOpen,
    onOpenChange: handleOpenChange,
  };
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

/** Nested modals/sheets opened above the customize panel (or any parent dialog).
 *  Radix gives alerts `role="alertdialog"`, so confirm dialogs only count here
 *  if that role is matched too — miss it and Escape aimed at a confirm tears
 *  down the panel behind it. */
export function hasOpenNestedDialog(): boolean {
  return (
    document.querySelectorAll(
      '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]',
    ).length > 1
  );
}
