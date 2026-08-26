'use client';

/**
 * Organization branding — ONE provider, mounted once in the root layout.
 *
 * An Enterprise account can replace the Kortix marks its members see: the wide
 * brandmark, the square symbol, and the browser-tab icon — each with an
 * optional dark-scheme variant.
 * The API decides what a member is SERVED (`KortixAccount.branding` on
 * `GET /accounts` — the stored record while the account is entitled, `null`
 * otherwise), so this provider does exactly two things:
 *
 *   1. pick WHICH account's branding applies right now — the account of the
 *      project on screen when there is one, else the selected account; and
 *   2. hand that `AccountBranding | null` to every consumer through context.
 *
 * It reads the same `['accounts']` query every other surface already holds
 * (`useEnsureSelectedAccount`, `AccountSwitcher`, `UserMenu`, …), so branding
 * costs no extra request. It renders nothing itself; `KortixLogo` swaps its
 * SVG for the org marks, and `BrandingDocumentEffect` (below) swaps the tab
 * icon once the account resolves. Before that — and on every
 * unauthenticated surface — the app is Kortix, by design: there is no account
 * to be branded as until someone signs in.
 */

import { listAccounts, type AccountBranding } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { useCurrentAccountStore } from '@/stores/current-account-store';

/** Set by an account-scoped surface (the project shell, the account hub) so
 *  it brands as THAT account, even when the switcher's selected account is a
 *  different one. */
interface BrandingScopeState {
  scopedAccountId: string | null;
}

const BrandingContext = createContext<AccountBranding | null>(null);

// Tiny external store instead of a second React context: `ProjectShell` sits
// far below this provider and must push the project's account id UP. A
// context value cannot flow upward; a module-level subscription can.
let scope: BrandingScopeState = { scopedAccountId: null };
const scopeListeners = new Set<() => void>();
function setBrandingScope(next: BrandingScopeState) {
  if (scope.scopedAccountId === next.scopedAccountId) return;
  scope = next;
  for (const l of scopeListeners) l();
}
function useBrandingScopeState(): BrandingScopeState {
  const [, force] = useReducerTick();
  useEffect(() => {
    scopeListeners.add(force);
    return () => {
      scopeListeners.delete(force);
    };
  }, [force]);
  return scope;
}
function useReducerTick(): [number, () => void] {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  return [tick, bump];
}

/**
 * Call from an account-scoped surface with the account it shows — the project
 * shell passes the project's `account_id`, the account hub passes its route
 * id. Clears on unmount so leaving the surface falls back to the selected
 * account. One scope at a time: these surfaces never nest.
 */
export function useBrandingScope(accountId: string | null | undefined): void {
  useEffect(() => {
    setBrandingScope({ scopedAccountId: accountId ?? null });
    return () => setBrandingScope({ scopedAccountId: null });
  }, [accountId]);
}

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const { scopedAccountId } = useBrandingScopeState();

  // Same key + staleTime as every other consumer → one fetch, shared cache.
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: !!user,
    staleTime: 60_000,
  });

  const branding = useMemo<AccountBranding | null>(() => {
    const accounts = accountsQuery.data;
    if (!accounts?.length) return null;
    const activeId = scopedAccountId ?? selectedAccountId ?? accounts[0]?.account_id ?? null;
    const active = accounts.find((a) => a.account_id === activeId) ?? null;
    const b = active?.branding ?? null;
    if (!b) return null;
    // Normalize once so consumers can rely on every slot being present.
    return {
      logo_url: b.logo_url ?? null,
      icon_url: b.icon_url ?? null,
      favicon_url: b.favicon_url ?? null,
      logo_dark_url: b.logo_dark_url ?? null,
      icon_dark_url: b.icon_dark_url ?? null,
      favicon_dark_url: b.favicon_dark_url ?? null,
    };
  }, [accountsQuery.data, scopedAccountId, selectedAccountId]);

  return (
    <BrandingContext.Provider value={branding}>
      <BrandingDocumentEffect branding={branding} />
      {children}
    </BrandingContext.Provider>
  );
}

/**
 * The active account's branding, or `null` for default Kortix. Safe outside
 * the provider (tests, isolated renders): resolves to `null`.
 */
export function useBranding(): AccountBranding | null {
  return useContext(BrandingContext);
}


// ─── Document effect: favicon ───────────────────────────────────────────────

const ORIG_HREF = 'data-kortix-orig-href';
const ORIG_MEDIA = 'data-kortix-orig-media';

/**
 * Next resolves `metadata.icons` on the server, above auth — so the org favicon
 * is applied client-side once the account is known. Cold load shows the Kortix
 * tab for the first paint; that is the accepted v1 trade-off (host-based
 * tenancy would be the way to remove it).
 */
const DARK_ICON_ATTR = 'data-kortix-dark-icon';

function BrandingDocumentEffect({ branding }: { branding: AccountBranding | null }) {
  const iconHref = branding?.favicon_url ?? branding?.icon_url ?? null;
  // The tab icon follows the OS scheme, not the app theme, so the dark
  // variant rides a `prefers-color-scheme: dark` link of its own.
  const iconDarkHref = iconHref
    ? (branding?.favicon_dark_url ?? branding?.icon_dark_url ?? null)
    : null;
  const appleHref = branding?.icon_url ?? branding?.favicon_url ?? null;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const head = document.head;

    // Each link remembers what Next rendered the first time we touch it, so
    // switching back to an unbranded account restores exactly that — Next
    // emits several icon links (light, dark-media, shortcut) and their order
    // is not a contract.
    const stash = (link: HTMLLinkElement) => {
      if (link.hasAttribute(ORIG_HREF)) return;
      link.setAttribute(ORIG_HREF, link.getAttribute('href') ?? '');
      link.setAttribute(ORIG_MEDIA, link.getAttribute('media') ?? '');
    };
    const apply = (link: HTMLLinkElement, href: string | null) => {
      stash(link);
      if (href) {
        if (link.getAttribute('href') !== href) link.setAttribute('href', href);
        // One branded image for both color schemes: the media-scoped Kortix
        // dark variant must not win over it.
        if (link.hasAttribute('media')) link.removeAttribute('media');
        return;
      }
      const origHref = link.getAttribute(ORIG_HREF) ?? '';
      const origMedia = link.getAttribute(ORIG_MEDIA) ?? '';
      if (link.getAttribute('href') !== origHref) link.setAttribute('href', origHref);
      if (origMedia) link.setAttribute('media', origMedia);
      else link.removeAttribute('media');
    };

    const applyAll = () => {
      const tabIcons = Array.from(
        head.querySelectorAll<HTMLLinkElement>(
          `link[rel="icon"]:not([${DARK_ICON_ATTR}]), link[rel="shortcut icon"]`,
        ),
      );
      const touchIcons = Array.from(
        head.querySelectorAll<HTMLLinkElement>('link[rel="apple-touch-icon"]'),
      );
      for (const link of tabIcons) apply(link, iconHref);
      for (const link of touchIcons) apply(link, appleHref);

      // One extra, media-scoped link for the dark favicon. Ours to own:
      // created here, removed here, never confused with Next's.
      let dark = head.querySelector<HTMLLinkElement>(`link[${DARK_ICON_ATTR}]`);
      if (iconDarkHref) {
        if (!dark) {
          dark = document.createElement('link');
          dark.rel = 'icon';
          dark.media = '(prefers-color-scheme: dark)';
          dark.setAttribute(DARK_ICON_ATTR, '');
          head.appendChild(dark);
        }
        if (dark.getAttribute('href') !== iconDarkHref) dark.setAttribute('href', iconDarkHref);
      } else if (dark) {
        dark.remove();
      }
    };

    applyAll();
    // Next re-renders the route's metadata on hydration and on every client
    // navigation, which can (re)insert icon links after this effect ran. Any
    // new <link> in <head> gets branded the moment it appears; attribute
    // writes on existing links do not fire childList, so this cannot loop.
    const observer = new MutationObserver((mutations) => {
      const addedLink = mutations.some((m) =>
        Array.from(m.addedNodes).some(
          (n) => n instanceof HTMLLinkElement && !n.hasAttribute(DARK_ICON_ATTR),
        ),
      );
      if (addedLink) applyAll();
    });
    observer.observe(head, { childList: true });
    return () => observer.disconnect();
  }, [iconHref, iconDarkHref, appleHref]);


  return null;
}

