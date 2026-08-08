/**
 * What the project switcher's trigger should say.
 *
 * The switcher used to fall back to the generic "Projects" label whenever it
 * couldn't name the active project. On a project route that fallback is just
 * wrong: the project list resolves a beat after the shell paints, so every
 * cold load of /projects/<id> showed "Projects" before settling on the real
 * name. A route that names a project is never the projects list — it's a
 * project we can't name *yet*, which calls for a placeholder, not a label.
 *
 * ## Two sources, one authority
 *
 * The name has exactly one source of truth: the project DETAIL entry, read
 * through `useProjectName`. The projects LIST also carries a name, and the
 * original two-titles bug was reading the list FIRST
 * (`activeProject?.name ?? detail`) — which let a rename that invalidated one
 * cache and not the other render two different names on one screen.
 *
 * Dropping the list entirely fixed that and cost the warm paint: navigating
 * /projects → /projects/<id> leaves the list warm and the detail cold, so the
 * sidebar showed a skeleton for a name it had on screen one route earlier.
 *
 * `placeholderProjectName` restores it without reopening the bug, because it
 * is a PLACEHOLDER and not a source. The rule, and the invariant to preserve
 * if this function is ever edited:
 *
 *   > Once the detail entry exists, nothing else can influence the rendered
 *   > name.
 *
 * `activeProjectName === undefined` is the only state that means "the detail
 * has produced nothing" — it is React Query's own `data === undefined`, which
 * `useProjectName` passes straight through. Every other value, INCLUDING a
 * blank or whitespace-only one, means the detail spoke; a blank name is the
 * detail's answer, not an opening for a second source to answer instead. So a
 * blank detail name renders the placeholder skeleton rather than the list's
 * name, which is the strict reading of the invariant and the one that cannot
 * drift.
 *
 * Do NOT collapse `undefined` and `null` here (e.g. by calling this with
 * `useProjectName(id) ?? null`) — that erases the distinction the invariant
 * rests on and silently turns the placeholder off.
 */
export interface SwitcherLabel {
  /** Trigger text, or null while the project's name is still unknown. */
  label: string | null;
  /** Render a placeholder — we are on a project we cannot name yet. */
  pending: boolean;
}

export function resolveSwitcherLabel(input: {
  activeProjectId?: string | null;
  /**
   * The authoritative name, from `useProjectName` (the project detail entry).
   * `undefined` means the detail has produced nothing yet — the ONLY state in
   * which the placeholder below is consulted.
   */
  activeProjectName?: string | null;
  /**
   * Warm-cache stand-in from the projects LIST. Shown only while the detail
   * is absent, and never allowed to override or outlive it.
   */
  placeholderProjectName?: string | null;
}): SwitcherLabel {
  const name = input.activeProjectName?.trim() || null;
  if (name) return { label: name, pending: false };
  // No workspace in the route — the switcher is the "all workspaces" entry.
  if (!input.activeProjectId) return { label: 'Workspaces', pending: false };
  // The detail entry exists and its name is blank. It still governs.
  if (input.activeProjectName !== undefined) return { label: null, pending: true };

  const placeholder = input.placeholderProjectName?.trim() || null;
  if (placeholder) return { label: placeholder, pending: false };
  return { label: null, pending: true };
}
