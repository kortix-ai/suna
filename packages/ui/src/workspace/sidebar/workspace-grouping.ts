/**
 * The account name as a person reads it. The switcher and the chooser no
 * longer group by account (a workspace is one account and its project, see
 * `project-selector-model.ts`), so this label is search text and the copy on
 * account-level panes, never a heading over workspaces.
 */

/** Shown when an account has no usable name. Never blank. */
const FALLBACK_ACCOUNT_NAME = 'Account';

/**
 * The account name as a HUMAN reads it in a switcher.
 *
 * A personal account is created as "<Name>'s Account", so an unprocessed list
 * of them reads "Jay's Account / Ada's Account / Acme" — the same four words
 * repeated down the column, with the one distinguishing token buried at the
 * front. The suffix carries no information in a control whose every row is
 * already an account, so it comes off.
 *
 * Both apostrophes, because the two are indistinguishable on screen and a
 * name typed with a curly one would otherwise keep its suffix while its
 * neighbour lost it. Falls back rather than returning empty: an account
 * literally named "'s Account" would strip to nothing, and a blank heading is
 * worse than a redundant one.
 */
export function workspaceAccountLabel(
  name: string | null | undefined,
  fallback = FALLBACK_ACCOUNT_NAME,
  stripSuffix = true,
): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return fallback;
  if (!stripSuffix) return trimmed;
  const stripped = trimmed.replace(/[\u2019']s Account$/u, '').trim();
  return stripped || trimmed;
}
