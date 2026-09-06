/**
 * The identity of a setup step, independent of its display copy.
 *
 * Deliberately NOT the step's `title`: the title is user-visible copy that a
 * rename or a translation may change, and the completion probe keys off this.
 * A step whose key no longer matched would silently read as incomplete
 * forever — a checklist that never finishes is worse than no checklist.
 */
export type ProjectSetupStepKey =
  | 'connectors'
  | 'triggers'
  | 'skills'
  | 'slack'
  | 'team'
  | 'agent';

/**
 * What the checklist's probes actually saw, with every "is it done" judgement
 * still to be made. Split out from the component so the rules — and the
 * off-by-one in `memberCount` in particular — are testable without a DOM, a
 * query client, or a browser.
 */
export interface ProjectSetupProbe {
  connectorCount: number;
  triggerCount: number;
  skillCount: number;
  agentCount: number;
  /** Every member, INCLUDING the person reading this. */
  memberCount: number;
  slackConnected: boolean;
}

/** The one place a setup step is declared finished. */
export function deriveSetupCompletion(
  probe: ProjectSetupProbe,
): Record<ProjectSetupStepKey, boolean> {
  return {
    connectors: probe.connectorCount > 0,
    triggers: probe.triggerCount > 0,
    skills: probe.skillCount > 0,
    slack: probe.slackConnected,
    // The project's creator is always a member, so "you invited someone" is
    // strictly MORE than one. `> 0` would tick this step for every project the
    // moment it existed.
    team: probe.memberCount > 1,
    agent: probe.agentCount > 0,
  };
}

/**
 * Open steps first, finished steps after — what is still to do is what you
 * read first, and the completed block settles underneath it.
 *
 * Two filters rather than a comparator, because every property this needs is
 * then true by construction instead of by argument: it cannot mutate the
 * caller's array, `filter` preserves declaration order inside each group, and
 * there is no `Number(...) - Number(...)` to get backwards (which is exactly
 * how a stray `.reverse()` once flipped the whole list).
 */
export function orderStepsOpenFirst<T extends { key: ProjectSetupStepKey }>(
  steps: readonly T[],
  done: Record<ProjectSetupStepKey, boolean>,
): T[] {
  return [...steps.filter((step) => !done[step.key]), ...steps.filter((step) => done[step.key])];
}

/** One key per project, so finishing setup in one project does not hide the
 *  checklist in a brand-new one. */
const STORAGE_PREFIX = 'kortix.project-setup-checklist.';
const storageKey = (projectId: string) => `${STORAGE_PREFIX}${projectId}`;

/**
 * `localStorage`, exposed as a React external store.
 *
 * `useSyncExternalStore` rather than `useState` + an effect for two reasons.
 * `getServerSnapshot` exists precisely for a value the server cannot know, so
 * the hidden/not-hidden answer arrives without a hydration mismatch and
 * without the extra render an effect costs. And `subscribe` gives the
 * cross-tab case for free: dismiss the checklist in one tab and every other
 * tab on the same project drops it too.
 *
 * The cache is not an optimisation — `getSnapshot` runs on every render and
 * must return an `Object.is`-stable value between renders, so it may not touch
 * storage each time.
 */
const hiddenCache = new Map<string, boolean>();
const listeners = new Set<() => void>();

export function subscribeChecklistHidden(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) {
      hiddenCache.clear();
      onChange();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function readChecklistHidden(projectId: string): boolean {
  const cached = hiddenCache.get(projectId);
  if (cached !== undefined) return cached;
  let value = false;
  try {
    value = window.localStorage.getItem(storageKey(projectId)) === 'hidden';
  } catch {
    // Private mode / storage disabled. Showing the checklist is the safe
    // failure: it costs a few cached reads, it does not lose anything.
  }
  hiddenCache.set(projectId, value);
  return value;
}

export function hideChecklist(projectId: string) {
  hiddenCache.set(projectId, true);
  try {
    window.localStorage.setItem(storageKey(projectId), 'hidden');
  } catch {
    // Nothing to persist — the checklist simply reappears next visit.
  }
  for (const listener of listeners) listener();
}

/** The server cannot read the browser's storage, so it answers "unknown" and
 *  every probe stays disabled until the client re-renders with the real
 *  value. Module-level so the snapshot is referentially stable. */
export const CHECKLIST_HIDDEN_UNKNOWN = null;
