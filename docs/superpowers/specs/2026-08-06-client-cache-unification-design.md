# Client Cache Unification Design

**Linear project:** `Perf improvement` (team `Jay`)

**Supersedes:** [Capability Navigation Cache Design](./2026-08-06-capability-navigation-cache-design.md).
That spec diagnosed the capability tabs only, and its fix (commit `58f9e3c586`)
targeted the data layer for a route-layer defect. Its non-goals
"do not enable global dynamic-route caching" and "do not merge the routes" are
withdrawn. The first is now the chosen fix.

## Problem

Data does not persist across navigation anywhere in `apps/web`. Four reported
symptoms, three distinct causes.

1. Switching between Connectors, Skills, and Commands paints the full
   `CapabilitiesSkeleton` on every visit, including return visits.
2. The project title renders differently in two places at once. A hard refresh
   makes them agree.
3. Renaming a project leaves the old name on screen.
4. Project list, sessions list, and session messages refetch on every mount.

## Cause 1 — the route layer always discards the segment

`apps/web/src/app/(app)/projects/[id]/layout.tsx` awaits `cookies()`. Every
route beneath it is dynamic.

Next 16.3 documents the consequence
(`node_modules/next/dist/docs/01-app/02-guides/prefetching.md:61`):

| Context | Prefetched payload | Client cache TTL |
| --- | --- | --- |
| No `loading.js` | Entire page | 5 min (`staleTimes.static`) |
| With `loading.js` | Layout to first loading boundary | Off by default (`staleTimes.dynamic`) |

The same file, line 31: *a dynamic route is skipped unless it has a `loading.js`
boundary*. This is a closed trap.

- Without `loading.tsx`, the route is not prefetched at all.
- With `loading.tsx`, what gets prefetched is the skeleton, and the segment TTL
  is `staleTimes.dynamic`.

`staleTimes` is absent from `apps/web/next.config.ts` (verified:
`grep -c staleTimes` returns `0`), so `dynamic` holds its Next 15+ default of
`0`. Every click discards the segment and repaints the loading boundary.

`prefetch={true}` cannot lift the route into the `static` bucket. The loading
boundary caps what prefetch covers. The same table's third row states dynamic
pages take a server roundtrip on click unconditionally.

Four boundaries are affected: `(capabilities)/loading.tsx`,
`projects/[id]/loading.tsx`, `files/loading.tsx`, `accounts/loading.tsx`.

## Cause 2 — `gcTime` equals `staleTime`

`apps/web/src/app/react-query-provider.tsx:22-23`:

```ts
staleTime: 5 * 60 * 1000,
gcTime:    5 * 60 * 1000,
```

`staleTime` decides when to refetch. `gcTime` decides whether the entry still
exists. Set equal, an unobserved entry is evicted at the same instant it becomes
stale, so no stale-while-revalidate window exists. Returning to a surface after
five minutes always pays a cold fetch.

## Cause 3 — one entity, many keys, no factory

Raw key literals in `apps/web/src`:

| Key | Literal usages |
| --- | --- |
| `['project-detail', id]` | 28 |
| `['projects']` | 27 |
| `['project-sessions', id]` | 23 |
| `['project', id]` | 20 |
| `['project-connectors', id]` | 13 |

`staleTime` is per-observer, not per-key. The 28 `project-detail` sites declare
six different contracts for one cache entry:

| Site | `staleTime` | `refetchOnMount` |
| --- | --- | --- |
| `app/(app)/projects/[id]/page.tsx:38` | 5 min (global) | `false` |
| `app/(app)/projects/[id]/sessions/[sessionId]/page.tsx:136` | 5 min | `false` |
| `features/workspace/project-layout/project-shell.tsx:70` | 5 min | `false` |
| `features/workspace/project-layout/project-home.tsx:278` | 60 s | `false` |
| `features/workspace/project-sidebar/project-switcher.tsx:130` | 5 min | `false` |
| `features/workspace/command-palette.tsx:426` | 60 s | `false` |
| `features/workspace/capabilities/shared/project-detail-query.ts:26` | 10 s | `true` |

Which value governs depends on which pages are mounted. Freshness is
nondeterministic.

The sessions list is worse: `project-sessions-view.tsx:58` declares
`['project-session-inventory', id]` while fourteen other sites use
`['project-sessions', id]`. Lines 152-153 invalidate both, taping over the
divergence instead of removing it.

**Correction, found during implementation.** An earlier draft of this section
claimed the two keys "hold the same server data". That is false, and it matters:

```
project-sessions-view.tsx:141   listProjectSessions(id, { scope: 'project' })   manager-only, unfiltered
project-session-list.tsx:163    listProjectSessions(id)                          default scope, filtered
```

Two different requests returning different result sets. Collapsing them onto one
key would have made them fight — last write wins, so the sidebar could render the
unfiltered inventory and the inventory page could render the sidebar's filtered
list. The governing rule is absolute: **anything that changes the response
belongs in the key.** The `qk` factory therefore carries the scope,
`qk.project.sessions(id, scope?)`, and the two scoped forms are siblings rather
than one entry.

Because they are siblings, invalidation needs the shared prefix
`qk.project.sessionsScope(id)`. An invalidation left on one scoped form is a
silent staleness bug — the same class this work exists to remove.

A third duplicate surfaced with them: `schedule-view.tsx` held
`['project-sessions', id, 'trigger-pin']` over identical default-scope data.

`@kortix/sdk` already ships the correct pattern beside its fetchers —
`kortixKeys`, `taskKeys`, `serviceKeys`, `opencodeKeys`. `apps/web` bypasses it
with 75+ hand-typed literals, which inverts the repo's
"SDK is the source of truth, apps are thin consumers" rule.

## Cause 4 — the project name has two sources

`features/workspace/project-sidebar/project-switcher.tsx:137`:

```ts
activeProject?.name ?? projectDetailQuery.data?.project?.name
```

The left operand reads the `['projects']` list entry. The right reads
`['project-detail']`. `features/workspace/project-layout/project-home.tsx:280`
reads only the second.

Rename invalidates only the list:

- `features/projects/modal/edit-project-modal.tsx:104` invalidates `['projects']`
- `features/workspace/customize/sections/view/settings-view.tsx:221` invalidates
  `['projects']` and `['project-branches', id]`

Neither invalidates `['project-detail', id]`. With `staleTime` 5 min and
`refetchOnMount: false`, the detail entry serves the previous name until
eviction. The switcher shows the new name; the home title shows the old one. A
hard refresh empties both caches, so they agree again.

## Design

Four changes, one pull request. The pull request is made safe by a lint rule
rather than by review attention (see Enforcement).

### 1. Route layer

```ts
// apps/web/next.config.ts
experimental: {
  staleTimes: { dynamic: 300, static: 300 },
}
```

Every page under `projects/[id]` is a client component. Its RSC payload
references a client chunk and carries no rendered data. Caching that payload for
300 seconds carries no staleness cost; page data comes from React Query under a
separate contract. Next confirms layouts are unaffected by segment caching:
shared layouts are not refetched on navigation between siblings.

Every `loading.tsx` stays. It is what makes a dynamic route prefetchable at all,
and it remains the correct cold-navigation state.

### 2. Cache lifetime

`gcTime` rises to `30 * 60 * 1000` in `react-query-provider.tsx`, above every
`staleTime`. This creates the stale-while-revalidate window that currently does
not exist: a return visit renders cached content immediately while any refetch
runs behind it.

### 3. Key factory in `@kortix/sdk/react`

A new module, `packages/sdk/src/react/query-keys.ts`. It is not an extension of
`kortixKeys`, which belongs to the Kortix-Master multi-server surface
(`use-kortix-master.ts:276`) and means a different thing.

**The root segment is `kx`, not `kortix`.** The `kortix` root is already taken:

```
kortixKeys.projects()  = ['kortix', 'projects']       // published
kortixKeys.project(id) = ['kortix', 'projects', id]   // published
```

Rooting `qk` at `kortix` made `qk.projects.list(accountId)` the *same array* as
`kortixKeys.project(id)`, and put every `qk` project key under the
`['kortix', 'projects']` prefix that `use-kortix-master.ts:371,384` already
passes to `invalidateQueries`. TanStack prefix-matches by default, so one
factory's invalidation would have reached the other's entries — a new instance
of the exact bug this work removes, inside a published package. `kortixKeys` is
public API and cannot move; `qk` had no consumers, so `qk` moved. A test asserts
the two factories never prefix each other in either direction.

```ts
export const qk = {
  projects: {
    list: (accountId?: string) => ['kx', 'projects', accountId ?? 'all'] as const,
  },
  project: {
    scope:      (id: string)              => ['kx', 'project', id] as const,
    detail:     (id: string)              => [...qk.project.scope(id), 'detail'] as const,
    sessions:   (id: string)              => [...qk.project.scope(id), 'sessions'] as const,
    session:    (id: string, sid: string) => [...qk.project.sessions(id), sid] as const,
    messages:   (id: string, sid: string) => [...qk.project.session(id, sid), 'messages'] as const,
    connectors: (id: string)              => [...qk.project.scope(id), 'connectors'] as const,
    access:     (id: string)              => [...qk.project.scope(id), 'access'] as const,
    secrets:    (id: string)              => [...qk.project.scope(id), 'secrets'] as const,
    files:      (id: string)              => [...qk.project.scope(id), 'files'] as const,
    // ...one entry per remaining `project-*` family, enumerated in the plan.
  },
} as const;
```

`scope(id)` is a prefix and is never passed as a `queryKey`. It exists so
invalidation has two granularities that flat keys cannot express:

- `invalidateQueries({ queryKey: qk.project.scope(id) })` invalidates every
  query belonging to one project.
- `invalidateQueries({ queryKey: qk.project.detail(id) })` invalidates only the
  detail.

Skills, commands, and agents get **no key of their own**. They are not separate
fetches: `skills-page.tsx:75` reads `detailQuery.data?.config.skills` and
`commands-page.tsx` reads `config.commands` from the same
`['project-detail', id]` entry. They become `select` projections over
`qk.project.detail(id)`, which is what they already are in fact. Inventing keys
for them would add network calls that do not exist today.

The projects list has three literals to collapse, not one: `['projects']` (27),
`['projects', accountId]`, and `['projects-for-account', accountId]`
(`accounts/[id]/groups/[groupId]/page.tsx:968`).

`apps/web` holds 29 distinct `project*` key families across roughly 176 literal
sites. The plan enumerates every family and its target `qk` entry; none is left
on a literal.

### 4. One freshness contract per entity

Declared once beside the key and exported as ready-made `useQuery` option
objects. No call site sets `staleTime` again.

| Tier | `staleTime` | Entities | Invalidation channel |
| --- | --- | --- | --- |
| Live | `Infinity` | session messages, session status | SSE events |
| Config | 60 s | project detail (and its skills, commands, agents projections), connectors, secrets, policies | this app's mutations |
| Inventory | 30 s | project list, sessions list, access, members | mutations and other members |
| Volatile | 5 s | sandbox health, billing, gateway series | time |

`gcTime` is 30 min for every tier. `refetchOnMount` is `false` for every tier:
explicit invalidation is the freshness channel, and a mount is not evidence of
staleness.

### 5. One accessor for the project name

Adding an invalidation to the rename mutation fixes the current symptom and
leaves the cause. Two sources for one fact can diverge again.

`@kortix/sdk/react` gains `useProjectName(projectId)`. `project-home.tsx` and
`project-switcher.tsx` both call it, and the `??` fallback at
`project-switcher.tsx:137` is deleted. One function returns one value, so two
different names on screen becomes structurally impossible rather than merely
currently-invalidated.

Rename additionally writes optimistically. Both the list entry and the detail
entry are updated with `setQueryData` before the request resolves, then
invalidated on settle. The title changes in the frame the modal closes.

### 6. Invalidation helpers

Mutations stop hand-assembling invalidation sets. `@kortix/sdk/react` exports
the declared set per write:

```ts
invalidateProject(qc, projectId)          // whole subtree
invalidateProjectIdentity(qc, projectId)  // list entry + detail entry
```

Rename calls `invalidateProjectIdentity`.

## Enforcement

The migration lands as one pull request. A half-migrated state is prevented by
CI, not by review:

```js
// apps/web/eslint.config.mjs, alongside the existing no-restricted-syntax rule
{
  selector:
    "Property[key.name='queryKey'] > ArrayExpression > " +
    "Literal[value=/^projects?(-[a-z-]+)?$/]",
  message: 'Query keys come from `qk` in @kortix/sdk/react. Never hand-type an entity key.',
}
```

The pattern covers the whole `project*` family — all 29 declared prefixes and
any future one — rather than an allowlist that a new literal could slip past.

After this pull request a raw entity key literal is a lint error. Regression is
a build failure. The reviewable surface is the factory, the contracts, and the
rule; the mechanical call-site edits are proven complete by CI.

## Testing

Verification is by code review, `bun test`, `eslint`, and `tsc`. No browser
driving and no booted stack.

| Layer | Assertion |
| --- | --- |
| SDK keys | `detail(id)` is prefixed by `scope(id)`; every project-scoped key is prefixed by `scope(id)`; `scope(id)` is never returned as a query key |
| SDK contracts | every entity resolves to exactly one tier; every tier sets `gcTime` above its `staleTime` |
| SDK gates | `typecheck`, `test`, `smoke:install` run with output pasted and an explicit shippable YES/NO/NOT YET |
| Rename | the mutation writes both the list entry and the detail entry, and `useProjectName` returns one value at both call sites |
| Provider | `gcTime` exceeds `staleTime` in `react-query-provider.tsx` |
| Next config | `experimental.staleTimes.dynamic` is set and above zero |
| Lint rule | the selector reports a raw literal key and passes a `qk.*` call |
| Repo | `tsc --noEmit` against the known `@types/bun` baseline; `eslint` clean on changed files; `sdk-boundary-baseline.json` shrinks or holds |

SDK work follows the package's mandatory TDD rule: the failing test is written
first, and the task is claimed in `packages/sdk/PROGRESS.md` before
implementation.

## Open questions — resolved

### 1. Cross-account cache partitioning — no code change

`qk` does not carry an identity segment because it does not need one. Traced
all three paths that can change who the cache belongs to:

- **Sign-out**: `AuthProvider`'s `SIGNED_OUT` handler calls `resetClientState()`
  (`apps/web/src/features/providers/auth-provider.tsx:116`), which calls
  `getSharedQueryClient()?.clear()`
  (`apps/web/src/lib/utils/reset-client-state.ts:23`).
- **Sign-in as a different user**: the same `resetClientState()` runs from two
  sites that both diff the previous and new Supabase `user.id` — the initial
  session bootstrap (`auth-provider.tsx:71`) and the `SIGNED_IN` listener
  (`auth-provider.tsx:106`). `registerQueryClient(client)` is called at
  `apps/web/src/app/react-query-provider.tsx:77`, so `getSharedQueryClient()`
  resolves the live client from `AuthProvider`, which is mounted above
  `ReactQueryProvider` and has no other way to reach it.
  Command: `grep -rn "resetClientState()" apps/web/src/features/providers/auth-provider.tsx`
- **Switching the active account within one session** (the org/team switcher —
  same signed-in user, different `account_id`): confirmed this path does
  **not** call `resetClientState()` or `queryClient.clear()` anywhere.
  Command: `grep -rn "setSelectedAccountId" apps/web/src` lists every call site
  (`account-switcher.tsx:104,284`, `projects/page.tsx:154,639`,
  `accounts/page.tsx:146`, `command-palette.tsx:757`, `user-menu.tsx:162`) —
  none is adjacent to a cache clear or an `invalidateQueries` call for
  project data.

  This is not a data-exposure gap, because `qk` already partitions on the
  dimension that matters instead of identity:
  - `qk.projects.list(accountId)` (`packages/sdk/src/react/query-keys.ts:64`)
    takes `accountId` as an explicit key segment, so account A's list and
    account B's list are different cache entries by construction. The two
    real navigation surfaces that read it —
    `apps/web/src/features/workspace/project-sidebar/project-switcher.tsx:108`
    and `apps/web/src/features/workspace/command-palette.tsx:414` — both pass
    the currently active `accountId`, so switching accounts changes the key
    and forces a fresh fetch under the new account's slot.
  - `qk.project.*` (`scope`, `detail`, `sessions`, …) partitions on
    `project_id`, which is the correct key: a project's data is owned by
    exactly one account and does not change meaning depending on which
    account tab the viewer switched through. Project ids are globally unique
    (`crypto.randomUUID()`), so there is no collision surface across accounts.
  - The one call site that queries `qk.projects.list()` with **no** account
    argument, `apps/web/src/features/marketplace/marketplace-project-picker.ts:43`,
    is deliberate and documented in its own header comment: it always resolves
    server-side to the caller's primary account, independent of the account
    switcher, for the one "add to project" modal that wants that behavior.
  - `kortixKeys`'s `identity.userId` segment (`packages/sdk/src/react/use-kortix-master.ts:292,306`)
    solves a different problem — disambiguating *self-hosted Kortix Master
    servers* (`serverUrl` varies) — not multi-account partitioning on the one
    hosted backend `qk` talks to.

  No persisted query cache exists to worry about on top of this: `grep -rln
  "persistQueryClient\|createSyncStoragePersister" apps/web/src` returns
  nothing, so the React Query cache is in-memory-only per page load and a
  `clear()` is exhaustive.

  **Conclusion: no code change to `qk`.** Adding an identity segment would be
  pure overhead — it would not close any real gap, since the actual boundary
  (project id / account id) is already in the key where it needs to be, and
  the actual cross-*user* boundary is closed by `resetClientState()`.

### 2. `router.refresh()` after mutations — none needed

Commands run:

```
grep -rln "await cookies()\|await headers()" apps/web/src/app
find apps/web/src/app/\(app\)/projects -name "*.tsx" | xargs grep -Ln "'use client'"
```

Every `page.tsx` under `projects/[id]` — `page.tsx`, `sessions/page.tsx`,
`sessions/[sessionId]/page.tsx`, `files/page.tsx`, `customize/page.tsx`,
`customize/[section]/page.tsx`, and the three `(capabilities)` pages
(`connectors`, `commands`, `skills`) — is `'use client'`. The only
non-`'use client'` files in the subtree are:

- `projects/[id]/layout.tsx` — the sole `await cookies()` call site. Its own
  header comment states it "deliberately does NOT verify the session" and
  renders "no server-side data of its own (only `cookies()` and `params`)";
  the `cookies()` call exists only to opt the subtree into dynamic rendering,
  not to read anything a mutation changes. Every child (`ProjectAccessBoundary`,
  `LlmCatalogBootstrap`, `ProjectShell`) is `'use client'` and fetches its own
  data through React Query.
- Three `loading.tsx` Suspense-boundary files (`projects/[id]/loading.tsx`,
  `files/loading.tsx`, `(capabilities)/loading.tsx`) — static skeleton markup,
  no data fetch of any kind, nothing for a mutation to make stale.
- `(capabilities)/layout.tsx` and `not-found.tsx` are also `'use client'`.

Outside the `projects/[id]` subtree, `apps/web/src/app/layout.tsx` (root) reads
`headers()` only for desktop-UA and locale detection, and
`apps/web/src/app/admin/layout.tsx` reads a `sidebar_state` cookie for SSR/CSR
parity — neither renders mutation-affected data.
`apps/web/src/app/(auth)/auth/actions.ts` uses `cookies()`/`headers()` inside
Server Actions (login/signup/reset handlers), which mutate rather than render,
so they are out of scope for this question.

**Conclusion: no `router.refresh()` call is needed anywhere.** The 300 s
`experimental.staleTimes.dynamic` (`apps/web/next.config.ts:302`) only matters
for server-rendered dynamic segments, and this app tree has none that display
mutable data — every real page is a client component reading React Query,
which is invalidated directly by the mutations in question.

### 3. Global `refetchOnMount: false` default — investigated, not changed here

Found during Task 11, carried into this task per the brief.
`apps/web/src/app/react-query-provider.tsx:44` sets `refetchOnMount: false` as
the **global** default for every query in the app. `contract(tier)`
(`packages/sdk/src/react/`) overrides it to `true` and is spread at 89 call
sites across 49 files
(`grep -rn "\.\.\.contract(" apps/web/src --include="*.ts" --include="*.tsx" | grep -v "\.test\." | wc -l`).
54 files (119 `useQuery(` call sites) use React Query without `contract()`
(`comm -23` between `grep -rl "useQuery("` and `grep -rl "\.\.\.contract("`
over the same file set) and therefore inherit the global `false`.

The bug Task 11 established: `invalidateQueries` defaults to
`refetchType: 'active'`, so invalidating a query with no mounted observer
marks it stale **without** refetching; `refetchOnMount: false` then serves
that stale value on the next mount for the rest of `gcTime` (30 min).

Cross-referencing every non-`contract()` query family against
`invalidateQueries`/`removeQueries` call sites shows most of them are exposed:

| Exposed (invalidated by a mutation, no per-query override) | Evidence |
| --- | --- |
| `account`, `account-members`, `account-invites`, `account-groups`, `account-tokens`, bare `accounts` | `apps/web/src/app/(app)/accounts/[id]/page.tsx:1080-1090` (`invalidateMembers`), `:933`, `:1122`; `apps/web/src/features/accounts/settings/cli-tokens-tab.tsx:271`; `apps/web/src/features/layout/account-switcher.tsx:283` |
| `iam-sso-provider`, `iam-sso-mappings`, `iam-policies`, `iam-roles`, `iam-pat-policy`, `iam-mfa-required`, `iam-enterprise-demo`, `iam-session-policy`, `iam-sessions`, `iam-permission(-batch)` | `apps/web/src/components/iam/*.tsx` — every card invalidates its own key in its mutation's `onSuccess` |
| `scim-tokens`, `service-accounts`, `audit-webhooks`, `GITHUB_APP_STATUS_KEY` | `apps/web/src/components/iam/scim-card.tsx:213,544`; `service-accounts-card.tsx:83,93,198`; `audit-webhooks-card.tsx:89,98,272`; `github-app-setup-card.tsx:135,163,198` |
| `mfa-factors`, `mfa-aal`, `phone-verification-factors` | `apps/web/src/hooks/auth/phone-verification.ts:12-86`; `apps/web/src/features/accounts/settings/security-tab.tsx:149-150` |
| `auto-topup-settings`, `auto-topup-setup-status` (not the primary `accountState` query — see below) | `apps/web/src/features/billing/auto-topup-card.tsx:138-140` |
| `marketplace-sources`, `marketplace-items`, `marketplaces`, `marketplaces-featured` | `apps/web/src/hooks/marketplace.ts:187-210` |
| `REFERRALS_QUERY_KEYS.stats` | `apps/web/src/hooks/referrals/use-referrals.ts:38` |
| `['sandbox','members',sandboxId]` | `apps/web/src/components/instances/instance-members-panel.tsx:71,83,95,108` |
| `sessionAuditKey`, `agentConfigQueryKey`, channel-binding/installation keys, `qk.project.sessionsScope` reached from `use-session-config-freshness.ts` | `apps/web/src/features/session/session-audit-shared.tsx:170`; `apps/web/src/hooks/projects/use-agent-config.ts:38`; `apps/web/src/hooks/channels/use-channel-bindings.ts:35`, `use-channels-installations.ts:48-174`; `apps/web/src/hooks/projects/use-session-config-freshness.ts:190-213` |

Two queries already carry a correct per-query override and are **not**
exposed: `useAccountState`'s primary hook sets
`refetchOnMount: options?.refetchOnMount ?? true`
(`apps/web/src/hooks/billing/use-account-state.ts:213`), and
`use-session-config-freshness.ts`'s primary `sessionConfigKey` query sets
`refetchOnMount: true` (`:153`).

Not currently exposed (no `invalidateQueries` targets these keys anywhere in
`apps/web/src`, verified by `grep -rn "invalidateQueries" apps/web/src | grep -F
"<key>"` per family): `session-costs`, `cost-explorer`, `entity-files`,
`entity-file-content`, `llm-catalog-providers`, `discover-*`, `connect-status`,
`marketplace-file`, `sso-verify-members`, `scim-verify-members`,
`scim-verify-groups`, `audit`, `audit-projects`, `audit-project-sessions`,
`iam-role-usage`, `iam-role-permissions`, `iam-actions`, `member-groups`,
`iam-member-project-access`, `sandbox-by-id`, `REFERRALS_QUERY_KEYS.code/.list`,
`connector-profiles`, `connector-app-description`, `managed-git-status`,
`github-repositories`, `iam-agent-identities`, `iam-service-accounts`,
`account-projects`, `publicSharesQueryKey`. These are latent, not active: the
moment a future mutation invalidates one of them without adding `contract()`,
it falls into the same trap.

**Severity:** high for the IAM/account-administration cluster specifically —
roles, policies, SSO, SCIM, and MFA are access-control surfaces, so an admin
who edits a role and tabs away can be shown the *pre-edit* permission state
for up to 30 minutes with no visual indication it is stale. Medium for
billing (`auto-topup-*`), marketplace, and referrals. Low for the
currently-unexposed, read-mostly families.

**Recommendation: flip the global default to `refetchOnMount: true`.**
`contract(tier)` already treats `true` as correct for the majority pattern in
the codebase (89 call sites). `refetchOnMount: true` only refetches when data
is past `staleTime` — it does not fetch on every mount — which is exactly the
distinction `use-account-state.ts:211-212`'s own comment draws when explaining
why it chose `true` over `'always'`. The original global-`false` rationale
("most data is kept fresh by SSE events", `react-query-provider.tsx:17-21`)
does not hold for the 54 non-`contract()` files: IAM/account-admin, billing,
marketplace, and referrals have no SSE stream backing them.

**This change was not made in this task.** It flips behavior for every query
in the app that does not use `contract()` or its own override — a blast
radius wide enough to need explicit sign-off rather than a silent flip inside
a "resolve open questions and run gates" task. Flagged as a named follow-up.

## Non-goals

- No Cache Components or React `<Activity>` migration. Route preservation with
  DOM, scroll, and state intact is the correct end state and is a separate
  milestone.
- No change to admin query keys. Roughly 60 literals, different blast radius, no
  reported symptom.
- No SSE or transport changes.
- No re-enablement of `refetchOnWindowFocus`.
- No connector catalog pagination or freshness changes.
