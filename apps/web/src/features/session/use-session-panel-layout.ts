'use client';

import {
  aspectChangedWidth,
  resolveSideSize,
} from '@/features/session/action-panel/easy/easy-panel-logic';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as ResizablePrimitive from 'react-resizable-panels';

/**
 * The panel sizing and glide orchestration for `SessionLayout`'s desktop
 * split, moved verbatim out of `session-layout.tsx` (KRTX-459). Owns the
 * panel refs, the box observer that measures the split, the `sideSize`
 * precedence, and the resize effect with its 320 ms glide.
 */
export function useSessionPanelLayout({
  sessionId,
  isMobile,
  isExpanded,
  isEasy,
  panelSplit,
  panelAspect,
  shouldShowPanel,
}: {
  sessionId: string;
  isMobile: boolean;
  isExpanded: boolean;
  isEasy: boolean;
  panelSplit: number | null;
  panelAspect: number | null;
  shouldShowPanel: boolean;
}) {
  const mainPanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const sidePanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const panelGroupRef = useRef<HTMLDivElement>(null);
  // The panel group's own box, in a REF and never in state. The fit is decided
  // once per (document, ratio) pair; a window resize must not redecide it, or
  // the layout would quietly walk away from a divider the user dragged by
  // hand. State here would re-render — and therefore re-fit — on every resize
  // tick, which is precisely the behavior we are refusing.
  const panelBoxRef = useRef<{ width: number; height: number } | null>(null);

  const { enablePanelTransition, disablePanelTransition } = usePanelTransitions(panelGroupRef);
  usePanelBoxObserver({ isMobile, panelGroupRef, panelBoxRef });
  const { sideSize, mainSize } = usePanelSideSize({
    isExpanded,
    isEasy,
    panelSplit,
    panelAspect,
    panelBoxRef,
  });
  const isAnimating = usePanelGlide({
    sessionId,
    shouldShowPanel,
    isExpanded,
    isEasy,
    panelSplit,
    panelAspect,
    sideSize,
    mainSize,
    mainPanelRef,
    sidePanelRef,
    disablePanelTransition,
  });
  usePanelGlideFrames({
    isAnimating,
    enablePanelTransition,
    sideSize,
    mainSize,
    mainPanelRef,
    sidePanelRef,
  });

  return { mainPanelRef, sidePanelRef, panelGroupRef, isAnimating };
}

function usePanelTransitions(panelGroupRef: React.RefObject<HTMLDivElement | null>) {
  const enablePanelTransition = useCallback(() => {
    const el = panelGroupRef.current;
    if (!el) return;
    const panels = el.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]');
    panels.forEach((panel) => {
      panel.style.transition = 'flex 300ms cubic-bezier(0.4, 0, 0.2, 1)';
    });
  }, []);

  const disablePanelTransition = useCallback(() => {
    const el = panelGroupRef.current;
    if (!el) return;
    const panels = el.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]');
    panels.forEach((panel) => {
      panel.style.transition = 'none';
    });
  }, []);

  return { enablePanelTransition, disablePanelTransition };
}

// Keep the box current so a measurement landing at any moment has a real
// layout to be a fraction of. Desktop only — the mobile branch returns a
// drawer and never mounts this element, and nothing there has a split to
// observe for.
function usePanelBoxObserver({
  isMobile,
  panelGroupRef,
  panelBoxRef,
}: {
  isMobile: boolean;
  panelGroupRef: React.RefObject<HTMLDivElement | null>;
  panelBoxRef: React.RefObject<{ width: number; height: number } | null>;
}) {
  useEffect(() => {
    if (isMobile) {
      // Drop the box with the observer. A desktop box left behind would let a
      // measurement landing under the drawer compute a fit against a layout
      // that is no longer on screen — and run the 320ms resize timer for it.
      panelBoxRef.current = null;
      return;
    }
    const el = panelGroupRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      panelBoxRef.current = { width: box.width, height: box.height };
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isMobile]);
}

function usePanelSideSize({
  isExpanded,
  isEasy,
  panelSplit,
  panelAspect,
  panelBoxRef,
}: {
  isExpanded: boolean;
  isEasy: boolean;
  panelSplit: number | null;
  panelAspect: number | null;
  panelBoxRef: React.RefObject<{ width: number; height: number } | null>;
}) {
  // Easy mode opens at the panel's MINIMUM width (35/65): the cards are a
  // narrow column and the chat is where the user lives — a 50/50 split steals
  // half the screen for whitespace. Advanced keeps 50/50 (its
  // stepper/terminal/browser views earn the room). A layer that needs more
  // room requests it through `panelSplit` — 70/30 for a presentation
  // deliverable (the deck needs real width), 50/50 for the terminal. A
  // document that reported its own shape beats all of that (`panelAspect`).
  // The drag handle still lets either mode go wider/narrower by hand.
  //
  // Memoized on exactly the states that may re-decide the width, so the box
  // read below is sampled at those moments and only those: this is what makes
  // the fit survive a window resize instead of chasing it.
  //
  // `panelBoxRef.current` is read here ON PURPOSE, outside the dep array —
  // this is a deliberate stale-ref read, not a missed dependency. Adding
  // `panelBox` to the deps (or promoting the ref to state so it re-renders)
  // would make every `ResizeObserver` tick re-decide `sideSize`, turning the
  // one-shot fit into a live window-resize follower: it would fight a
  // hand-dragged divider on every resize instead of leaving it alone, and a
  // window resize would re-run the 300ms glide `aspectChangedWidth` below is
  // built to fire only once per real change. Do not "fix" this lint.
  const sideSize = useMemo(
    () =>
      resolveSideSize({
        isExpanded,
        isEasy,
        panelAspect,
        panelSplit,
        panelBox: panelBoxRef.current,
      }),
    [isExpanded, isEasy, panelAspect, panelSplit],
  );
  const mainSize = 100 - sideSize;
  return { sideSize, mainSize };
}

interface PanelGlideInput {
  sessionId: string;
  shouldShowPanel: boolean;
  isExpanded: boolean;
  isEasy: boolean;
  panelSplit: number | null;
  panelAspect: number | null;
  sideSize: number;
  mainSize: number;
  mainPanelRef: React.RefObject<ResizablePrimitive.ImperativePanelHandle | null>;
  sidePanelRef: React.RefObject<ResizablePrimitive.ImperativePanelHandle | null>;
  disablePanelTransition: () => void;
}

function usePanelGlide(input: PanelGlideInput) {
  const {
    sessionId,
    shouldShowPanel,
    isExpanded,
    isEasy,
    panelSplit,
    panelAspect,
    sideSize,
    mainSize,
    mainPanelRef,
    sidePanelRef,
    disablePanelTransition,
  } = input;
  const prevExpandedRef = useRef(isExpanded);
  const prevSplitRef = useRef(panelSplit);
  const prevAspectRef = useRef(panelAspect);
  const prevSideSizeRef = useRef(sideSize);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    const expandChanged = prevExpandedRef.current !== isExpanded;
    const splitChanged = prevSplitRef.current !== panelSplit;
    // A fit measurement joins the SAME change detection, so it rides the same
    // 300ms glide — a ratio arriving during the entrance coalesces into it
    // rather than fighting it. Judged on the width it produces against the
    // panel's REAL width, which is why `getSize()` and not `prevSideSizeRef`:
    // a divider the user dragged moved the panel without telling us, so the
    // width we last commanded is not the width on screen. See
    // `aspectChangedWidth` for both failures this guards.
    const aspectChanged = aspectChangedWidth({
      prevAspect: prevAspectRef.current,
      nextAspect: panelAspect,
      currentSize: sidePanelRef.current?.getSize() ?? prevSideSizeRef.current,
      nextSize: sideSize,
    });
    prevExpandedRef.current = isExpanded;
    prevSplitRef.current = panelSplit;
    prevAspectRef.current = panelAspect;
    prevSideSizeRef.current = sideSize;

    const skipAnimation = consumeSkipNextExpandAnimation();
    const changed = expandChanged || splitChanged || aspectChanged;
    const shouldAnimate = changed && shouldShowPanel && !skipAnimation;

    if (shouldAnimate) {
      setIsAnimating(true);
    } else if (changed) {
      // Instant path: clear any transition left on the panels so the resize
      // below snaps rather than inheriting a prior glide.
      disablePanelTransition();
    }

    applyPanelResize({ mainPanelRef, sidePanelRef, shouldShowPanel, sideSize, mainSize });

    if (shouldAnimate) {
      const timer = setTimeout(() => {
        disablePanelTransition();
        setIsAnimating(false);
      }, 320);
      return () => clearTimeout(timer);
    }
  }, [
    shouldShowPanel,
    isExpanded,
    sessionId,
    disablePanelTransition,
    isEasy,
    panelSplit,
    panelAspect,
    sideSize,
    mainSize,
  ]);

  return isAnimating;
}

// A detail-close collapse rides in with this flag set: snap the width, don't
// glide it (the detail plays its own slide-out — a width animation under it
// is a second, competing motion). Consume it here so the next deliberate
// fullscreen/minimize toggle (or wide-open) animates as usual.
function consumeSkipNextExpandAnimation(): boolean {
  const skipAnimation = useKortixComputerStore.getState().skipNextExpandAnimation;
  if (skipAnimation) useKortixComputerStore.setState({ skipNextExpandAnimation: false });
  return skipAnimation;
}

function applyPanelResize({
  mainPanelRef,
  sidePanelRef,
  shouldShowPanel,
  sideSize,
  mainSize,
}: {
  mainPanelRef: React.RefObject<ResizablePrimitive.ImperativePanelHandle | null>;
  sidePanelRef: React.RefObject<ResizablePrimitive.ImperativePanelHandle | null>;
  shouldShowPanel: boolean;
  sideSize: number;
  mainSize: number;
}) {
  if (shouldShowPanel) {
    sidePanelRef.current?.resize(sideSize);
    mainPanelRef.current?.resize(mainSize);
  } else {
    sidePanelRef.current?.resize(0);
    mainPanelRef.current?.resize(100);
  }
}

function usePanelGlideFrames({
  isAnimating,
  enablePanelTransition,
  sideSize,
  mainSize,
  mainPanelRef,
  sidePanelRef,
}: {
  isAnimating: boolean;
  enablePanelTransition: () => void;
  sideSize: number;
  mainSize: number;
  mainPanelRef: React.RefObject<ResizablePrimitive.ImperativePanelHandle | null>;
  sidePanelRef: React.RefObject<ResizablePrimitive.ImperativePanelHandle | null>;
}) {
  useEffect(() => {
    if (!isAnimating) return;
    const raf = requestAnimationFrame(() => {
      enablePanelTransition();
      sidePanelRef.current?.resize(sideSize);
      mainPanelRef.current?.resize(mainSize);
    });
    return () => cancelAnimationFrame(raf);
  }, [isAnimating, enablePanelTransition, sideSize, mainSize]);
}
