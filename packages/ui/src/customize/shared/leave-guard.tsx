'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { useUiRouter } from '../../providers/ui-provider';

/**
 * A page with unsaved edits (the agent editor) puts its "leave anyway?" question
 * here, so a screen it embeds asks it before a programmatic exit: a
 * `router.push` from the settings nav, or a configure session that navigates
 * into a new thread. Outside such a page there is no guard and the exit runs.
 */
const LeaveGuardContext = createContext<((leave: () => void) => void) | null>(null);

export const LeaveGuardProvider = LeaveGuardContext.Provider;

/** Runs `leave` now, or, under a dirty page, once the person confirms. */
export function useGuardedLeave(): (leave: () => void) => void {
  const guard = useContext(LeaveGuardContext);
  return useCallback((leave: () => void) => (guard ? guard(leave) : leave()), [guard]);
}

/**
 * Holds a dirty page on the page until the person decides.
 *
 * Three exits, one question. A tab close or a reload reaches only
 * `beforeunload`, so that is armed while dirty. An in-app link — the sidebar, a
 * tab, the breadcrumb — never fires it, and the App Router has no navigation
 * event to cancel, so anchor clicks are intercepted in the capture phase: the
 * click is swallowed, the exit is parked, and the page asks. A programmatic
 * exit from an embedded screen reaches `confirmLeave` through
 * {@link LeaveGuardProvider}. `leave` runs the parked exit; `stay` drops it.
 * Modified clicks (new tab) and external links pass through — nothing is lost
 * by opening a second tab.
 */
export function useUnsavedChangesGuard(isDirty: boolean, currentPath?: string) {
  const router = useUiRouter();
  // A function in state is set through the updater form: `setPending(() => fn)`.
  const [pending, setPending] = useState<(() => void) | null>(null);

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.origin !== window.location.origin) return;
      const href = anchor.pathname + anchor.search + anchor.hash;
      if (href === window.location.pathname + window.location.search + window.location.hash) return;
      // A link that only changes `?section=` on this page switches topic; the
      // draft survives that, so it never needs the question.
      if (currentPath && anchor.pathname === currentPath) return;
      event.preventDefault();
      event.stopPropagation();
      setPending(() => () => router.push(href));
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [isDirty, currentPath, router]);

  const confirmLeave = useCallback(
    (leave: () => void) => {
      if (isDirty) setPending(() => leave);
      else leave();
    },
    [isDirty],
  );

  return {
    /** True while the page asks whether to leave. */
    asking: pending !== null,
    confirmLeave,
    stay: () => setPending(null),
    leave: () => {
      const exit = pending;
      setPending(null);
      exit?.();
    },
  };
}
