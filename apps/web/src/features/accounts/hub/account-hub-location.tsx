'use client';

/**
 * How the account hub is addressed and how you move around inside it.
 *
 * There is no `/accounts` route, so there is no hub URL to hand around: the
 * hub is a modal over whatever page you are on, and its address is that page's
 * path plus `?accountId=…`. A place in the hub is therefore named by a
 * `HubTarget` (`hubTarget(accountId, { tab: 'members' })`), and this file turns
 * one into the real, working href for the page it is being rendered on.
 *
 * `HubLink` is the only way to link to the hub, from inside it or from
 * anywhere else in the app. It stays a real anchor: Cmd-click, middle-click
 * and "Open in new tab" all load the same page with the modal already open,
 * and the browser still shows where the row goes.
 */

import { usePathname, useSearchParams } from 'next/navigation';
import { forwardRef, useMemo, type AnchorHTMLAttributes, type MouseEvent } from 'react';

import {
  ACCOUNT_PANEL_PARAM,
  accountPanelUrl,
  hubParamsFromUrl,
  openAccountPanel,
  type HubTarget,
} from '@/stores/account-panel-store';

import { preloadAccountHub } from './account-hub-entry';

/**
 * The account the modal is showing, or `undefined` for the account list.
 *
 * Read straight off the URL, which is the only place it lives. `useParams()`
 * would be meaningless here — the modal renders over some other route, so
 * rendered route segments describe the page underneath, not the hub.
 */
export function useAccountPanelId(): string | undefined {
  return useSearchParams().get(ACCOUNT_PANEL_PARAM) || undefined;
}

/**
 * The hub's own query — `tab`, `member`, `group`, `project`, `from`, `setup`,
 * `provider` — in the hub's short names.
 *
 * Every `searchParams.get(...)` inside the hub goes through this rather than
 * `useSearchParams()`. That one substitution is what lets the modal prefix its
 * params on the shared URL (`accountTab`, `accountMember`, …) so they cannot
 * collide with the page underneath, without a single pane having to know.
 *
 * The `useSearchParams()` call lives HERE, in a leaf hook, and never in a
 * layout: a provider reading search params above the whole subtree would opt
 * it into client-side rendering at build time.
 */
export function useHubSearchParams(): URLSearchParams {
  const search = useSearchParams();
  return useMemo(() => hubParamsFromUrl(search), [search]);
}

/**
 * The real href that shows `target` over the page being rendered.
 *
 * Outside a router — a static render, a test harness that mounts a
 * presentational shell on its own — both hooks return `null`. That is not an
 * error to guard against but a case to answer: with no current URL there is no
 * path to keep, so the href degrades to the QUERY-ONLY relative form
 * (`?accountId=…`), which a browser resolves against whatever page the anchor
 * ends up on. The link is therefore never broken, and no consumer has to
 * provide a router just to render one.
 */
export function useHubUrl(target: HubTarget): string {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search?.toString() ?? '';
  return useMemo(
    () => {
      const base = pathname ? (query ? `${pathname}?${query}` : pathname) : '/';
      const url = accountPanelUrl(base, target);
      return pathname ? url : url.slice(url.indexOf('?'));
    },
    // `target` is rebuilt every render by design (it is a plain literal at the
    // call site), so the identity to depend on is its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname, query, target.accountId, JSON.stringify(target.params)],
  );
}

/**
 * A link into the account hub.
 *
 * `to` names the destination; the href is computed for the current page, so
 * the same component works from a project page, from a session, and from
 * inside the hub itself. A plain click moves the modal (a `pushState` or a
 * `replaceState` and one render — no navigation, no fetch); a modified click
 * is left to the browser, because a new tab is a request for the real URL.
 *
 * Pointer and keyboard focus warm the hub's chunk, so by the time the click
 * lands there is nothing left to fetch.
 */
export const HubLink = forwardRef<
  HTMLAnchorElement,
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: HubTarget }
>(function HubLink({ to, onClick, onPointerEnter, onFocus, ...rest }, ref) {
  const href = useHubUrl(to);
  return (
    <a
      ref={ref}
      href={href}
      onPointerEnter={(event) => {
        preloadAccountHub();
        onPointerEnter?.(event);
      }}
      onFocus={(event) => {
        preloadAccountHub();
        onFocus?.(event);
      }}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (event.button !== 0) return;
        event.preventDefault();
        // One frame later, not now. Many of these rows live inside a menu or
        // another modal, and Radix restores focus to the trigger as that layer
        // unmounts. Opening a focus-trapping dialog in the same tick lets that
        // restore land last and pull focus back OUT of the hub. A frame is
        // imperceptible and puts the two in the right order.
        requestAnimationFrame(() => openAccountPanel(to));
      }}
      {...rest}
    />
  );
});

/** Move the modal without a link — for a mutation's success handler, say. */
export function useHubNavigate(): (target: HubTarget) => void {
  return openAccountPanel;
}
