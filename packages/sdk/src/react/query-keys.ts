/**
 * The one place a Kortix query key is constructed.
 *
 * Before this existed, `apps/web` hand-typed roughly 176 key literals across
 * 30 `project*` families. One entity therefore had several cache entries (the
 * flat `project-sessions` key and the flat `project-session-inventory` key
 * held the same server data), and one key had several freshness contracts, because
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
 * The SECOND version of `sessions(id, scope)` fixed that, then introduced a
 * narrower version of the same class of bug: `sessions(id, scope)` and
 * `session(id, sessionId)` were both `sessionsScope(id)` plus exactly one
 * segment, so a session id equal to a scope literal (`'visible'`,
 * `'project'`) would collide byte-for-byte with a scoped list. Nothing in
 * THIS file prevented that — the only thing standing in the way was a UUID
 * regex enforced server-side, in `apps/api`, a different package, with no
 * link back here. `sessions` now inserts a literal `'list'` segment so it is
 * structurally longer than `session(...)` for every possible session id —
 * the collision is unrepresentable, not merely unlikely.
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
  /** The craft STORE — account-scoped, not per-project. */
  crafts: {
    /** Invalidation prefix over every store listing, whatever it searched for. */
    scope: () => ['kx', 'crafts'] as const,

    /**
     * One store listing. The search terms are part of the key because
     * `listCrafts({ q })` is a different SERVER request per term, not a
     * client-side filter of one response — sharing a key would let whichever
     * fetch resolved last overwrite what the other search's readers see.
     * `'all'` stands in for "no search", so an absent option and an explicit
     * `undefined` land on the same entry rather than flickering between two.
     */
    list: (options?: { q?: string; limit?: number; offset?: number }) =>
      [
        ...qk.crafts.scope(),
        'list',
        options?.q?.trim() || 'all',
        options?.limit ?? 'default',
        options?.offset ?? 0,
      ] as const,

    /** One craft's detail. */
    detail: (craftId: string) => [...qk.crafts.scope(), 'detail', craftId] as const,
  },

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

    /**
     * The bare project row — `getProject`, `GET /projects/:id`, a
     * `KortixProject`. NOT `detail(id)` below: `getProjectDetail` hits
     * `GET /projects/:id/detail` and returns a completely different shape,
     * `{ project, config, file_count, files, git_connection }`. An earlier
     * draft of this migration folded the two onto one key because both
     * requests are "about a project" — but they are different requests with
     * different responses, so sharing a key means whichever one resolves
     * last silently overwrites the other's shape: a `data.account_id` reader
     * (this one) would intermittently receive the detail wrapper instead,
     * where the same field lives at `data.project.account_id`. Keep them
     * apart, the same way `sessions`/`session` and `policies`/
     * `executorPolicies` below are kept apart for the identical reason.
     */
    summary: (id: string) => [...qk.project.scope(id), 'summary'] as const,

    detail: (id: string) => [...qk.project.scope(id), 'detail'] as const,
    /**
     * Prefix reserved for config-adjacent sub-resources that do NOT share
     * `getProjectDetail`'s response shape (currently only `modelPicker`
     * below). The project config DATA ITSELF — `ProjectConfigSummary`,
     * i.e. `getProjectDetail(id).config` — is not keyed here: it rides the
     * shared `detail(id)` entry via a `select` projection (see
     * `use-project-config.ts`), because it IS that same response every
     * other detail reader already caches. Keying it separately here would
     * bring back the exact double-fetch this factory exists to remove —
     * `useProjectConfig` used to do exactly that under a standalone
     * `['project-config', id]` key.
     */
    config: (id: string) => [...qk.project.scope(id), 'config'] as const,
    /**
     * `getProjectModelPicker`, `GET /projects/:id/model-picker` — the compact,
     * connection-aware model catalog. LIVE: `useProjectModels` (`use-project-
     * models.ts`) `useQuery`s it directly, rendered at `gateway-view.tsx`,
     * `gateway-routing.tsx`, `gateway-playground.tsx`, `models-tab.tsx`, and
     * `use-session.ts`. `useModelEnablement` (`use-model-enablement.ts`) reads
     * and optimistically writes the SAME entry so a toggle and the picker never
     * disagree. A routing-policy save's `invalidateQueries` targets this key
     * too (`gateway-routing.tsx`) — before the `packages/sdk/src/react`
     * migration that call and every reader above hand-typed the same flat
     * `project-model-picker` array literal independently; an earlier
     * version of this comment called the key "dead" because that literal
     * search only ever turned up the invalidation site, never the readers —
     * they lived one file away, under `packages/sdk/src/react`, which this
     * factory did not yet reach.
     */
    modelPicker: (id: string) => [...qk.project.config(id), 'models'] as const,

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
     * what the caller can see, while `'project'` is the manager-only lifecycle
     * inventory that also includes accessible warm and soft-deleted rows
     * (`apps/api/src/projects/lib/session-inventory.ts`). Neither scope returns
     * sessions the caller cannot open.
     * Before this, both scopes shared one scope-less key, so whichever fetch
     * resolved last silently overwrote what the OTHER scope's readers saw —
     * the sidebar could render the unfiltered manager inventory, or the
     * inventory page could render the sidebar's filtered list. Use
     * `sessionsScope(id)`, not this, for invalidation.
     *
     * The literal `'list'` segment exists so this can NEVER collide with
     * `session(id, sessionId)` below. Without it, both were
     * `sessionsScope(id)` plus exactly one segment — a session whose id
     * happened to equal the string `'visible'` or `'project'` would produce
     * the identical array a scoped list produces, and the two would silently
     * overwrite each other. Session ids are `crypto.randomUUID()`
     * client-side and rejected server-side otherwise
     * (`apps/api/src/projects/lib/sessions.ts`), so that made the collision
     * unreachable, not impossible — safety by an invariant enforced in a
     * DIFFERENT package, with no link back to this file. `'list'` makes
     * `sessions(...)` structurally longer than `session(...)` for every
     * possible session id, which is the same standard this file already
     * applies to the `'kx'` root (see the top doc comment): make the
     * collision unrepresentable, don't rely on another package's validation
     * staying strict.
     */
    sessions: (id: string, scope: 'visible' | 'project' = 'visible') =>
      [...qk.project.sessionsScope(id), 'list', scope] as const,

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
    /**
     * Orphaned pre-existing behavior, migrated verbatim rather than "fixed":
     * three `apps/web` call sites invalidate this slot after a session
     * restart / config reload, and one reads it with `getQueryData`, but no
     * site anywhere `useQuery`s or `setQueryData`s it — so the read always
     * resolves `undefined` and the three invalidations are no-ops today.
     * Nests under `session(id, sessionId)` rather than folding onto it
     * because `session(...)` became a REAL, live query in this same
     * migration (`getProjectSession`); sharing that slot would make these
     * dead invalidations start firing against real session data instead of
     * continuing to hit nothing.
     */
    sessionSandbox: (id: string, sessionId: string) =>
      [...qk.project.session(id, sessionId), 'sandbox'] as const,
    /** `listSessionPrompts` — the session's server-side prompt inbox. */
    sessionPrompts: (id: string, sessionId: string) =>
      [...qk.project.session(id, sessionId), 'prompts'] as const,
    /** `getSessionTurn` — server truth about the turns running right now. */
    sessionTurn: (id: string, sessionId: string) =>
      [...qk.project.session(id, sessionId), 'turn'] as const,

    connectors: (id: string) => [...qk.project.scope(id), 'connectors'] as const,
    /** One connector's config — `getConnectorConfig(id, slug)`. */
    connectorConfig: (id: string, slug: string) => [...qk.project.connectors(id), slug] as const,
    /** One connector's OAuth2 authorization discovery —
     *  `discoverConnectionOAuth2Resource(id, connectionId)`. Keyed by connector
     *  slug, not connection id: the probe reads the connector's server, and the
     *  connection is created on demand to scope it. */
    connectorOAuth2Discovery: (id: string, slug: string) =>
      [...qk.project.connectorConfig(id, slug), 'oauth2-discovery'] as const,

    access: (id: string) => [...qk.project.scope(id), 'access'] as const,
    accessRequests: (id: string) => [...qk.project.access(id), 'requests'] as const,
    pendingInvites: (id: string) => [...qk.project.access(id), 'invites'] as const,
    /** `listProjectGroupGrants` — `GET /group-grants`, `{ grants: ProjectGroupGrant[] }`. */
    groupGrants: (id: string) => [...qk.project.access(id), 'group-grants'] as const,
    /** `listProjectResourceGrants` — `GET /resource-grants`, a DIFFERENT
     *  endpoint and shape from `groupGrants` above; do not fold together. */
    resourceGrants: (id: string) => [...qk.project.access(id), 'grants'] as const,

    secrets: (id: string) => [...qk.project.scope(id), 'secrets'] as const,

    /** Stable App inventory for `GET /projects/:id/apps`. */
    apps: (id: string) => [...qk.project.scope(id), 'apps'] as const,
    /** Access policy and short-lived browser session for one App. */
    appAccess: (id: string, appId: string) => [...qk.project.apps(id), appId, 'access'] as const,
    /** Short-lived browser exchange URL for one App. */
    appAccessSession: (id: string, appId: string) =>
      [...qk.project.appAccess(id, appId), 'session'] as const,
    /** Immutable deployment history for one App. */
    appDeployments: (id: string, appId: string) =>
      [...qk.project.apps(id), appId, 'deployments'] as const,

    /** `listProjectTriggers` — `GET /projects/:id/triggers`, the cron/webhook
     *  listing (file-defined in the repo manifest). Shared by
     *  `useProjectTriggers` (`use-project-triggers.ts`), the Customize
     *  settings pause switch, and the schedule/triggers view — all three read
     *  and write the identical entity through `listProjectTriggers(id)`, so
     *  they must share this one key. */
    triggers: (id: string) => [...qk.project.scope(id), 'triggers'] as const,

    /** What this project has installed, read from its own manifest. */
    crafts: (id: string) => [...qk.project.scope(id), 'crafts'] as const,

    /**
     * Prefix over EVERY craft-runs entry in this project — the all-crafts list
     * and each per-craft report. Siblings, not parent and child, for the same
     * reason `sessionsScope` exists: uninstalling a craft or firing a trigger
     * must reach both in one invalidation, and invalidating only one would
     * leave the other silently showing history that no longer matches.
     */
    craftRunsScope: (id: string) => [...qk.project.scope(id), 'craft-runs'] as const,

    /**
     * Runs across every installed craft. The literal `'all'` segment keeps this
     * from ever colliding with `craftRuns(id, slug)` below — without it a craft
     * whose slug happened to be the string this key ends in would produce the
     * identical array. Same standard the `sessions` key applies: make the
     * collision unrepresentable rather than rely on slugs staying tame.
     */
    craftRunsAll: (id: string) => [...qk.project.craftRunsScope(id), 'all'] as const,

    /** One craft's runs. */
    craftRuns: (id: string, slug: string) =>
      [...qk.project.craftRunsScope(id), 'craft', slug] as const,

    /**
     * `readProjectFile(id, path)` — a single-file source read, used by the
     * Customize config-entity viewer. Unrelated to the much larger Git file
     * browser under `features/project-files/` (its own local key factories,
     * `commitKeys`/`branchKeys`/`changeRequestKeys`, rooted at the literal
     * string `'project-files'` — never migrated onto `qk`, and never sharing
     * this prefix).
     */
    files: (id: string) => [...qk.project.scope(id), 'files'] as const,
    fileSource: (id: string, path: string) => [...qk.project.files(id), path] as const,

    branches: (id: string) => [...qk.project.scope(id), 'branches'] as const,

    /** IAM role policies — `listPolicies(accountId, { scopeId: id })`,
     *  `{ policies: IamPolicy[] }`. NOT the same entity as
     *  `executorPolicies` below — see that member's doc comment. */
    policies: (id: string) => [...qk.project.scope(id), 'policies'] as const,
    /**
     * Executor sandbox tool-execution allow/deny rules —
     * `listProjectPolicies(id)`, `GET /executor/projects/:id/policies`,
     * `ProjectPoliciesResponse`. A DIFFERENT endpoint and a DIFFERENT shape
     * from `policies` above (account IAM role policies) — both used to read
     * the identical literal `['project-policies', id]`, so whichever one's
     * fetch resolved last silently overwrote the other's cache entry with an
     * incompatible shape. Sibling of `policies`, not nested under it: they
     * are unrelated domains that happen to share a name, not a parent/child
     * pair, so invalidating one must never reach the other.
     */
    executorPolicies: (id: string) => [...qk.project.scope(id), 'executor-policies'] as const,

    sandboxes: (id: string) => [...qk.project.scope(id), 'sandboxes'] as const,
    sandboxTemplates: (id: string) => [...qk.project.sandboxes(id), 'templates'] as const,
    snapshots: (id: string) => [...qk.project.scope(id), 'snapshots'] as const,

    /** Prefix for the gateway family — keys, budgets, series, logs, overview. */
    gateway: (id: string) => [...qk.project.scope(id), 'gateway'] as const,
    gatewayOverview: (id: string, days: number) =>
      [...qk.project.gateway(id), 'overview', days] as const,
    gatewaySeries: (id: string, days: number) =>
      [...qk.project.gateway(id), 'series', days] as const,
    gatewayBreakdown: (id: string, days: number) =>
      [...qk.project.gateway(id), 'breakdown', days] as const,
    gatewaySessions: (id: string, days: number) =>
      [...qk.project.gateway(id), 'sessions', days] as const,
    gatewayErrors: (id: string, days: number) =>
      [...qk.project.gateway(id), 'errors', days] as const,
    /** `ok` mirrors `listGatewayLogs`'s optional pass/fail filter — `null` = unfiltered. */
    gatewayLogs: (id: string, ok: boolean | null) =>
      [...qk.project.gateway(id), 'logs', ok] as const,
    gatewayLog: (id: string, logId: string | null) =>
      [...qk.project.gateway(id), 'log', logId] as const,
    gatewayBudgets: (id: string) => [...qk.project.gateway(id), 'budgets'] as const,
    gatewayKeys: (id: string) => [...qk.project.gateway(id), 'keys'] as const,
  },
} as const;

export type ProjectScopeKey = ReturnType<typeof qk.project.scope>;
export type ProjectsListKey = ReturnType<typeof qk.projects.list>;
