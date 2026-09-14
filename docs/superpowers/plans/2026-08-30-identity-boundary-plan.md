# Plan — close the cross-account identity boundary in apps/web

Branch: `identity-boundary` (one worktree, one branch — everything lands together).
Source audit: 61 findings, 14 agents, find → adversarial verify. Artifact:
https://claude.ai/code/artifact/f5596f07-649b-45f4-b279-14632e235194

## The problem (not the solution)

Logging out of Kortix account A and into account B on the same browser leaves A's
identity reachable. Five reported symptoms:

1. B is redirected into A's workspace.
2. `/new` displays A's email address to B. (customer-visible disclosure)
3. B cannot create a project — "you need access to this project".
4. Both happen for one human with two paid accounts.
5. A genuinely-new user does not get the first-run flow.

The owner-bound `kortix_last_project` cookie (`<userId>:<projectId>`,
`landing-destination.ts`) is CORRECT and is deployed (`b2e10a152b`, `v0.13.2`, on
`origin/prod`). It is not the bug. The leak is in the layers above it.

## Global Constraints

- **G1 — No behaviour change for the single-account happy path.** A user who signs
  in, works, and signs out on their own machine must see zero difference apart from
  logout becoming a full document load.
- **G2 — Fail closed on identity.** Wherever identity cannot be established, the
  code must choose the safe branch (the landing door, a blocked submit, a reset) —
  never "assume same user".
- **G3 — An absent marker means UNKNOWN, not SAME.** Every guard of the form
  `if (prev && prev !== next)` is wrong. Absent must trigger the reset.
- **G4 — Structure over cleanup.** Prefer making a leak unrepresentable (identity in
  the key, ownership in the value) over adding another entry to a delete-list.
- **G5 — `packages/sdk` rules apply in full** to any task touching it: failing test
  first, run it, watch it fail, then implement; every turn ends with gates run and
  real output pasted; exported names including types are a public API contract;
  never hand-bump `version`.
- **G6 — Do not weaken existing tests to pass.** `signup-destination.test.ts` and
  `landing-destination.test.ts` encode real contracts. If a change breaks one,
  the change is wrong until proven otherwise in the report.
- **G7 — Verify line numbers before editing.** Every `file:line` below was read at
  plan time and WILL drift as earlier tasks land. Locate by symbol, not by line.
- **G8 — No `pnpm dev` / no browser.** Verify by `bun test`, `tsc --noEmit`,
  `npx eslint <files>`. Per standing instruction, do not boot a stack or drive a
  browser.
- **G9 — Commit per task on `identity-boundary`.** Never push, never open a PR,
  never merge.

---

> Task order is load-bearing: it resolves the file conflicts recorded in the
> pre-flight scan (see the ledger). Do not reorder.

---

## Task 1 — Stop manufacturing an email address in the identity slot

**Why:** symptom 2, and it reproduces on a completely clean browser with no stale
cache. The API stores every personal account as `"a@x.com's Account"`
(`apps/api/src/accounts/core/app.ts` `defaultAccountName`, written by
`bootstrap-personal-account.ts`). `filterCreatableAccounts` strips the possessive
with `.replaceAll("'s Account", '')`, producing the bare string `a@x.com`, and
`AccountPicker` paints that in the slot whose only other value is `user.email`. An
invited admin therefore sees the account owner's address labelled as their own
identity. This is a customer-visible disclosure of one user's email to another.

**Files:** `apps/web/src/features/workspace/new/new-workspace-form.ts`,
`apps/web/src/features/workspace/new/account-picker.tsx`,
`apps/web/src/features/workspace/new/new-workspace-page.tsx`.

**Changes:**
1. In `filterCreatableAccounts`, remove the `.replaceAll("'s Account", '')`. The
   possessive is exactly what tells a reader the account belongs to someone else.
2. In `AccountPicker`, the identity slot must render `fallbackLabel` (the
   authenticated `user.email`) and NEVER an account name. Render the account name
   only as a separate, labelled "Create in" value. Below two creatable accounts,
   show the identity line plus a muted account line — do not collapse them into one
   string.
3. `new-workspace-page.tsx` keeps passing `fallbackLabel={user?.email}`.

**Tests** (`bun test`, colocated):
- `filterCreatableAccounts` given `[{ name: "a@x.com's Account" }]` returns a name
  that still contains `'s Account` — i.e. never the bare email.
- `AccountPicker` label resolution: with `accounts.length < 2` and a non-null
  `fallbackLabel`, the identity line equals `fallbackLabel` and never
  `accounts[0].name`. Assert on the resolution function, not on rendered DOM.

---

## Task 2 — Make `/new`'s account resolver identity-aware

**Why:** symptom 3. `resolveDefaultCreatableAccountId` is documented as
"email match → primary owner → first creatable", but BOTH email branches are dead
code against the real `GET /v1/accounts` shape: it compares `account.name` to a bare
email (the API returns `"…'s Account"`) and `account.slug` to an email (the API
returns `accountId.slice(0, 8)`). The `email` argument is inert, so the function
returns "the first owned account in whatever list it was handed", and `/new` POSTs
that `account_id` with the signed-in user's JWT.

**Files:** `apps/web/src/features/workspace/new/new-workspace-form.ts`,
`apps/web/src/features/workspace/new/use-create-workspace.ts`,
`apps/web/src/features/workspace/new/new-workspace-page.tsx`.

**Changes:**
1. Replace the dead name/slug matching in `resolveDefaultCreatableAccountId` with an
   identity match on `account_id === userId`. Personal accounts use
   `accountId === userId` by construction — VERIFY this in
   `apps/api/src/accounts/core/bootstrap-personal-account.ts` before relying on it
   and state what you found in the report. Change the parameter from `email` to
   `userId`; update every caller.
2. In `new-workspace-page.tsx`: when `creatableAccounts` is non-empty AND `user.id`
   is not present as an `account_id` in it, treat the list as FOREIGN — render no
   account name and block submit (G2, fail closed).
3. In `use-create-workspace.ts`, `resolveTargetAccountId` must assert the resolved
   id is present in the current user's `creatableAccounts` before the POST; throw
   rather than send if not.

**Tests:** the foreign-list case blocks submit; the identity match picks the personal
account; a member-only user with no owned account resolves to `undefined` rather
than a stranger's account.

---

## Task 3 — Make the middleware bounce attributable   (CRITICAL)

**Why:** symptoms 1, 3 and 4 — the only CONFIRMED critical. Middleware writes
`/auth?redirect=<path>` with no identity attached. The guard that would drop a
foreign path runs for signups ONLY: every consumer reads
`isNewUser ? resolveNewAccountReturnUrl(x) : x`. An existing user — which is exactly
what a second paid account is — keeps the raw path and lands in the previous user's
project. It also escapes the browser: `sendEmailCode` bakes that path into the
emailed sign-in link, so it survives to a device that never held the first session.

**Files:** `apps/web/src/middleware.ts`,
`apps/web/src/lib/onboarding/landing-destination.ts` (constants),
`apps/web/src/lib/auth/return-url.ts`,
`apps/web/src/app/(auth)/auth/actions.ts`,
`apps/web/src/app/(auth)/auth/callback/route.ts`.

**Changes:**
1. Add `AUTH_BOUNCE_COOKIE = 'kortix_auth_bounce'` and a 300s max-age beside
   `POST_AUTH_INTENT_COOKIE`.
2. In the middleware branch that redirects an unauthenticated request to `/auth`,
   also set `kortix_auth_bounce=<userId>:<path>`. Take the user id from
   `resolveMiddlewareIdentity` BEFORE the refresh-token self-heal nulls it; if
   unavailable, fall back to the owner half of `kortix_last_project`; if that is
   absent too, write `:<path>` — an empty owner means UNATTRIBUTED.
3. Add `shouldDemoteReturnUrl({ bouncedOwnerId, signedInUserId, isNewUser })` to
   `return-url.ts`. True when `isNewUser`, OR when `bouncedOwnerId` is non-empty and
   differs from `signedInUserId`. An UNATTRIBUTED bounce does NOT demote — that keeps
   a pasted or bookmarked link working, and keeps `signup-destination.test.ts` green
   (G6).
4. Apply at all four consumers: both `isNewUser ? … : …` sites in `actions.ts`, the
   `flowMode === 'signup'` site in `sendEmailCode` (this is the LINK-MINT gate —
   without it the poisoned path still escapes into email), and `callback/route.ts`.
5. Clear the bounce cookie on EVERY successful post-auth redirect — both redirect
   sites in `actions.ts` and the one in `callback/route.ts`. Clearing it only beside
   the existing `ACTIVE_INSTANCE_COOKIE` clear is NOT sufficient: that clear lives
   in `callback/route.ts`, which password and OTP sign-in never touch.

**Tests:** bounced-as-A / signs-in-as-B demotes to `PROJECT_LANDING_PATH`;
bounced-as-A / signs-in-as-A keeps the path; unattributed bounce keeps the path;
`signup-destination.test.ts` and `return-url.test.ts` pass UNMODIFIED.

---

## Task 4 — One `performSignOut()`: hard navigation, error handling, guard repair

**Why:** three defects that all live on the sign-out path, and fixing them
separately would mean rewriting the same three files twice.
(a) All three logout controls are SOFT navigations, so Next's route cache, segment
cache and bfcache survive the identity change — `router.refresh()` does not clear the
route cache, and bfcache reads bypass staleness entirely, so shortening `staleTimes`
cannot substitute. (b) Six sign-out controls have four different cleanups and every
one DISCARDS `signOut()`'s error — on the error path no session is removed, no
`SIGNED_OUT` fires, and nothing is cleared. (c) `SIGNED_OUT` deletes
`kortix-last-user-id`, the exact marker the later `SIGNED_IN` comparison needs, so
the second-chance reset can never fire after an explicit logout.

**Files:** new `apps/web/src/lib/auth/perform-sign-out.ts`;
`apps/web/src/features/layout/user-menu-shared.tsx`,
`apps/web/src/features/workspace/command-palette.tsx`,
`apps/web/src/app/(app)/projects/start/page.tsx`,
`apps/web/src/features/workspace/new/new-workspace-page.tsx`,
`apps/web/src/app/(auth)/auth/phone-verification/page.tsx`,
`apps/web/src/features/providers/auth-provider.tsx`.

**Changes:**
1. `performSignOut()`: call `supabase.auth.signOut()`, READ the `{ error }`, and on
   error retry with `{ scope: 'local' }`; run `await resetClientState()` regardless;
   then `window.location.assign('/auth')`. The hard navigation is what discards
   every Next client cache — do not use `router.push`/`router.replace`.
2. Wire ALL SIX controls to it, including `/new`'s Log out button, which today
   neither awaits nor navigates and strands a signed-out user on the page.
3. `auth-provider.tsx`: delete `safeRemoveItem('kortix-last-user-id')` from the
   `SIGNED_OUT` branch. Change BOTH guards so an ABSENT marker triggers the reset
   (G3). Additionally hold the marker in a `useRef` — the cache it guards is
   per-document, and one origin-wide localStorage key cannot describe several tabs.
   Add an `INITIAL_SESSION` case so a cross-user cold load does not publish the new
   user before the reset lands.
4. Give `/new` the `if (!authLoading && !user) router.replace('/auth')` guard the
   other surfaces have.

**Tests:** the signOut-error path still resets and still navigates; an absent marker
triggers the reset; a source assertion that no logout path uses
`router.push`/`router.replace`. Update the existing nav-contract assertions in
`landing-loop-contract.test.ts` and `new-workspace-page.test.ts` to assert the hard
navigation — update them, do not delete them (G6).

---

## Task 5 — Extend `resetClientState()` to everything identity-bearing

**Why:** `clearUserLocalStorage()` names seven keys; five have had no writer for
months, and it names none of the fifteen persisted stores added since it was
written. `resetClientState()` deletes from disk but resets only ONE in-memory zustand
store — and because sign-out used to be a soft navigation, a surviving module
re-persisted the key that was just deleted. Confirmed leaks include
`kortix-browser-recents` (the last 8 URLs any user browsed in-app, rendered to the
next user as a clickable list) and `kortix.impersonation`.

**Files:** `apps/web/src/lib/utils/clear-local-storage.ts`,
`apps/web/src/lib/utils/reset-client-state.ts`, plus a new test.

**Changes:**
1. Replace the literal delete-list with a PREFIX SWEEP over both `localStorage` and
   `sessionStorage`: remove everything matching the app's own prefixes (`kortix-`,
   `kortix.`, `kortix:`, `kortix_`, `opencode-`, `opencode_`, `files-view-mode`,
   `files-sort-`) behind an explicit KEEP list for genuinely device-scoped values
   (theme, sound preferences, notification permission). Delete the five dead entries.
2. In `resetClientState()`, reset the IN-MEMORY state of every persisted zustand
   store BEFORE the disk sweep, via one `PERSISTED_STORES` array of
   `{ store, initialState }`, so a surviving module cannot re-persist.
3. Add `clearImpersonationSession()` (already exported from `@kortix/sdk` — removing
   the sessionStorage key alone is NOT enough, because `impersonation.ts` holds
   `current`/`hydrated` at module scope), plus `clearAutoProjectSuppression()` and
   `clearLastProjectId()`.
4. `await` the IndexedDB clear properly so a navigation immediately after cannot
   abort it.

**Tests — this test is the point of the task:** walk `apps/web/src/stores/*.ts`,
extract every `persist` `name:`, and FAIL when one is neither covered by the sweep
nor on the KEEP list. A future store must not be able to opt out silently.

---

## Task 6 — Bind `kortix:suppress-auto-project` to its owner

**Why:** symptom 5. Archiving your last workspace writes a bare `'1'` into
sessionStorage. Nothing clears it on sign-out and the flag is process-wide, so the
next user in that tab is told "Your last workspace is archived" instead of being
auto-provisioned a first project.

**Files:** `apps/web/src/lib/onboarding/ensure-first-project.ts`,
`apps/web/src/app/(app)/projects/start/page.tsx`.

**Changes:** store `{ accountId, at }` instead of `'1'`, and make
`isAutoProjectSuppressed(accountId)` require a match — mirroring how the last-project
cookie is bound to its owner. Task 5's sweep is the belt; this is the braces, and it
holds even on a sign-out path that never runs the sweep (G4).

**Tests:** suppression set by account A does not suppress for account B.

---

## Task 7 — Guard the auth-token cache against a stale write-back

**Why:** `getSupabaseAccessToken()` commits `cachedToken = token` after an await with
no generation check, and `setCachedAuthToken(null)` neither bumps a generation nor
clears `inflight`. The audit verdict was PLAUSIBLE, not CONFIRMED — auth-js closes
two of the three orderings that reach it — but it is a missing invariant on the
token path and cheap to close.

**Files:** `apps/web/src/lib/auth-token.ts`.

**Changes:** add a monotonic `authEpoch`; bump it in `setCachedAuthToken` and
`setBootstrapAuthToken`; capture it immediately before `inflight = fetchToken()`;
discard the commit when the epoch changed. Null `inflight` on
`setCachedAuthToken(null)` so piggybacking callers do not inherit a dead fetch.

**Tests:** resolve a deferred `fetchToken` AFTER `setCachedAuthToken(null)` and
assert the result is discarded and `null` returned.

---

## Task 8 — Cookie hardening

**Why:** three independent cookie defects on the auth surface. The Supabase session
cookie is written WITHOUT `Secure` and with a 400-day max-age on production HTTPS —
`@supabase/ssr` never adds it (confirmed by grepping the installed package's
`dist/`), and no `Strict-Transport-Security` header exists anywhere in `apps/web` to
close the cleartext window.

**Files:** `apps/web/src/lib/supabase/client.ts`, `apps/web/src/middleware.ts`,
`apps/web/src/lib/supabase/server.ts`, `apps/web/next.config.ts`, plus the two
privileged cookies.

**Changes:**
1. Add `secure` to all three `cookieOptions` sites:
   `process.env.NODE_ENV === 'production'` server-side and
   `window.location.protocol === 'https:'` client-side, mirroring
   `last-project-cookie.ts`. Do NOT attempt `httpOnly` — `createBrowserClient`
   requires JS read access.
2. Add a `Strict-Transport-Security` header in `next.config.ts`.
3. `kortix-maint-bypass` — an 8-hour privileged capability cookie with no user
   binding and no clear path. Bind it to a user id and clear it in
   `performSignOut()` (Task 4). NOTE: Task 5's storage sweep cannot reach cookies,
   so this must be explicit.
4. `__Secure-kortix_test_access` — the only `Domain`-scoped cookie in the repo, set
   on `.kortix.com`, so dev's middleware writes a cookie that is sent to staging,
   prod and `api.kortix.com`. Scope it to the host that sets it.

NOTE: this task edits `middleware.ts`, which Task 3 also edits — different regions,
but land Task 3 first.

---

## Task 9 — Server: decide the invited-user contract

**Why:** symptoms 1 and 5, reachable with a perfectly clean browser and no
client-state bug at all. `GET /v1/accounts` claims pending invites BEFORE deciding
whether to bootstrap, and the bootstrap is skipped the moment any membership exists —
so an invited user never receives a personal account, and the landing door resolves
straight into the inviter's workspace. Meanwhile
`apps/api/src/shared/resolve-account.ts` DOES bootstrap for a caller with no
membership, so which behaviour you get depends purely on which route reaches the
database first.

**Files:** `apps/api/src/accounts/core/accounts.ts`.

**Change (controller ruling R3):** bootstrap the personal account BEFORE claiming
pending invites, so an invited user ends with both their own account and the org.
Chosen over the alternative (keep today's behaviour, make the landing honest)
because `resolve-account.ts` already bootstraps unconditionally for account-agnostic
callers — bootstrapping first makes the two paths agree instead of introducing a
third behaviour.

**Tests:** an invite-first signup ends with two memberships — their own personal
account and the inviter's org — and the landing door resolves into the personal one.

---

## Task 10 — SDK: put the user id in the query key   (`packages/sdk` — G5 applies IN FULL)

**Why:** the structural cause behind symptoms 2 and 3. No identity-bearing query key
carries the authenticated user: `['accounts']` is a bare literal in 19 call sites,
and `qk` scopes by account, never by user. A stale entry is therefore merely
UNLIKELY rather than UNREACHABLE, and the whole design depends on an imperative
`queryClient.clear()` firing on every path, finishing before anything refetches, and
never being undone. `queryClient.clear()` also leaves mounted observers attached,
which immediately refetch.

**RUNS LAST** — it touches call sites that Tasks 1, 2 and 4 rewrite.

**Files:** `packages/sdk/src/react/query-keys.ts` and its exports; then the 19
`['accounts']` call sites in `apps/web`.

**Changes:**
1. Thread `userId` through `qk.projects.scope()`, `qk.project.scope()` and every
   member. `use-kortix-master.ts` already ships this shape — follow it exactly.
2. Add `qk.accounts.list(userId)` and retire the bare `['accounts']` literal
   everywhere, including the `invalidateQueries` call sites.
3. Add `enabled: !!user` to the readers that lack it — at least `user-menu`,
   `account-switcher`, `use-ensure-selected-account`, `account-memberships`,
   `new-workspace-page`, `use-create-workspace`, `workspace-menu-section`, and
   `accounts/settings/general-tab`.

**This is the highest-risk task.** TDD is mandatory and non-negotiable. Adding an
export requires three synchronized edits. Renaming an exported name INCLUDING A TYPE
is a breaking change. Never hand-bump `version`. If the blast radius proves larger
than this plan assumes, STOP and report rather than half-migrating — a partial key
migration is worse than none, because two keyspaces for one resource is a cache
correctness bug in its own right.
