'use client';

import * as React from 'react';

/**
 * Where overlays portal to. Unset (the default), every overlay portals to
 * document.body as Radix does. ThemeScope sets it to an element inside its
 * subtree, so a dialog, popover or menu opened in a scope paints the scope's
 * tokens instead of the page's.
 */
const PortalContainerContext = React.createContext<HTMLElement | null>(null);

export const PortalContainerProvider = PortalContainerContext.Provider;

export function usePortalContainer(): HTMLElement | undefined {
  return React.useContext(PortalContainerContext) ?? undefined;
}

type PortalLike = { container?: Element | DocumentFragment | null };

/** Wraps a Radix-style Portal so it defaults `container` to the nearest ThemeScope. */
export function withPortalContainer<P extends PortalLike>(Portal: React.ComponentType<P>) {
  function ScopedPortal(props: P) {
    const scoped = usePortalContainer();
    return <Portal {...props} container={props.container ?? scoped} />;
  }
  ScopedPortal.displayName = `Scoped(${Portal.displayName ?? Portal.name ?? 'Portal'})`;
  return ScopedPortal;
}
