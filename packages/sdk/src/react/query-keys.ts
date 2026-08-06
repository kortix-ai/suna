/**
 * The one place a Kortix query key is constructed.
 *
 * Before this existed, `apps/web` hand-typed roughly 176 key literals across
 * 30 `project*` families. One entity therefore had several cache entries
 * (`['project-sessions', id]` and `['project-session-inventory', id]` held the
 * same server data), and one key had several freshness contracts, because
 * `staleTime` is per-observer and seven call sites disagreed about it.
 *
 * Two rules make this work:
 *
 *  1. `scope(id)` is a PREFIX, never a query key. Everything belonging to one
 *     project sits under it, so `invalidateQueries({ queryKey: scope(id) })`
 *     provably reaches all of it.
 *  2. Nothing derived from another query gets its own key. Skills, commands
 *     and agents are `config.*` fields of the project detail response, not
 *     separate fetches — they are `select` projections over `detail(id)`.
 *
 * Not to be confused with `kortixKeys` in `use-kortix-master.ts`, which
 * addresses the multi-server Kortix Master surface and means something else.
 *
 * The root segment below is `'kx'`, not `'kortix'`. `'kortix'` is already
 * `kortixKeys`'s root (`use-kortix-master.ts:276-279`):
 * `kortixKeys.projects() = ['kortix', 'projects']` and
 * `kortixKeys.project(id) = ['kortix', 'projects', id]`. If this factory also
 * rooted at `'kortix'`, `kortixKeys.project(id)` and `qk.projects.list(id)`
 * would be the identical array for a matching id — one cache entry standing
 * in for two unrelated concepts — and `kortixKeys.projects()` (used as an
 * `invalidateQueries` prefix at `use-kortix-master.ts:371,384`) would also
 * match every key this factory produces, since TanStack matches query keys by
 * prefix. `'kx'` makes the two factories disjoint at segment 0, so neither
 * can ever prefix-match the other. Do not "tidy" this back to `'kortix'`.
 */
export const qk = {
  projects: {
    /** Invalidation prefix covering every account's list AND the accountless
     *  slot. Never pass this as a `queryKey` — `list(accountId)` and
     *  `list()` are SIBLINGS (`'<id>'` vs `'all'`), not a parent/child pair,
     *  so `list()` alone does not prefix-match `list(accountId)`. Use this
     *  when a mutation needs to reach every form at once. */
    scope: () => ['kx', 'projects'] as const,

    /** Every project the account can see. `undefined` means the active account. */
    list: (accountId?: string) => [...qk.projects.scope(), accountId ?? 'all'] as const,
  },

  project: {
    /** Invalidation prefix. Never pass this as a `queryKey`. */
    scope: (id: string) => ['kx', 'project', id] as const,

    detail: (id: string) => [...qk.project.scope(id), 'detail'] as const,
    config: (id: string) => [...qk.project.scope(id), 'config'] as const,

    sessions: (id: string) => [...qk.project.scope(id), 'sessions'] as const,
    session: (id: string, sessionId: string) =>
      [...qk.project.sessions(id), sessionId] as const,
    messages: (id: string, sessionId: string) =>
      [...qk.project.session(id, sessionId), 'messages'] as const,

    connectors: (id: string) => [...qk.project.scope(id), 'connectors'] as const,
    access: (id: string) => [...qk.project.scope(id), 'access'] as const,
    secrets: (id: string) => [...qk.project.scope(id), 'secrets'] as const,
    files: (id: string) => [...qk.project.scope(id), 'files'] as const,
    branches: (id: string) => [...qk.project.scope(id), 'branches'] as const,
    policies: (id: string) => [...qk.project.scope(id), 'policies'] as const,
    sandboxes: (id: string) => [...qk.project.scope(id), 'sandboxes'] as const,
    snapshots: (id: string) => [...qk.project.scope(id), 'snapshots'] as const,
    /** Prefix for the gateway family — keys, budgets, series, logs, overview. */
    gateway: (id: string) => [...qk.project.scope(id), 'gateway'] as const,
  },
} as const;

export type ProjectScopeKey = ReturnType<typeof qk.project.scope>;
export type ProjectsListKey = ReturnType<typeof qk.projects.list>;
