'use client';

import { createContext, useContext, useRef, type ReactNode, type RefObject } from 'react';

/**
 * The capability pages' scroll container, published to anything that needs to
 * observe it.
 *
 * **Why this has to exist.** `CapabilityPageShell` is the scroll box, not the
 * window: the `(capabilities)` layout wraps it in `overflow-hidden`. An
 * `IntersectionObserver` with the default `root` observes the viewport, and a
 * target clipped by an `overflow-hidden` ancestor never intersects it — so an
 * infinite-scroll sentinel built the obvious way silently never fires. The
 * observer has to be handed THIS element as its root.
 *
 * **Why a ref in context, and not state.** Three routed pages render this
 * shell. Putting the element in `useState` means every one of them re-renders
 * once on mount to publish a value that only one descendant reads. A ref is
 * stable across renders, so the provider re-renders nothing; consumers resolve
 * `.current` in a layout effect after the ref has attached — the same handoff
 * `AncestorVirtualGrid` uses in `marketplace-paged-grid.tsx:326-331`.
 *
 * The context defaults to a ref holding `null`, which is exactly what an
 * observer wants when there is no shell: `root: null` means the viewport, so a
 * consumer rendered outside a shell degrades to window scrolling instead of
 * throwing.
 */
const CapabilityScrollRootContext = createContext<RefObject<HTMLElement | null>>({
  current: null,
});

export function CapabilityScrollRootProvider({
  scrollRef,
  children,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <CapabilityScrollRootContext.Provider value={scrollRef}>
      {children}
    </CapabilityScrollRootContext.Provider>
  );
}

/** The shell's scroll element, for an `IntersectionObserver` `root`. Read
 *  `.current` inside an effect — it is `null` during render. */
export function useCapabilityScrollRoot(): RefObject<HTMLElement | null> {
  return useContext(CapabilityScrollRootContext);
}

/** Creates the ref a shell attaches to its scroll box and hands to the
 *  provider. A one-line helper so the shell does not have to name the generic
 *  parameter, and so both halves of the pair always come from one import. */
export function useCapabilityScrollRootRef() {
  return useRef<HTMLDivElement | null>(null);
}
