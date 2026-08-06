/**
 * The one place a Kortix query key is constructed.
 *
 * Before this existed, `apps/web` hand-typed roughly 176 key literals across
 * 30 `project*` families. One entity therefore had several cache entries
 * (`['project-sessions', id]` and `['project-session-inventory', id]` held the
 * same server data), and one key had several freshness contracts, because
 * `staleTime` is per-observer and seven call sites disagreed about it.
 *
 * The first version of `sessions(id)` repeated that exact mistake one level
 * down: it dropped `listProjectSessions`'s `scope` argument, so a
 * `scope: 'visible'` reader and a `scope: 'project'` reader (a DIFFERENT
 * server request — see `sessions` below) shared one cache slot, and
 * whichever fetch resolved last silently overwrote what the other scope's
 * readers saw. Anything that changes the response MUST be part of the key —
 * that is the rule this file exists to enforce, and it is not optional just
 * because the argument is easy to forget.
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

    /**
     * Invalidation prefix for the WHOLE sessions family: the list, in every
     * scope, and every individual session/message beneath it. Never pass
     * this as a `queryKey` — pass it to `invalidateQueries` at every site
     * that means "the sessions list changed" (create/rename/delete/restart/
     * stop/share). `sessions(id)` and `sessions(id, 'project')` are SIBLINGS,
     * not parent and child (see `sessions` below) — invalidating one alone
     * would leave the other silently stale, and this prefix is the only form
     * that reaches both in one call.
     */
    sessionsScope: (id: string) => [...qk.project.scope(id), 'sessions'] as const,

    /**
     * The sessions list. `scope` is part of the key ON PURPOSE:
     * `listProjectSessions(id, { scope })`
     * (`core/rest/projects-client/sessions.ts`) is a DIFFERENT server
     * request per scope, not a client-side filter of one response —
     * `'visible'` (the default; matches passing no `options` at all) returns
     * what the caller can see, `'project'` is the manager-only unfiltered
     * full inventory (`apps/api/src/projects/lib/session-inventory.ts`).
     * Before this, both scopes shared one scope-less key, so whichever fetch
     * resolved last silently overwrote what the OTHER scope's readers saw —
     * the sidebar could render the unfiltered manager inventory, or the
     * inventory page could render the sidebar's filtered list. Use
     * `sessionsScope(id)`, not this, for invalidation.
     */
    sessions: (id: string, scope: 'visible' | 'project' = 'visible') =>
      [...qk.project.sessionsScope(id), scope] as const,

    /**
     * One session, by id. Nests directly under the scope-LESS
     * `sessionsScope` prefix, not under a specific `sessions(id, scope)`
     * slot: a session is not "owned" by whichever list scope happened to
     * discover it (the same session id is reachable via either scope), so
     * its own cache entry does not carry a scope segment either.
     */
    session: (id: string, sessionId: string) =>
      [...qk.project.sessionsScope(id), sessionId] as const,
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
