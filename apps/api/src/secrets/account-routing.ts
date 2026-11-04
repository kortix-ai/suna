/**
 * Which subscription account (a Claude or ChatGPT login) a session's model call uses first.
 *
 * A session stays on one account: the provider's prompt cache belongs to the account, so a
 * session that hops accounts pays its whole context again on every hop (and a plan's usage is
 * easier to read when one session draws on one account). It moves only when its account cannot
 * serve well: resting after a limit (the caller already left those out), limited by the
 * provider, or close to the end of a plan window. It then moves to the account with the most
 * headroom, and stays there.
 *
 * Headroom is the account's stored plan usage (`account_secret_resources.usage`, reported from
 * every response's headers): the fullest window that has not reset yet. An account with no
 * usage on record counts as empty. An exhausted account still goes last rather than nowhere:
 * the stored usage can be stale, and the provider is the one that refuses.
 */
import type { SubscriptionUsage } from '@kortix/llm-gateway';

/** At or above this share of any open window, a session leaves the account when another has room. */
export const LEAVE_AT_PERCENT = 95;

export interface Headroom {
  /** The fullest open window, 0–100. */
  usedPercent: number;
  /** The provider refuses the account, or a window is spent. */
  exhausted: boolean;
}

function isUsage(value: unknown): value is SubscriptionUsage {
  return !!value && typeof value === 'object' && Array.isArray((value as { windows?: unknown }).windows);
}

/** The account's headroom now. A window whose reset time passed counts as empty. */
export function headroom(usage: unknown, now = Date.now()): Headroom {
  if (!isUsage(usage)) return { usedPercent: 0, exhausted: false };
  let usedPercent = 0;
  let openSpent = false;
  for (const window of usage.windows) {
    const reset = window.resets_at ? Date.parse(window.resets_at) : NaN;
    if (Number.isFinite(reset) && reset <= now) continue;
    const used = Number.isFinite(window.used_percent) ? window.used_percent : 0;
    usedPercent = Math.max(usedPercent, used);
    if (used >= 100) openSpent = true;
  }
  // `limited` holds until a window resets: once every window it named reset, it is stale.
  const limited = usage.limited && usage.windows.some((window) => {
    const reset = window.resets_at ? Date.parse(window.resets_at) : NaN;
    return !Number.isFinite(reset) || reset > now;
  });
  return { usedPercent, exhausted: limited || openSpent };
}

export interface RoutedAccounts<T> {
  /** The accounts to try, in order. */
  ordered: T[];
  /** The account the session is on after this call: the first of `ordered`. */
  pin: string | undefined;
}

/**
 * Order the accounts ready to serve (none resting) for one call. `pinned` is the account the
 * session used last. Ties keep the caller's order (the session's selection order, or oldest
 * first for shared accounts), so the result is stable.
 */
export function routeAccounts<T extends { secretId: string; usage?: unknown }>(
  ready: readonly T[],
  pinned: string | undefined,
  now = Date.now(),
): RoutedAccounts<T> {
  if (ready.length === 0) return { ordered: [], pin: undefined };
  const scored = ready.map((account, index) => ({ account, index, ...headroom(account.usage, now) }));
  const byHeadroom = [...scored].sort((a, b) =>
    Number(a.exhausted) - Number(b.exhausted) || a.usedPercent - b.usedPercent || a.index - b.index);
  const best = byHeadroom[0]!;
  const current = scored.find((entry) => entry.account.secretId === pinned);
  // Stay unless the pinned account is spent, or nearly spent while another has room.
  const stay = current && !current.exhausted &&
    (current.usedPercent < LEAVE_AT_PERCENT || best.exhausted || best.usedPercent >= LEAVE_AT_PERCENT);
  const first = stay ? current : best;
  const ordered = [first.account, ...byHeadroom.filter((entry) => entry !== first).map((entry) => entry.account)];
  return { ordered, pin: first.account.secretId };
}
