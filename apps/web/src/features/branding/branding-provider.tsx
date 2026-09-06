'use client';

/**
 * Organization branding — ONE provider, mounted once in the root layout.
 *
 * An Enterprise account can replace the Kortix marks its members see: the wide
 * brandmark, the square symbol, and the browser-tab icon — each with an
 * optional dark-scheme variant — plus the product name in the tab title.
 * The API decides what a member is SERVED (`KortixAccount.branding` on
 * `GET /accounts` — the stored record while the account is entitled, `null`
 * otherwise), so this provider does exactly two things:
 *
 *   1. pick WHICH account's branding applies right now — the account of the
 *      project on screen when there is one, else the selected account; and
 *   2. hand that `AccountBranding | null` to every consumer through context.
 *
 * It reads the same `useAccountsList()` query every other surface already holds
 * (`useEnsureSelectedAccount`, `AccountSwitcher`, `UserMenu`, …), so branding
 * costs no extra request. It renders nothing itself; `KortixLogo` swaps its
 * SVG for the org marks, and `BrandingDocumentEffect` (below) swaps the tab
 * icon and title once the account resolves. Before that — and on every
 * unauthenticated surface — the app is Kortix, by design: there is no account
 * to be branded as until someone signs in.
 */

import { type AccountBranding } from '@kortix/sdk';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { siteMetadata } from '@/lib/site-metadata';
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
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const { scopedAccountId } = useBrandingScopeState();

  // Same hook as every other consumer → one user-scoped fetch, shared cache.
  const accountsQuery = useAccountsList();

  const branding = useMemo<AccountBranding | null>(() => {
    const accounts = accountsQuery.data;
    if (!accounts?.length) return null;
    const activeId = scopedAccountId ?? selectedAccountId ?? accounts[0]?.account_id ?? null;
    const active = accounts.find((a) => a.account_id === activeId) ?? null;
    const b = active?.branding ?? null;
    if (!b) return null;
    // Normalize once so consumers can rely on every slot being present.
    return {
      app_name: b.app_name ?? null,
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

/** The product name to show in place of "Kortix". */
export function useAppName(): string {
  return useBranding()?.app_name ?? 'Kortix';
}


// ─── Document effect: favicon + title ───────────────────────────────────────

/** What Next rendered for each icon link before we touched it, kept OFF the
 *  DOM (a WeakMap, not data-attributes) so a restore never reads back a
 *  value that anything else could have written into the document. */
const originals = new WeakMap<HTMLLinkElement, { href: string; media: string | null }>();

/**
 * Next resolves `metadata.icons` and `title` on the server, above auth — so the
 * org favicon and name are applied client-side once the account is known. Cold
 * load shows the Kortix tab for the first paint; that is the accepted v1
 * trade-off (host-based tenancy would be the way to remove it).
 *
 * Title: Next writes `<title>` on every navigation from the route's metadata:
 * the site default (`Kortix – The AI Command Center for Your Company`) on
 * routes with no title of their own, `<page> | Kortix` elsewhere. A
 * `MutationObserver` on `<head>` rewrites whatever Next just wrote, so the
 * swap survives navigation without touching every page's metadata: the site
 * default collapses to the org name alone (its tagline is Kortix's, not
 * theirs); anything else has the literal "Kortix" token replaced. It only
 * writes when the result differs — no loops, no clobbering page titles.
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
  const appName = branding?.app_name ?? null;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const head = document.head;

    // Each link remembers what Next rendered the first time we touch it, so
    // switching back to an unbranded account restores exactly that — Next
    // emits several icon links (light, dark-media, shortcut) and their order
    // is not a contract.
    const stash = (link: HTMLLinkElement) => {
      if (originals.has(link)) return;
      originals.set(link, { href: link.getAttribute('href') ?? '', media: link.getAttribute('media') });
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
      const orig = originals.get(link);
      if (!orig) return;
      if (link.getAttribute('href') !== orig.href) link.setAttribute('href', orig.href);
      if (orig.media) link.setAttribute('media', orig.media);
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

  useEffect(() => {
    if (typeof document === 'undefined' || !appName) return;
    const rewrite = () => {
      const current = document.title;
      if (!current.includes('Kortix')) return;
      const next =
        current === siteMetadata.title ? appName : current.replace(/\bKortix\b/g, appName);
      if (next !== current) document.title = next;
    };
    rewrite();
    const observer = new MutationObserver(rewrite);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [appName]);

  return null;
}

