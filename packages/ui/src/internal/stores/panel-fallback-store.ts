import { create } from 'zustand';

import type { QuickView, QuickViewTarget } from './kortix-computer-store';
import { getActivePanelSessionId } from './session-browser-store';

/**
 * Where a panel intent goes when no side panel is mounted.
 *
 * The thread asks for the side panel in many places: a tool row's Preview, a
 * file chip, a clickable path, the header's Terminal and Browser buttons. Each
 * of them writes a store that only the side panel reads (`SessionWorkspace`).
 * A host that renders the thread alone (`SessionThread`) has no panel, so
 * those writes used to land nowhere and the button did nothing.
 *
 * `SessionPanelFallback` (mounted by `SessionThread`) registers here. While it
 * is mounted and no panel is, the intents open its overlay instead. With a
 * panel mounted, nothing changes: the panel stays the one destination.
 */
interface PanelFallbackState {
  /** Mounted fallback hosts. Usually 0 or 1. */
  hosts: number;
  /** The panel view the overlay shows, or null when it is closed. */
  request: { view: QuickView; target?: QuickViewTarget } | null;
}

export const usePanelFallbackStore = create<PanelFallbackState>(() => ({ hosts: 0, request: null }));

/** Register a mounted fallback host. Returns the unregister function. */
export function registerPanelFallbackHost(): () => void {
  usePanelFallbackStore.setState((s) => ({ hosts: s.hosts + 1 }));
  return () =>
    usePanelFallbackStore.setState((s) => ({
      hosts: Math.max(0, s.hosts - 1),
      request: s.hosts <= 1 ? null : s.request,
    }));
}

/** True when a panel intent must go to the fallback overlay: no side panel, one fallback host. */
export function panelFallbackActive(): boolean {
  return getActivePanelSessionId() === null && usePanelFallbackStore.getState().hosts > 0;
}

export function openPanelFallbackView(view: QuickView, target?: QuickViewTarget): void {
  usePanelFallbackStore.setState({ request: { view, target } });
}

export function closePanelFallbackView(): void {
  usePanelFallbackStore.setState({ request: null });
}
