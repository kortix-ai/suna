'use client';

/**
 * The account hub's state, which is a URL query param and nothing else.
 *
 * **There is no `/accounts` route.** The hub — organization settings, members,
 * groups, roles, identity, billing, audit — is a full-screen modal that opens
 * over whatever page you are on, and `?accountId=<id>` is the whole of its
 * state (Jay, 2026-09-08: "use the url param only to track the account id …
 * remove /accounts all pages entirely"). The route tree it used to live in was
 * deleted in the same change: every click on an account paid an RSC payload,
 * the hub's JS chunk and a shell teardown, twice, for a surface that was never
 * a page in the first place.
 *
 * `/projects/p_1?accountId=acc_1&accountTab=members` is a complete, shareable
 * address: reload it, paste it, and the modal comes back over the same page.
 *
 * **Open is derived, never stored.** The param present IS the modal being
 * open, so Back, Forward, a reload and a pasted link all work with no listener
 * and no synchronisation — Next keeps `useSearchParams()` in step with
 * `pushState` and `popstate`
 * (`next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md` →
 * "Native History API"). The only thing this store holds is the one fact the
 * URL cannot express: whether the modal is what pushed the current entry.
 *
 * **The path never moves**, which is what makes this safe. A native
 * `pushState` does not hand Next a new route tree, so an overlay that rewrote
 * the path would leave history entries whose URL and rendered content
 * disagree. Params cannot do that.
 */

import { create } from 'zustand';

/** Present ⇒ the modal is open. Empty ⇒ the account list, no account chosen. */
export const ACCOUNT_PANEL_PARAM = 'accountId';

/**
 * The hub's own state keys, and the URL param each one takes.
 *
 * Prefixed, and that is the point: the modal writes its state onto whatever
 * page you are already on, so a bare `tab` or `project` would squat on a
 * generic name across the entire app and silently steal it from any page that
 * later wants one. `?accountId=…&accountTab=members` reads as one group,
 * belongs to one surface, and can collide with nothing.
 *
 * Inside the hub every pane still reads the SHORT name — `tab`, `member`, … —
 * through `useHubSearchParams()`, which is the one place that translates.
 */
const HUB_PARAM_ALIASES = {
  /** Which section: an `AccountSection` from `hub/sections.ts`. */
  tab: 'accountTab',
  /** Drill-downs, each replacing its section's list with one entity's panel. */
  member: 'accountMember',
  group: 'accountGroup',
  project: 'accountProject',
  /** `customize` ⇒ opened from a project's Customize bar; earns a way back. */
  from: 'accountFrom',
  /** `sso` | `scim` — the guided wizard, which takes over the Identity pane. */
  setup: 'accountSetup',
  /** The IdP the wizard opens on, e.g. `entra`, `okta`. */
  provider: 'accountProvider',
} as const;

export type HubParamKey = keyof typeof HUB_PARAM_ALIASES;

export interface HubTarget {
  /** `''` is the account list — the pane the hub shows with no account chosen. */
  accountId: string;
  params: Partial<Record<HubParamKey, string>>;
}

/**
 * Name a place in the hub. This is the ONLY way to address one — there are no
 * hub URLs to hand around any more, because a hub URL depends on the page it
 * is opened over.
 *
 * Keys with a nullish or empty value are dropped, so a caller can pass its
 * optional drill-down straight through.
 */
export function hubTarget(
  accountId: string | null | undefined,
  params: Partial<Record<HubParamKey, string | null | undefined>> = {},
): HubTarget {
  const clean: Partial<Record<HubParamKey, string>> = {};
  for (const [key, value] of Object.entries(params) as [HubParamKey, string | null | undefined][]) {
    if (value != null && value !== '') clean[key] = value;
  }
  return { accountId: accountId ?? '', params: clean };
}

/** A base is required for a relative URL, and is discarded by `relative()`. */
function parse(url: string): URL {
  return new URL(url, 'https://x.invalid');
}

/** `pathname + search` — never the origin, which `history` does not take. */
function relative(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/** Strip every param the modal owns, leaving the page's own query alone. */
function withoutHubParams(url: URL): URL {
  const next = new URL(url);
  next.searchParams.delete(ACCOUNT_PANEL_PARAM);
  for (const alias of Object.values(HUB_PARAM_ALIASES)) next.searchParams.delete(alias);
  return next;
}

/**
 * The URL that shows `target` over the page `current` is on.
 *
 * The path is `current`'s, untouched. The page's own query survives; only the
 * params the modal owns are replaced, so moving around inside the hub cannot
 * accumulate a stale drill-down id from a section you have left.
 */
export function accountPanelUrl(current: string, target: HubTarget): string {
  const url = withoutHubParams(parse(current));
  url.searchParams.set(ACCOUNT_PANEL_PARAM, target.accountId);
  for (const [key, value] of Object.entries(target.params) as [HubParamKey, string][]) {
    url.searchParams.set(HUB_PARAM_ALIASES[key], value);
  }
  return relative(url);
}

/** The URL with the modal closed: the page exactly as it was. */
export function accountPanelClosedUrl(current: string): string {
  return relative(withoutHubParams(parse(current)));
}

/** What the modal shows for a URL, or `null` when it is closed. */
export function readAccountPanelUrl(current: string): { accountId: string } | null {
  const accountId = parse(current).searchParams.get(ACCOUNT_PANEL_PARAM);
  return accountId === null ? null : { accountId };
}

/**
 * A URL's params → the hub's own vocabulary.
 *
 * What every pane reads, through `useHubSearchParams()`. The prefix exists on
 * the wire and nowhere else.
 */
export function hubParamsFromUrl(search: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, alias] of Object.entries(HUB_PARAM_ALIASES)) {
    const value = search.get(alias);
    if (value !== null) params.set(key, value);
  }
  return params;
}

interface AccountPanelState {
  /**
   * Whether THIS modal put the current entry on the history stack. Closing
   * goes back only when it did; when the param arrived with the page — a
   * reload, a pasted link — there is nothing of ours to pop, so closing
   * rewrites the entry instead.
   */
  pushedEntry: boolean;
  setPushedEntry: (pushed: boolean) => void;
}

export const useAccountPanelStore = create<AccountPanelState>((set) => ({
  pushedEntry: false,
  setPushedEntry: (pushedEntry) => set({ pushedEntry }),
}));

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Show the hub over the current page, and put it in the address bar.
 *
 * Exactly ONE history entry per visit: the first open pushes, and every move
 * inside — a section, a drill-down, a different account — replaces. One Back
 * press therefore leaves the hub from anywhere inside it.
 */
export function openAccountPanel(target: HubTarget): void {
  if (typeof window === 'undefined') return;
  const current = currentUrl();
  const url = accountPanelUrl(current, target);
  if (readAccountPanelUrl(current)) {
    window.history.replaceState(null, '', url);
    return;
  }
  window.history.pushState(null, '', url);
  useAccountPanelStore.getState().setPushedEntry(true);
}

/**
 * Forget that the modal pushed an entry, without touching history.
 *
 * For the one exit that replaces the modal rather than closing it: a
 * `router.replace` to a real page overwrites the pushed entry itself, so a
 * later `closeAccountPanel` must not try to pop it as well.
 */
export function forgetPushedEntry(): void {
  useAccountPanelStore.getState().setPushedEntry(false);
}

/** Close the modal and give the address bar back to the page underneath. */
export function closeAccountPanel(): void {
  if (typeof window === 'undefined') return;
  const current = currentUrl();
  if (!readAccountPanelUrl(current)) return;

  const { pushedEntry, setPushedEntry } = useAccountPanelStore.getState();
  setPushedEntry(false);
  if (pushedEntry) {
    // Pop the one entry the modal pushed, so no dead Back press is left behind
    // and Next gets its own entry back with its tree state intact.
    window.history.back();
    return;
  }
  // The param arrived with the page (a reload, a pasted link). Nothing of ours
  // is on the stack, so rewrite this entry rather than popping someone else's.
  window.history.replaceState(null, '', accountPanelClosedUrl(current));
}
