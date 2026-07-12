# `@kortix/sdk`

Read `../../AGENTS.md` first — it covers the monorepo (worktrees, the local
stack, verification standard, release topology). This file covers only what is
specific to **this package**, and the traps that have no analogue elsewhere in
the repo.

> ### Four rules before you touch anything
>
> 0. **Read `packages/sdk/PROGRESS.md` first, and update it before you finish.**
>    Multiple sessions run against this repo. It tracks what is done, what is in
>    flight, and what is next. Claim a task before you work on it.
> 1. **Write the failing test first.** Invoke the `tdd` skill (`/tdd`) before any
>    implementation code. RED → GREEN → REFACTOR, no exceptions. *A test you have
>    never seen fail is not a test.*
> 2. **Never hand back a red suite.** Loop — run, read, fix, re-run — until every
>    test passes. **Loop on the code, never on the test.** Deleting, skipping,
>    weakening, or filtering a test to reach green is forbidden. If the test
>    itself is wrong, or it caught a *pre-existing* bug, stop the loop and say so.
> 3. **Run the gates and paste the output before you answer.** `typecheck` +
>    `test` + `smoke:install`. Then state plainly: **is this shippable to
>    production — YES, NO, or NOT YET?** Never "should work". Never "looks
>    correct".
>
> This package is on npm. A mistake here lands in a stranger's build, not in your
> PR. See **Test-driven, always** below.

## The mental model: what this SDK actually is

Learn this once and most questions answer themselves.

**This SDK talks to two completely different upstreams and hides the seam.**

1. **The Kortix platform REST API** (`backendUrl`, e.g. `http://localhost:8008/v1`).
   Owns everything *about* your work: accounts, projects, sessions, secrets,
   billing, triggers, marketplace, audit. Lives in `platform/projects-client/` and
   `platform/platform-client/`, over `platform/api-client.ts` (`backendApi`).

2. **The session runtime** — an ACP harness process plus daemon helpers running
   *inside a per-session cloud sandbox*. Owns everything *happening in* your
   work: messages, parts, tools, permissions, files, PTY, git. It is reached
   through Kortix runtime/ACP clients and the Kortix API proxy — never through a
   native harness SDK in host code:

   ```
   ${backendUrl}/projects/{projectId}/sessions/{sessionId}/acp  → ACP JSON-RPC bridge
   ${backendUrl}/p/{externalId}/{port}                          → daemon/runtime helpers
   ```

**The bridge between them is session readiness.** A session's runtime does not
exist until its sandbox is provisioned or resumed. That is what `ensureReady()`
(and `start()`, and implicitly `send()`) does: boots/resumes the sandbox, resolves
*this* session's runtime and ACP conversation id.

```ts
const kortix = createKortix({ backendUrl, getToken })   // ← one client, one auth seam
await kortix.projects.list()                            // ← upstream 1: platform REST
const s = kortix.session(projectId, sessionId)
await s.ensureReady()                                   // ← the bridge
await s.send('what files are here?')                    // ← upstream 2: the runtime
```

Call `s.previewUrl(3000)` before `ensureReady()` and you get `SessionNotReadyError`.
That is deliberate, and it is the single most important invariant in the package:

> **Handles are session-scoped and never fall back to whatever sandbox happens to
> be globally active.** A `session(a, b)` handle resolves *its own* runtime or it
> throws. Silently borrowing another session's sandbox is the worst bug this
> codebase can have — it sends a user's prompt into someone else's machine.

**Auth is exactly one seam:** `getToken`. It returns a Kortix PAT
(`kortix_pat_…`) for programmatic use, or a Supabase JWT for a logged-in web
user. Everything else — REST calls and the proxied runtime alike — flows through
`authenticatedFetch`, which attaches it. There is no second auth path. Do not add
one.

### The layers, bottom to top

```
platform/auth + platform/api-client   ← transport: token, fetch, ApiError
platform/*-client                     ← typed REST surfaces (one file per domain)
runtime/client                        ← the runtime helper client, base-url'd at the proxy
acp/client                            ← ACP JSON-RPC client for conversations
state/event-stream                    ← SSE reconnect/backoff/heartbeat/coalesce
kortix.ts (createKortix)              ← the facade: binds ids, hides the seam
turns/                                ← normalizes ~50 wire part types → ClassifiedPart
react/                                ← optional glue. Nothing below this line knows React.
```

`turns/` deserves a note: runtime/harness wire formats are normalized before they
reach renderers. `turns/` collapses them into a compile-time-**exhaustive**
`ClassifiedPart` union so a renderer can `switch (part.kind)` and have
TypeScript prove no case is missed. It is framework-free on purpose —
`examples/04` renders a transcript to plain text with the exact same code
`whitelabel-demo` renders to React.

### Recipe: adding a new capability, end to end

Follow the grain. Almost every feature is this shape:

1. **REST function** in `platform/projects-client/<domain>.ts`. Typed request and
   response, called through `backendApi`. Colocate `<domain>.test.ts`.
2. **Export it** from that directory's barrel.
3. **Wire it into the facade** in `kortix.ts` as a *direct reference*
   (`create: P.createThing`) — not a wrapper. Direct references keep the exact
   types with zero re-typing, which is why the facade is 941 lines and not 4000.
4. **Reactive?** Then, and only then, add a hook in `react/` over the client fn.
   The client fn must exist first and must work without React.
5. **New public name?** Re-read the naming rules below. It is forever.

### The invariants, in one place

- **Session-scoped, never global.** See above. Never resolve a runtime from
  ambient state.
- **Provider-agnostic.** "Sandbox" and "daytona" are server-side concerns. Client
  code must never branch on the provider.
- **Hosts never import native harness SDKs.** Not `@opencode-ai/sdk`, not a
  Claude/Codex adapter package. If a host needs runtime access, it goes through
  `session.runtime` or the SDK ACP session surface.
- **Hosts never raw-`fetch` the Kortix API.** If the SDK doesn't expose it, add it
  to the SDK.
- **The core never imports a framework.** Enforced statically. See the tripwire.
- **`session_id == sandbox_id`.** The runtime is reached at
  `/p/{externalId}/{port}`, never at a bare sandbox URL.

## This package is published. People install it.

`@kortix/sdk` is **live on npm** (`npm view @kortix/sdk version`). It is not an
internal workspace library that happens to have a `package.json`. Code you
change here reaches installs you cannot see and cannot fix forward.

That has one practical consequence that should govern every edit: **the public
surface is a promise, and the promise is enforced by tests, not by intent.**
Before changing anything reachable from the `exports` map, ask what an external
consumer pinned to the current major would experience. If the answer is "their
build breaks", it needs a deprecation path, not a rename.

## Exported names ARE the API. Renaming one breaks every consumer.

The single most common way to break this package is to rename something while
"just cleaning up". A rename compiles, passes every unit test, typechecks the
whole monorepo — and detonates in someone else's project on `npm install`.

**Every identifier reachable from a public entry point is public API**, whether
or not it looks like one:

- functions and factories — `createKortix`, `classifyTurn`
- classes — `ApiError`, `SessionNotReadyError`
- **types and interfaces** — `KortixProject`, `SessionHandle`, `ClassifiedPart`.
  A renamed type breaks `import type { … }` exactly as hard as a renamed
  function. Types are not "internal because they erase at runtime".
- React hooks and components exported from `./react` — `useSession`
- string-literal union members, enum members, and object keys returned from a
  public function (`turn.kind === 'reasoning'`)

If a consumer can type it after `import {`, you own it.

### What is safe, and what is not

| Change | Safe? |
|---|---|
| Adding a new export | ✅ additive |
| Moving a file inside `src/`, updating `exports` to match | ✅ invisible — the `exports` map decouples path from name |
| Renaming a symbol that is never exported | ✅ |
| Widening a parameter type, narrowing a return type | ✅ |
| **Renaming any exported symbol** | ❌ breaking |
| **Renaming a `type` or `interface`** | ❌ breaking |
| **Changing a string-literal union member** | ❌ breaking |
| Removing an export | ❌ breaking |
| Making an optional field required | ❌ breaking |

Note the second row: **internal file layout is free to change; public names are
not.** These are independent. You can restructure `src/` completely without
touching a single consumer, as long as `exports` still resolves and the names
that come out the other side are unchanged.

### If you must rename, alias — never replace

Keep the old name working, mark it, and delete it only on a major:

```ts
// core/rest/projects.ts
export interface Project { /* … */ }

/** @deprecated Renamed to `Project`. Removed in the next major. */
export type KortixProject = Project;
```

A rename without an alias is not a refactor, it is a breaking change wearing a
refactor's clothes.

### Name it right the first time

Renames are expensive, so front-load the thinking. Conventions for this package:

- **Factories** are `createX` (`createKortix`). **Errors** are `XError` extending
  `Error` (`ApiError`). **Hooks** are `useX`. Types are `PascalCase`, never
  `IFoo`.
- **For NEW names, don't prefix with `Kortix`** unless the bare name would collide
  with a common global or DOM type (`File`, `Event`, `Response`, `Request`).
  `KortixFile` is legitimate; a bare `Session` is not.
  **But never rename an already-published name just to satisfy this rule.** A
  rename costs consumers real breakage; a slightly-verbose name costs nothing.
  Additive is free, subtractive is a major — that asymmetry outranks style. This
  is why `KortixProject` keeps its name (see below).
- **A prefix earns its keep when it disambiguates.** `KortixProject` (the platform
  entity) and `KortixMasterProject` (the sandbox daemon's board project) are two
  genuinely different concepts. Here the prefix is doing real work.
- **No abbreviations** in public names. `configuration` over `cfg`, `session`
  over `sess`.
- **Every public name must be globally unique across the whole surface.** With a
  single root barrel this is enforced by the compiler — two modules exporting the
  same name is a `TS2308` build error, not a silent shadow.

> **`KortixProject` was declared twice** — the platform project
> (`platform/projects-client/projects.ts`, keyed `project_id`/`account_id`/`repo_url`)
> and the kortix-master daemon's board project (`opencode/kortix-master.ts`, keyed
> `id`/`path`/`opencode_id`/`structure_version`). Same word, unrelated concepts;
> the split subpath surface hid the clash for months.
>
> **Resolved:** the platform type keeps `KortixProject`. The daemon type becomes
> `KortixMasterProject`, with `export type KortixProject = KortixMasterProject`
> retained as a `@deprecated` alias on the `opencode-client` shim so no importer
> breaks. This is the alias-never-replace rule applied to itself.

### The guardrail that actually enforces this

Documentation gets skimmed. The rule is enforced by a **committed snapshot of
every public export name**, asserted in CI. Renaming, removing, or adding an
export changes the snapshot, and the diff lands in code review where a human
decides whether it is additive (fine) or breaking (needs an alias and a major).

Treat a snapshot diff as a question — *"did I mean to change the public API?"* —
not as a test to re-record until it goes green.

## Versioning: never touch the `version` field

`packages/sdk/package.json` has `"version": "0.2.0"`. **It is inert.** Nothing
reads it.

At publish time `scripts/stage-npm-publish.mjs` overwrites it:

```js
// scripts/stage-npm-publish.mjs
pkg.version = version;  // ← from $VERSION, i.e. the root VERSION file
```

The SDK ships **in lockstep with the platform release**. The root `VERSION` file
is the single source of truth; `deploy-prod.yml` → `scripts/publish-npm-package.sh`
stamps it in.

- **Do not** bump `version` in `packages/sdk/package.json`. It is a no-op.
- **Do not** write a plan step that says "bump the SDK to `x.y.z`". Releases bump
  the SDK; the SDK does not bump itself.
- A version *below* the current npm `latest` would publish but never become
  `latest`, silently stranding every consumer on `^`-range installs.

Publishing is idempotent (re-running a release skips a version already on npm)
and auth'd via Trusted Publishing/OIDC, falling back to `NODE_AUTH_TOKEN`. With
neither, it skips cleanly rather than failing the release.

## The core law: the core is framework-free

The root barrel (`@kortix/sdk`) and most subpaths must run in a browser
`<script>` tag, a React Native app, a Node CLI, and a Cloudflare Worker —
**with no framework in the import graph at all**. React and React Native are
*optional layers on top*, never a dependency of the core.

This is not a style preference. It is asserted statically by
`src/index.isomorphic.test.ts`, which walks the **full relative-import graph**
of every entry point and fails on a forbidden specifier — including
`import type`, because a type-only import still forces the dependency onto every
consumer's `tsc` run.

### The three tiers

Every non-React subpath is classified in `SUBPATH_TIERS`
(`src/index.isomorphic.test.ts`). Pick the right one when you add an export.

| Tier | Entry points | Forbids |
|---|---|---|
| `isomorphic-core` | root `.`, `./session`, `./turns`, `./files`, `./event-stream`, most clients | `react`, `react-dom`, `next`, `zustand`, `@tanstack/react-query`, `'use client'`, **any `node:` import** |
| `node-allowed` | `./server` only | same, except `node:async_hooks` is permitted (per-request config isolation) |
| `browser-only` | `./sync-store`, `./server-store`, `./sandbox-connection-store`, `./opencode-pending-store`, `./idb-sync-cache` | only `react` / `react-dom` / `next`. zustand and `window`/`localStorage`/`indexedDB` are expected here |

If a test named `<subpath> (<tier>): no forbidden framework imports` fails, you
did not "break a lint rule" — you broke the package for a host that has no
React, and the tripwire caught it. Fix the import; do not widen the tier.

### The tripwire walks imports. It cannot see globals.

This is its one blind spot, and React Native is how you fall into it. `process`,
`window`, `document`, `localStorage` are **globals, not imports** — nothing in the
import graph reveals them. So a green tripwire proves the core is free of
framework *imports*; it does **not** prove the core *runs* on RN or in a
`<script>` tag.

Touching a bare `process.env` on a non-Next host throws a **`ReferenceError`**, not
`undefined`. The SDK knows this — `platform/feature-flags.ts:14` says so and ships
`safeEnv()` for it. Use it. Guarded reads are the rule:

```ts
if (typeof window !== 'undefined' && window.location?.origin) { … }   // ✅ kortix.ts:102
const url = process.env.BACKEND_URL || …                              // ❌ shared.ts:29
```

**Never introduce a bare global into `core/`.** Guard it, or inject it.

### The `browser-only` tier is internal machinery

Those five zustand stores are consumed only by `apps/web`, via thin
`export * from '@kortix/sdk/…'` shims in `apps/web/src/stores/`. Nothing
third-party should build on them, and they are **not** exposed on the
`window.Kortix` global. Treat them as implementation detail that is
regrettably visible, not as a designed API.

## Adding or moving an export requires three synchronized edits

Miss one and CI fails — by design. There is no single source of truth for the
export map, so the tripwire manufactures one.

1. **`package.json` → `exports`** — the workspace path, which must be exactly
   `./src/<file>`.
2. **`package.json` → `publishConfig.exports`** — the published path, `./dist/<file>.js`
   plus its `.d.ts`. Workspace consumers resolve `src/`; npm consumers resolve
   `dist/`. Both must exist.
3. **`SUBPATH_TIERS`** in `src/index.isomorphic.test.ts` — name, entry file, tier.

The test `SUBPATH_TIERS matches package.json exports (minus "." and "./react")`
asserts (1) and (3) are set-equal *and* that each `exports` value literally
equals `./src/<file>`.

For (2), know exactly what is and is not covered:

- ✅ `scripts/stage-npm-publish.mjs:60-80` runs on every PR and fails if any path
  in `publishConfig.exports` is **missing from the emitted `dist/`**.
- ✅ `src/package-exports.test.ts:15-21` asserts `exports` and
  `publishConfig.exports` declare the **same key set** (and that each
  `publishConfig` entry carries both `types` and `import`). Add `./foo` to one
  map and forget the other, and this test goes red — before `npm install
  @kortix/sdk` can ship a subpath that resolves in the workspace but not on npm.
- ✅ `scripts/smoke-install.mjs` — run in CI as the step **"Install smoke test"**,
  or locally via `pnpm --filter @kortix/sdk run smoke:install` — packs the
  tarball, installs it into a throwaway project, and imports it, so a resolution
  or runtime failure in the published artifact fails a PR instead of a stranger's
  build.

So both of those old gaps are now guarded — but a green CI is still not a promise
the package is *perfect*. Nothing loads the IIFE global in a real browser, and the
runtime-target matrix (Safari, RN, Workers) is only partly exercised. Read the
diff; don't outsource the judgment to the checkmarks.

`./react` is deliberately excluded from the tripwire. It is the one place React
belongs.

## Dual entrypoint: `src/` in the workspace, `dist/` on npm

```jsonc
"main": "./src/index.ts",              // workspace: TS source, no build needed
"publishConfig": {
  "main": "./dist/index.js",           // npm: compiled ESM
  "types": "./dist/index.d.ts"
}
```

`npm view @kortix/sdk main` returns `./dist/index.js`, so the swap works today.
`scripts/smoke-install.mjs` (CI step **"Install smoke test"**, or `pnpm --filter
@kortix/sdk run smoke:install`) now exercises an actual *install* — it packs,
installs the tarball into a throwaway project, and imports it — so this swap is no
longer unguarded. It is still the subtlest thing a refactor can quietly break, so
when you touch entry points, run it: `npm pack` → install the tarball into a
throwaway project → `import` it is exactly what it does.

## Workspace dependencies get pinned at publish

`stage-npm-publish.mjs` rewrites every `workspace:*` dependency to the concrete
lockstep version. `@kortix/llm-catalog` is `workspace:*` here, so it **must** be
published at the same version or `npm install @kortix/sdk` fails to resolve.
Adding a new `workspace:*` dependency to this package therefore also means making
that package publishable. Prefer not to.

`react` and `@tanstack/react-query` are **optional peer dependencies**. Never
promote them to `dependencies`.

## Streaming is the fragile part. Treat it as a first-class target.

Live SSE streaming (`session.stream()` → `openEventStream` → `client.global.event()`)
is the single most breakable surface in this package, because it is the only one
that depends on **streaming-body support in the host's `fetch`** — a thing that
differs across every runtime we claim to support.

The transport is **not** `EventSource`. It uses `fetch` with a real
`ReadableStream` body plus `TextDecoderStream`. Reconnect, backoff, heartbeat,
and event coalescing are ours (`state/event-stream.ts`); harness-specific SDKs
must not own browser streaming behavior.

| Target | Streams? | Notes |
|---|---|---|
| Modern browsers | ✅ | `TextDecoderStream` needs **Safari 16.4+** |
| Node ≥ 18 | ✅ | `fetch` + `TextDecoderStream` are global |
| Bun | ✅ | |
| Cloudflare Workers | ✅ | |
| **React Native / Expo** | ❌ **not supported** | RN's `fetch` has no `response.body`; Hermes has no `TextDecoderStream`. The SDK's streaming **cannot run on RN today.** |

**This SDK ships to three hosts: `apps/web`, `apps/mobile` (RN/Expo), and
`apps/whitelabel-demo`.** A change that works on web and breaks the others is a
broken change, not a partial one.

> **Do not claim React Native streaming support** — in the README, the docs, or a
> PR description. It does not work. `apps/mobile` streams today only because it
> **bypasses the SDK entirely**: `apps/mobile/lib/opencode/event-stream.ts` is
> **655 lines** reimplementing reconnect/backoff/heartbeat/coalescing on
> `react-native-sse`'s `EventSource`, beside the SDK's own 571-line version. Two
> divergent copies of the most failure-prone logic in the product.
>
> It happened because the SDK left **no transport seam**. The fix — extracting an
> injectable `EventStreamTransport`, so the platform-specific part is only *how
> bytes arrive* and never the reconnect logic — is designed in
> `docs/superpowers/specs/2026-07-10-sdk-v2-structure-and-distribution-design.md`
> and deliberately deferred.
>
> **Do not add a third copy.** If a host needs a different wire, build the seam.

> **Bundler trap.** Native harness SDKs and adapter packages commonly pull
> Node-only modules. Never let a host build resolve them into a browser bundle.
> Harness packages belong in the sandbox image/daemon layer, not `@kortix/sdk`
> host code.

Streaming is not "done" because a unit test passes. It is done when it has been
observed delivering events in **each distribution target you claim** — the ESM
`dist/`, the CDN ESM bundle, and the `window.Kortix` IIFE global.

## Field notes: what actually keeps an SDK maintainable

Longer-lived guidance than any single task. If you read one section twice, this one.

**An SDK's job is to be boring.** An app can be refactored on a whim because you
own every caller. A library cannot: your callers are strangers, on their own
schedule, and they will not read your changelog. The asymmetry is the whole game.
Optimize for *not needing to change* over *being easy to change*.

**The public surface is the product.** Internals can be ugly and get fixed later.
A bad public name is forever, or costs a major to undo. Spend your care at the
boundary, in this order: the names, then the types, then the implementation.

**Additive is free; subtractive is a major.** Adding an export, widening a
parameter, adding an optional field — all safe, ship freely. Removing, renaming,
narrowing, or making a field required — all breaking, always. When in doubt about
whether a change is breaking, ask: *"could a consumer's code stop compiling?"*

**Test the package, not just the code.** Unit tests prove your functions work.
They say nothing about whether `npm install` produces a thing that imports. Those
are different failures with different blast radii, and the second one is the one
that reaches strangers. Every published package needs a test that packs, installs,
and imports.

**Types are invisible at runtime and load-bearing at build time.** It is easy to
think a type is "internal" because it erases. It is not. If a consumer can write
`import type { Foo }`, `Foo` is API. This is the single most common way a
well-meaning cleanup breaks people.

**Every dependency you add, your users install.** A `dependency` is a decision you
make on behalf of everyone downstream — their bundle size, their audit surface,
their install time, their version conflicts. Prefer zero. Prefer an optional
`peerDependency` over a `dependency`. Never promote a peer to a dep for
convenience. (`react` and `@tanstack/react-query` are optional peers here, on
purpose. Keep them that way.)

**Runtime targets are a matrix, not a checkbox.** "Works in the browser" is four
claims: bundled ESM, unbundled ESM over CDN, a `<script>` global, and whatever
Safari is doing. A feature is done when it is observed working in every target the
README claims. Streaming is where this bites (see above).

**Beware the dual-package hazard.** If a consumer somehow loads both the ESM build
and the IIFE global, they get **two distinct `ApiError` classes**, and
`err instanceof ApiError` silently returns `false`. It is not a hypothetical —
it is why `instanceof` checks must be tested under the browser bundle
specifically, not just in Node.

**Errors are API too.** The class name, its `instanceof` identity, its fields, and
the string-literal `code` values are all things people branch on. Changing
`ApiError.status` to `ApiError.statusCode` breaks error handling in every consumer,
and no typecheck of *ours* will catch it.

**Deprecate loudly, delete rarely.** The cost of carrying an aliased old name for
a year is one line. The cost of deleting it is someone's broken build and a
support thread. Aliases are cheap; keep them.

**Examples are tests.** `examples/*.ts` typecheck in CI. When an example stops
compiling, the API got worse, and you found out before a user did. Write the
example you wish existed when you were learning, then make the API fit it — not
the other way round.

**When you cannot say why a thing is public, it should not be.** Every export,
every subpath, every field. The default answer is *no*; make each one argue for
itself. Surface you never shipped is surface you never have to support.

## Commands

```bash
pnpm --filter @kortix/sdk typecheck   # tsc --noEmit, plus examples/tsconfig.json
pnpm --filter @kortix/sdk test        # bun test src  (includes the tripwire)
pnpm --filter @kortix/sdk build       # tsc -p tsconfig.build.json + tsc-alias
```

Nothing is done until `typecheck`, `test`, and the tripwire are green. The
tripwire lives inside `test`, so a green `test` covers it — but read the output;
a skipped file is not a passing file.

CI (`.github/workflows/package-tests.yml`) additionally runs
`stage-npm-publish.test.mjs` and a build + stage + **dry-pack** of
`@kortix/llm-catalog`, `@kortix/sdk`, and `@kortix/executor-sdk` on every PR.
That is the release gate. It catches a broken `publishConfig`; it does not catch
a broken *install*.

## `PROGRESS.md` — read it first, update it last

`packages/sdk/PROGRESS.md` is the **single source of truth for state** across every
session and every plan: what is done, what is in flight, what is next, what is
merely *known*, which decisions are open. It is not a design doc (that is the spec)
and not a how-to (that is the plan). It links to both.

It has four work sections, and **you may not edit them all**:

| Section | You may… | You may **not**… |
|---|---|---|
| **Now** — the active plan's numbered chain | claim a task, update its status, add evidence | **renumber, reorder, delete, or insert.** The plan and the kickoff prompt reference tasks by number. |
| **Next** — committed, needs a spec | — | start one without a spec |
| **Backlog** — known gaps | **append freely** (`B<n>`, with evidence) | reorder or delete rows |
| **Discovered this session** | **append freely** | rewrite others' entries |

**Never delete a row.** Mark `WON'T DO (reason)`. A deleted row is a decision
nobody can audit.

**Found work mid-task? Do not do it.** Append it to *Backlog* or *Discovered this
session*, finish the task you claimed, and tell the user. Scope creep inside a task
is how a 146-file move becomes unreviewable.

**Multi-step work never becomes a Task.** The *Now* chain comes from one plan
document. New multi-step work earns its own spec → plan → chain. Backlog rows are
single, self-contained changes.

**Multiple sessions run against this repo simultaneously.** The failure mode is not
forgetting — it is two sessions doing the same task, or one silently overwriting
the other's status. So:

- **Before starting:** pull, read the table, and **claim your task in its own
  commit** before doing any work. A claim made after the work is not a lock.
- **Before finishing:** update the row (`DONE` + SHA, or back to `NOT STARTED` /
  `BLOCKED` with a reason) **and append a session-log entry**. A task left
  `IN PROGRESS` by a session that ended is a lie the next session will believe.
- **Prefer the append-only log** when you are short on turn. Appends merge cleanly
  across branches; table edits conflict.
- **Never mark `DONE` without pasting the evidence** — the commands you ran and
  their real output. `typecheck` is not evidence.

Git is the only lock available and it is advisory. A stale `IN PROGRESS` (older
than ~24h, no commits touching its files) is abandoned — take it over, and say so
in the log rather than overwriting silently.

## Test-driven, always. No exceptions in this package.

**Before writing any implementation code, invoke the `tdd` skill** (`/tdd`, or
`superpowers:test-driven-development`). For broader repo conventions — which test
type a change needs, factories, determinism, CI gates — the project skill is
`.claude/skills/testing/SKILL.md`.

This is not a preference. This package is **published to npm**. A regression here
does not show up in a PR review; it shows up in a stranger's build, on their
schedule, with no way to fix forward. Tests are the only thing standing between a
refactor and that outcome.

### The loop

**RED → GREEN → REFACTOR.** In that order, every time.

1. Write the failing test first. It encodes what you *intend*, before you know how.
2. **Run it and watch it fail.** For the right reason, with the error you expect.
3. Write the minimum code to make it pass.
4. Run it and watch it pass.
5. Refactor with the test green. Commit.

> **A test you have never seen fail is not a test.** It is a comment that costs
> CPU. If you cannot make it fail by breaking the code it covers, it asserts
> nothing. Step 2 is the step people skip and the step that does the work.

Skipping RED is how you write a test that passes against a bug. Skipping GREEN is
how you ship code no test exercises. Neither is faster.

### Never end a turn without running the gates

Do not report a change as done — or even as *probably* done — on the strength of a
typecheck, a diff that "looks right", or a test you wrote but never executed. Run
these, and **paste the real output**:

```bash
pnpm --filter @kortix/sdk typecheck   # tsc --noEmit + examples/tsconfig.json
pnpm --filter @kortix/sdk test        # bun test src — includes the tripwire
pnpm --filter @kortix/sdk run smoke:install   # pack → install → import the tarball
```

Baseline: **1069 passing, 0 failing, across 71 test files.** If your run shows
fewer tests than the baseline, you did not run them all — a filtered `bun test`
that matches nothing exits 0 and tells you nothing.

**`typecheck` is not verification.** It proves the types line up. It does not prove
the code runs, that the tripwire holds, that the tarball imports, or that streaming
delivers an event. Each of those has its own named proof, and the named proof must
actually run.

### When a test fails: keep going, but never touch the test

**Do not hand back red tests.** A failing suite is not a status update, it is
unfinished work. Loop: run → read the failure → fix → run again. Do not stop at
the first red, do not report "1 test failing, here's why", do not move to the next
task. Keep going until the suite is green.

**But loop on the CODE, never on the TEST.** The cheapest way to make a failing
test pass is to delete it. The second cheapest is to weaken its assertion. Both
reach green. Both destroy the only thing standing between a refactor and a
stranger's broken build.

These are **forbidden** as a response to a red test:

| Forbidden | Why |
|---|---|
| Deleting the test, or `test.skip` / `test.todo` / `.only` | Green by amputation |
| Weakening an assertion (`toEqual` → `toBeDefined`, dropping a field) | Green by lowering the bar |
| Filtering the run (`bun test src/thing.test.ts`) to dodge an unrelated failure | Green by not looking |
| Re-recording a snapshot to match your output | The snapshot *is* the expectation. See below. |
| Adding `no-tests-needed` to a PR that changed behaviour | The label is for formatting and comments |
| `catch {}` around the thing that throws | Green by silence |

**Three reasons a test goes red. Only one of them is a loop.**

1. **Your change is wrong.** ← *This is the loop.* Fix the code. Re-run. Repeat.
   The overwhelming majority of failures.
2. **The test encodes a wrong expectation.** Rare, and it is a *decision*, not a
   fix. Say so out loud, explain what the test asserted, why that expectation is
   wrong, and what the correct one is. Change the test in its own commit with that
   reasoning in the message. Never quietly, never mid-loop.
3. **The test found a real, pre-existing bug** — often in code you did not touch.
   **Stop the loop and report it.** This is the test doing its job. Task 2's
   install smoke test may well fail on its first-ever run for exactly this reason.
   Burying that under a "fix" is the worst outcome available to you.

**A snapshot diff is a question, not a failure.** `public-surface.snapshot.json`
failing means the public API changed. The question is *"did I mean that?"* If the
diff only adds names — additive, fine, re-record. If it **removes or renames** one,
you just broke every consumer: add an alias, do not accept the diff.
`UPDATE_SURFACE_SNAPSHOT=1` is a deliberate act, not a way out of a red test.

**Bound the loop.** "Infinite" is a figure of speech; thrashing is real, and it
burns budget while hiding a design problem.

- Same failure **three times** with three different fixes? Stop guessing. Invoke
  `superpowers:systematic-debugging`. Form a hypothesis, add an instrument, prove
  it — do not keep permuting code.
- About to modify a test's assertion? **Stop and surface it.** That is case 2 or 3,
  and it needs a human, not a loop.
- Failure is environmental (network, Daytona sandbox, a flaky port)? Say so, name
  the evidence, and do not pretend a re-run is a fix.

**Never report a subset as the whole.** `bun test src/foo.test.ts` passing tells
you nothing about the suite. And the exit code is not a safety net — verified
against `bun 1.3.14`:

| Command | Exit | Trap? |
|---|---|---|
| `bun test src/missing.test.ts` | `1` | no — fails loudly |
| `bun test src -t "no-such-name"` | error | no — fails loudly |
| **`bun test some/dir/with/no/test/files`** | **`0`** | **yes — runs nothing, reports success** |

So always finish on the full `pnpm --filter @kortix/sdk test`, and **check the
count against the 1046 baseline**. A green run that says `Ran 12 tests` is a run
you filtered by accident. A green run that says `Ran 0 tests` is not a green run.

### Then say whether it is shippable

Every response that changes code ends with an explicit verdict. Not a vibe — a
claim you are accountable for:

> **Shippable to production: YES / NO / NOT YET**
>
> - **Verified:** what you ran, and what it printed.
> - **Unverified:** every surface you did not exercise, and why.
> - **Risk:** what could still be wrong, concretely.

Say **NOT YET** freely. It is a useful, honest answer, and it is far cheaper than a
confident YES that turns out to be a broken `npm install` for real users. If a
surface could not be exercised this turn, name it — *"the IIFE bundle was never
loaded in a browser"* — rather than letting silence imply coverage.

Never write "should work", "looks correct", or "tests should pass". Run it, then
report what happened. If tests fail, say so and show the output.

### Tests ship with the change

Repo-wide rule, enforced by `.github/workflows/package-tests.yml`: a PR that
changes source under `packages/*/src` without changing a test **fails**, unless
labelled `no-tests-needed`. That label is for formatting, comments, and renames of
non-exported symbols — never for behaviour.

This package is well covered (65 test files) — match the neighbouring file's style
rather than inventing a harness. Tests live beside the code they test
(`foo.ts` → `foo.test.ts`).

## Examples are executable documentation

`examples/*.ts` are typechecked in CI (`tsc --noEmit -p examples/tsconfig.json`).
They import from `../src/index`, not `@kortix/sdk`, so they resolve without a
published build — but every example's header comment must show the **npm import
line** a real consumer would write, because that is what people copy.

Examples are also the only place the framework-free claim is demonstrated rather
than asserted. Keep them free of React, DOM, and Node-specific APIs beyond
`process.env` and `console`.

## Where the real logic goes

Per the root `AGENTS.md`: hosts are thin. If `apps/web`, `apps/mobile`, or
`apps/whitelabel-demo` needs behaviour that isn't here, it is added **here** and
exposed through the public surface — not hand-rolled in the host, and not reached
for by importing an internal `src/` path. A host importing
`@kortix/sdk/src/anything` is a bug in both places.
