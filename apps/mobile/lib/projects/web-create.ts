/**
 * What changed while the user was creating on the web (KRTX-246). Mobile
 * snapshots the ids before it opens the browser and diffs the fresh lists
 * after: a project that did not exist before is the one to open, an account
 * that did not exist before is the one the switcher shows. Pure, bun-tested
 * (`web-create.test.ts`).
 */

/** The most recently created project, or null. `/new` offers it as "Open <project>". */
export function newestProject<T extends { created_at: string }>(projects: readonly T[]): T | null {
  let newest: T | null = null;
  for (const project of projects) {
    if (!newest || Date.parse(project.created_at) > Date.parse(newest.created_at)) newest = project;
  }
  return newest;
}

/** The newest project in `after` whose id is not in `beforeIds`, or null. */
export function newestAddedProject<T extends { project_id: string; created_at: string }>(
  beforeIds: readonly string[],
  after: readonly T[]
): T | null {
  const before = new Set(beforeIds);
  return newestProject(after.filter((project) => !before.has(project.project_id)));
}

/** The first account in `after` whose id is not in `beforeIds`, or null. */
export function addedAccount<T extends { account_id: string }>(
  beforeIds: readonly string[],
  after: readonly T[]
): T | null {
  const before = new Set(beforeIds);
  return after.find((account) => !before.has(account.account_id)) ?? null;
}

export interface WebCreateSnapshot<A, P> {
  accounts: A[];
  projects: P[];
}

export interface WebCreateOutcome<A, P> {
  /** The newest project that did not exist before; null without a before-snapshot. */
  project: P | null;
  /** The first account that did not exist before; null without a before-snapshot. */
  account: A | null;
  /** The fresh lists after return, or null when they could not load. */
  after: WebCreateSnapshot<A, P> | null;
}

export interface WebCreateDeps<A, P> {
  /** Every account and every account's projects, fetched fresh. */
  fetchSnapshot: () => Promise<WebCreateSnapshot<A, P>>;
  /** Opens the page; resolves when the user closes the browser, rejects when it cannot open. */
  openBrowser: (url: string) => Promise<unknown>;
  /** Marks accounts + projects stale (the app's React Query caches). */
  invalidate: () => void;
  onPendingChange?: (pending: boolean) => void;
}

/**
 * One web create round trip (`useWebCreateHandoff`), dependency-injected so
 * its order is bun-tested:
 *  1. the before-snapshot starts while the browser opens (opening never
 *     waits on the network);
 *  2. the browser closes;
 *  3. the before-snapshot is awaited BEFORE invalidating, so invalidation
 *     cannot cancel its in-flight fetches;
 *  4. invalidate, then the after-snapshot;
 *  5. diff. A failed before-snapshot still returns `after`, so first run can
 *     open the newest project across every account.
 * One run at a time: a run while another is in flight returns nothing.
 */
export function createWebCreateRunner<A extends { account_id: string }, P extends { project_id: string; created_at: string }>(
  deps: WebCreateDeps<A, P>
) {
  const nothing = (): WebCreateOutcome<A, P> => ({ project: null, account: null, after: null });
  let pending = false;

  async function run(url: string): Promise<WebCreateOutcome<A, P>> {
    if (pending) return nothing();
    pending = true;
    deps.onPendingChange?.(true);
    try {
      const before = deps.fetchSnapshot().catch(() => null);
      try {
        await deps.openBrowser(url);
      } catch {
        // The browser failed to open: nothing was created.
        return nothing();
      }
      const prev = await before;
      deps.invalidate();
      const next = await deps.fetchSnapshot().catch(() => null);
      if (!next) return nothing();
      if (!prev) return { project: null, account: null, after: next };
      return {
        project: newestAddedProject(
          prev.projects.map((p) => p.project_id),
          next.projects
        ),
        account: addedAccount(
          prev.accounts.map((a) => a.account_id),
          next.accounts
        ),
        after: next,
      };
    } finally {
      pending = false;
      deps.onPendingChange?.(false);
    }
  }

  return { run, isPending: () => pending };
}
