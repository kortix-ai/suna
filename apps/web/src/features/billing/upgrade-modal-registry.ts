/**
 * Exactly one upgrade dialog may be rendered at a time.
 *
 * `GlobalUpgradeModal` is mounted defensively in four places — the app
 * providers, the account hub's Plan pane, the workspace Plan tab, and the new-
 * workspace page — each with a comment explaining that without it a button on
 * that surface would open a dialog with no renderer. Every one of those
 * comments is right on its own, and together they mean two renderers can be
 * mounted at once on the same page.
 *
 * Two Radix dialogs opened from one store is not a cosmetic duplicate. Each
 * modal marks the rest of the document `aria-hidden` while it is open, so the
 * two hide each other: the pixels look correct and the accessibility tree
 * contains NEITHER dialog. Measured live on dev 2026-09-09 at
 * `/new?accountId=…&accountTab=billing` — `document.querySelectorAll(
 * '[role="dialog"]')` returned 3 nodes, 2 of them the subscribe dialog, and
 * BOTH carried `aria-hidden="true"`. A screen reader is told there is nothing
 * there, and every role-based query — including the release gate's
 * `getByRole('heading', { name: 'Subscribe to Kortix' })`, which failed the
 * v0.13.13 gate on staging three times — finds nothing.
 *
 * Which instance wins is a mount-order race, which is why the same click
 * behaves differently on two environments. So the choice is made here instead:
 * the FIRST mounted claimant renders, and if it unmounts the next one is
 * promoted. Callers keep mounting the component wherever a button needs it —
 * that stays correct — and only one of them draws.
 */

interface Claimant {
  token: object;
  setOwner: (owner: boolean) => void;
}

const claimants: Claimant[] = [];

/** Recompute ownership after any change. Index 0 draws; everyone else stands down. */
function settleOwnership(): void {
  claimants.forEach((claimant, index) => claimant.setOwner(index === 0));
}

/**
 * Register a renderer. Returns the release function.
 *
 * Exported for the hook and for tests; nothing else should call it.
 */
export function claimUpgradeModal(token: object, setOwner: (owner: boolean) => void): () => void {
  claimants.push({ token, setOwner });
  settleOwnership();
  return () => {
    const index = claimants.findIndex((claimant) => claimant.token === token);
    if (index === -1) return;
    claimants.splice(index, 1);
    settleOwnership();
  };
}

/** Test seam. */
export function upgradeModalClaimCount(): number {
  return claimants.length;
}
