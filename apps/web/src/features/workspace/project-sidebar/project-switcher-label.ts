/**
 * What the project switcher's trigger should say.
 *
 * The switcher used to fall back to the generic "Projects" label whenever it
 * couldn't name the active project. On a project route that fallback is just
 * wrong: the project list resolves a beat after the shell paints, so every
 * cold load of /projects/<id> showed "Projects" before settling on the real
 * name. A route that names a project is never the projects list — it's a
 * project we can't name *yet*, which calls for a placeholder, not a label.
 */
export interface SwitcherLabel {
  /** Trigger text, or null while the project's name is still unknown. */
  label: string | null;
  /** Render a placeholder — we are on a project we cannot name yet. */
  pending: boolean;
}

export function resolveSwitcherLabel(input: {
  activeProjectId?: string | null;
  activeProjectName?: string | null;
}): SwitcherLabel {
  const name = input.activeProjectName?.trim() || null;
  if (name) return { label: name, pending: false };
  // No project in the route — the switcher really is the "all projects" entry.
  if (!input.activeProjectId) return { label: 'Projects', pending: false };
  return { label: null, pending: true };
}
