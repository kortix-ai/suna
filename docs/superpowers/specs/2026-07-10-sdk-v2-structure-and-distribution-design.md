# `@kortix/sdk` v2 — structure, public surface, and no-bundler distribution

**Date:** 2026-07-10
**Owner:** Jay Suthar (handed over from Marko Kraemer)
**Package:** `packages/sdk` → `@kortix/sdk`
**Status:** design, awaiting implementation plan

---

## Context

`@kortix/sdk` was published to npm on 2026-07-07 to establish the package, not to
freeze a design. It works, it is well tested, and its shape is accidental.
Ownership has moved to Jay, who will maintain it long-term and who is building an
SDK for the first time. The goal of this spec is a structure that is **obvious to
maintain**, not merely one that functions.

The window to fix the public shape is open now and closing. Once `apps/web`,
`apps/mobile`, and Lumen adopt the SDK, every wart in the surface becomes
permanent.

**`apps/whitelabel-demo` (Lumen) is the first app shipping to production on this
SDK.** That makes it the acceptance harness: it is dogfooded at step 5, on the
narrowed surface, through the public entry only. A surface that cannot power a
real shipping app is not a finished surface. It also means the deadline is real —
whatever the SDK's public shape is when Lumen ships, that is the shape you support.

## Evidence this design rests on

Everything below was verified against the repo, not assumed.

| Claim | Evidence |
|---|---|
| Package is live on npm | `npm view @kortix/sdk version` → `0.9.100` |
| Real adoption is ~zero | 436 downloads/month, package `created` 2026-07-07 (2 days). `@kortix/executor-sdk` does 5,854/mo for scale. |
| The 400k Kortix users are **not** SDK installers | They consume it transitively via `apps/web`; a break surfaces at *our* build time, not their runtime |
| `version` in `package.json` is inert | `scripts/stage-npm-publish.mjs:32` — `pkg.version = version` from the root `VERSION` file (`0.9.102`) |
| Baseline is green | 1046 tests pass / 0 fail across 65 files; `typecheck` exits 0 |
| Nothing tests an actual install | CI runs `npm pack --dry-run` (file list only). `publishConfig.exports` is a hand-maintained parallel map with zero coverage. |
| `turns/index.ts` is a god-file | 50KB, 67 top-level declarations, 5 re-exports |
| `state/` mixes runtime tiers | `event-stream.ts` is framework-free; `sync-store.ts` does `import { create } from "zustand"` |
| The 21 subpaths are load-bearing | **340** import sites across the monorepo (`projects-client` alone: 205) — hence deprecated aliases, not deletion |
| The SDK cannot stream on React Native | RN `fetch` has no `response.body`; Hermes has no `TextDecoderStream` |
| Mobile already paid for that | `apps/mobile/lib/opencode/event-stream.ts` — **655 loc**, a parallel `EventSource`/`react-native-sse` reimplementation of the SDK's 571-loc one |
| The tripwire cannot see globals | It walks the import graph; `process`/`window`/`document` are globals. `platform/platform-client/shared.ts:29` reads bare `process.env.BACKEND_URL` in the isomorphic-core tier |
| …and the SDK already knows this is a bug | `platform/feature-flags.ts:14` documents the ReferenceError and ships `safeEnv()`. `shared.ts` doesn't call it. |
| A transport seam fits the existing design | `openEventStream` already accepts an injectable `EventStreamTimers` seam (`src/state/event-stream.ts:54`) |
| A single root barrel is feasible | `tsc` on a merged barrel → **8** `TS2308` ambiguities, not hundreds |
| 7 of those 8 are trivial | `ApiError`, `FileContent`, `FileNode`, `QuestionOption`, `PermissionAction/Rule/Config` are each **declared once**, reachable via two `export *` paths |
| 1 is a real bug | **`KortixProject` is declared twice** — `platform/projects-client/projects.ts:31` and `opencode/kortix-master.ts:577` — as two different interfaces |

That last row is the thesis in miniature: the 25-subpath surface **hid** a real
naming collision. A single barrel turns that class of bug into a compile error.

## Goals

1. A layout where a file's directory tells you what it may import.
2. A public surface small enough to hold in your head, with a rule for growing it.
3. Renames and accidental breakage caught by CI, not by a customer.
4. Usable with no bundler and no framework: `<script>` tag, CDN, plain `.ts`.
5. **Nothing in the core that a non-Node, non-DOM host cannot run.** No bare
   `process`/`window`/`document` globals. This is what a `<script>` tag needs, and
   it is also the precondition for React Native later.
6. Every step guarded by a test that runs before the step after it.

## Non-goals

- **React Native / Expo streaming support.** Explicitly deferred (Jay, 2026-07-10).
  It blocks nothing here. The transport-seam design is retained in this document;
  the implementation is a follow-up. Goal 5 above is the part of it that *does*
  land now, because a bare `process.env` read breaks the CDN bundle regardless of RN.
- Vue / Svelte adapters.
- Rewriting `apps/web`'s 340 SDK import sites (the deprecated-alias design makes
  this unnecessary; see Axis 2).
- Migrating `apps/mobile` off its 655-loc parallel `event-stream.ts`. Blocked on
  the deferred seam.
- Any change to *behaviour*. Everything here is structure, packaging, and
  portability.

**Hosts this spec must not break:** `apps/web`, `apps/mobile`, `apps/whitelabel-demo`.
The deprecated-alias design (Axis 2) means all three keep compiling with zero
changes. "Not breaking mobile" and "mobile streams via the SDK" are different
claims; only the first is in scope.

---

## Design

### The two axes

These were tangled in earlier planning and separating them is what makes the work
cheap:

- **Axis 1 — internal file layout.** Invisible to consumers. The `exports` map is
  an indirection from public name to internal file, so files may move freely.
  **Compatibility cost: zero.**
- **Axis 2 — the public surface.** Visible to everyone. Narrowing it touches 16
  `apps/web` imports. **Only free while downloads are ~0.**

Axis 1 first, so Axis 2 happens on a clean tree.

### Axis 1 — directories encode the runtime tier

The most important invariant in this package is which runtime a module may
target. Today that invariant lives *only* in a `SUBPATH_TIERS` array inside
`src/index.isomorphic.test.ts`. The layout gives no signal, which is why zustand
sits next to the isomorphic core.

```
src/
  core/            ← isomorphic-core: no react, no zustand, no node:, no DOM
    client/          createKortix facade         (kortix.ts, 941 loc → split)
    http/            api-client, auth, config, errors
    rest/            projects-client, platform-client
    runtime/         opencode client, kortix-master
    session/         session handle + url
    turns/           classify, view-model, parts, grouping, shell, state
    files/
    stream/          event-stream               ← lifted out of state/
  browser/         ← browser-only: zustand, window, indexedDB allowed
    stores/          sync, server, sandbox-connection, pending, compaction, tab, diagnostics
    cache/           idb-sync-cache
  node/            ← node-allowed: node:async_hooks only
    server.ts
  react/           ← the one place react is allowed
  index.ts         ← a true barrel: re-exports only
```

The rule becomes checkable **by path**, not by maintaining a list:

> A file in `core/` may not import from `browser/`, `node/`, or `react/`, nor
> from `react`, `react-dom`, `next`, `zustand`, `@tanstack/react-query`, or any
> `node:` specifier.

The existing tripwire (`src/index.isomorphic.test.ts`) already walks the full
static import graph including type-only imports. It gets one added assertion for
the path rule, and keeps its `exports`-map cross-check.

### `turns/index.ts` splits along seams that already exist

`index.ts` becomes a five-line barrel. Its 67 declarations move to:

| New file | Contents |
|---|---|
| `parts.ts` | the eight `isXPart` predicates, `getPartText`, `isAttachment`, `splitUserParts` |
| `grouping.ts` | `groupMessagesIntoTurns`, `collectTurnParts`, `findLastTextPart`, `turnHasSteps` |
| `shell.ts` | `isShellMode`, `getShellModePart` |
| `state.ts` | `getWorkingState`, `isLastUserMessage` |
| *(unchanged)* | `classify.ts`, `view-model.ts`, `errors.ts`, `types.ts`, `tool-registry.ts` |

No exported name changes. Consumers see nothing.

### Axis 2 — four entry points, and a rule for the fifth

```ts
import { createKortix, classifyTurn, ApiError } from '@kortix/sdk'
import { useSession }                           from '@kortix/sdk/react'
import { createScopedKortix }                   from '@kortix/sdk/server'
import { useSyncStore }                         from '@kortix/sdk/internal/sync-store'
```

For most work, root is the only door — `createKortix` already unifies the REST
and runtime surface behind one object (`kortix.projects.list()`,
`kortix.session(pid, sid).send()`). The 21 client subpaths were never the
ergonomic path; they were escape hatches promoted to the front door.

**A single entry is impossible, and the reason is not stylistic.** The tier
boundary *is* the subpath boundary:

| Entry | Why it cannot live at root |
|---|---|
| `@kortix/sdk` | — (the framework-free core) |
| `@kortix/sdk/react` | React is a peer dependency; rooting it forces React on every vanilla, CDN, and Node consumer |
| `@kortix/sdk/server` | imports `node:async_hooks`, which breaks in a browser |
| `@kortix/sdk/internal/*` | `apps/web` needs the zustand stores; explicitly unsupported, outside semver |

**The standing rule, applied at review time in five seconds:**

> If you cannot say in one sentence why a module *cannot* live at root, it does
> not get a subpath.

Twenty-one of the current twenty-five fail that test — as the rule for **new**
subpaths. The existing ones are a different question, answered next.

#### Deprecate the 21; do not delete them

The 21 subpaths are imported at **340 sites** across the monorepo
(`projects-client` alone: 205; `turns`: 28; `opencode-client`: 26;
`platform-client`: 25; `instance-routes`: 15). Deleting them would be a mass
migration *and* a direct violation of this package's own law — *alias, never
replace*.

So: **root becomes canonical; every existing subpath keeps working as a
`@deprecated` alias.**

```jsonc
// package.json → exports
".":                 "./src/index.ts",                       // canonical: everything
"./projects-client": "./src/deprecated/projects-client.ts",  // @deprecated, re-exports from root
"./turns":           "./src/deprecated/turns.ts",            // @deprecated
"./sync-store":      "./src/deprecated/sync-store.ts",       // @deprecated → ./internal/sync-store
```

Consequences, all good:

- **Zero import sites need rewriting.** Not 340, not the 16 stores. `apps/web`,
  `apps/mobile`, and `whitelabel-demo` keep compiling untouched.
- **No breaking change ships**, so nothing here forces a major.
- The docs, README, and examples teach **one import**: `@kortix/sdk`.
- Migrating the 340 sites becomes an optional, mechanical, do-it-whenever
  follow-up — decoupled from this spec entirely.
- New code physically cannot reach for a deprecated path without an editor
  strikethrough and a lint warning telling it where to go.

The deprecated shims live in `src/deprecated/` — one directory, obviously
temporary, trivially deletable on a future major. Their presence is the honest
record of what we owe.

**`./internal/*` is the one genuinely new subpath**, and it exists because
`apps/web` needs the zustand stores and we want that dependency *visible and
labelled*, not laundered through a name that looks supported.

#### Collapsing the barrel: the 8 ambiguities

Seven need a one-line explicit re-export each (each symbol is declared once,
merely reachable twice). The eighth is a real defect and must be resolved before
the surface is declared stable:

**Resolved (Jay, 2026-07-10): `KortixProject` keeps its name.** It is the platform
entity — `project_id`, `account_id`, `repo_url`, `manifest_path`, `warm_pool` — the
thing `kortix.projects.list()` returns and the thing everyone means. It is already
published under that name; renaming it would be a breaking change for zero gain.

The **other** one is what moves. `opencode/kortix-master.ts:577` models something
unrelated: a project inside the sandbox's kortix-master daemon — `id`, `name`,
`path`, `opencode_id`, `structure_version` (1 = legacy tasks, 2 = tickets/board),
`sessionCount`, `worktree`. It is a **project-management board**, not a platform
project. Same word, different concept.

```ts
// core/runtime/kortix-master.ts
export interface KortixMasterProject { id: string; path: string; /* … */ }

/** @deprecated Renamed to `KortixMasterProject` — it models the kortix-master
 *  daemon's board project, not the platform project. Removed in the next major. */
export type KortixProject = KortixMasterProject;
```

`KortixMasterProject` is currently unused as a name (verified), matches its module,
and needs no change to its sibling functions (`listKortixProjects`,
`getKortixProject`, `patchKortixProject` — none of which collide). Rename
`PatchKortixProjectInput` → `PatchKortixMasterProjectInput` with an alias, for
consistency.

**Back-compat is exact.** The deprecated `@kortix/sdk/opencode-client` shim keeps
exporting `KortixProject` (aliased to `KortixMasterProject`), so every existing
importer of *that subpath* compiles unchanged. The **root barrel** exports
`KortixProject` (the platform one) and `KortixMasterProject` (the daemon one) —
two distinct names, no `TS2308`, nobody broken.

The remaining seven ambiguities (`ApiError`, `FileContent`, `FileNode`,
`QuestionOption`, `PermissionAction`, `PermissionRule`, `PermissionConfig`) are
each declared once and need only an explicit re-export at the barrel.

#### A pleasant consequence

An earlier decision — what goes in the `window.Kortix` IIFE global — chose
"root barrel **plus** curated `turns` / `files` / `session` namespaces", because
`classifyTurn` lived at `./turns` and a CDN page could stream but not render.
Once those modules fold into root, **the question dissolves**: `window.Kortix`
*is* the root barrel, and it already contains `classifyTurn`. One flat global, no
namespaces, no curation list to maintain.

### The naming contract

Exported names are the API. This is now written into `packages/sdk/AGENTS.md`
(symlinked as `CLAUDE.md`) and summarized here:

- Every identifier reachable from a public entry is public — **including types
  and interfaces**, string-literal union members, and enum members. A renamed
  type breaks `import type` exactly as hard as a renamed function.
- Internal file layout is free to change; public names are not. These are
  independent.
- To rename, **alias — never replace**: keep the old name as a `@deprecated`
  type alias, remove only on a major.
- Conventions: `createX` factories, `XError` errors, `useX` hooks, `PascalCase`
  types, no `I` prefix, no abbreviations. Do **not** prefix with `Kortix` unless
  the bare name collides with a common global (`File`, `Event`, `Response`).
  `Project` beats `KortixProject`.

**Enforcement.** Documentation gets skimmed, so the rule gets teeth: a committed
snapshot of every public export name, asserted in CI. Any add, rename, or removal
changes the snapshot and surfaces the diff in review, where a human decides
whether it is additive (fine) or breaking (needs an alias). A snapshot diff is a
question — *"did I mean to change the public API?"* — not a file to re-record
until green.

### Streaming must keep working — in every target we claim

Live SSE (`session.stream()` → `openEventStream` → `client.global.event()`) is the
most breakable surface here, because it is the only one that depends on
streaming-body support in the host's `fetch`. Verified transport, inside
`@opencode-ai/sdk/dist/v2/gen/core/serverSentEvents.gen.js`:

```js
const response = await _fetch(request);
const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
```

It is **not** `EventSource`. Reconnect/backoff/heartbeat/coalescing are ours
(`state/event-stream.ts` → `core/stream/`); the wire is the vendor's.

| Target | Streams today? | After this spec |
|---|---|---|
| Modern browsers | ✅ | ✅ `TextDecoderStream` requires **Safari 16.4+** |
| Node ≥ 18, Bun, Workers | ✅ | ✅ globals present |
| **React Native / Expo** | ❌ | ❌ **deferred** — needs the transport seam below |

RN's `fetch` has no `response.body`, and Hermes has no `TextDecoderStream`. No
polyfill stack fixes this cleanly — `react-native-fetch-api` +
`web-streams-polyfill` + a `TextDecoder` shim is three fragile globals patched
into every Expo app, and it routinely breaks in Expo Go. The seam is smaller,
testable, and does not ask consumers to monkey-patch their runtime.

**Bundler trap.** `@opencode-ai/sdk/v2/client` is browser-safe (graph:
`error-interceptor`, `client.gen`, `sdk.gen`, `types.gen`). The
`node:child_process` in that package lives in `dist/process.js`, reachable only
from `v2/server.js`. `tsup` must never resolve `@opencode-ai/sdk` root, `/server`,
or `/v2/server` into a browser bundle. Assert this in the tripwire's bundle check.

### The RN problem, and what it already cost us

Because the SDK cannot stream on RN, **`apps/mobile` wrote its own**:

| | |
|---|---|
| `packages/sdk/src/state/event-stream.ts` | 571 loc — fetch + `ReadableStream` |
| `apps/mobile/lib/opencode/event-stream.ts` | **655 loc** — `EventSource` via `react-native-sse` |

Mobile's copy re-implements reconnect, backoff, retry, heartbeat, and coalescing
(49 matches for those terms). It also carries its own `sync-store.ts`,
`session-sync.ts`, and `types.ts`. Two divergent implementations of the hardest,
most failure-prone logic in the product — and mobile imports **zero** streaming
from the SDK today (`projects-client` 49, `turns` 8, root 5).

This is exactly the "logic lives in a host, never the SDK" violation the root
`AGENTS.md` forbids. It happened because the SDK left no seam for it.

### DEFERRED — the transport seam is designed here, built later

**Decision (Jay, 2026-07-10): React Native support is out of scope for this spec.**
It blocks nothing — no other step depends on it — so deferring costs the rest of
this work nothing, and the seam below is purely *additive* when it lands. No
rework of the restructure.

What deferral **does not** buy you a pass on: **step 6, portability hardening,
stays.** The bare `process.env` read at `platform-client/shared.ts:29` throws a
`ReferenceError` in the CDN `<script>` bundle, which is in scope. RN is simply the
other place that bug surfaces.

What deferral costs, stated plainly: `apps/mobile/lib/opencode/event-stream.ts`
(655 loc) keeps diverging from `state/event-stream.ts` (571 loc) for as long as
this waits. That bill grows; it is not avoided. Schedule the seam before mobile's
copy drifts far enough that reconciling them is its own project.

The design below is kept so the next person does not rediscover it.

### The fix (deferred): an injectable transport seam

`openEventStream` already owns everything platform-independent — reconnect,
backoff, heartbeat, coalescing, abort. The *only* platform-specific part is **how
bytes arrive**. Split that out:

```ts
export interface EventStreamTransport {
  connect(opts: { signal: AbortSignal }): Promise<AsyncIterable<unknown>>;
}
```

- **`fetchStreamTransport`** (default) — today's `client.global.event()` path.
  Web, Node ≥18, Bun, Workers.
- **`eventSourceTransport({ EventSource })`** — host injects a constructor. RN
  passes `react-native-sse`'s; a browser could pass the native one.

**There is precedent in this exact file.** `openEventStream` already accepts an
injectable `EventStreamTimers` seam (`now`/`setTimeout`/`clearTimeout`) so tests
can drive backoff with a fake clock. The transport seam follows the same grain:

```ts
export interface EventStreamTimers {   // ← already exists, src/state/event-stream.ts:54
  now: () => number;
  setTimeout: (handler: () => void, timeoutMs?: number) => EventStreamTimerHandle;
  clearTimeout: (handle: EventStreamTimerHandle | undefined) => void;
}
```

Payoff: **one** reconnect/backoff/coalesce implementation serves all three hosts,
and `apps/mobile/lib/opencode/event-stream.ts` (655 loc) is deleted rather than
maintained in parallel forever.

Streaming is not "done" because `state/event-stream.test.ts` passes (28 tests).
It is done when events are **observed arriving** in the ESM `dist/`, the CDN ESM
bundle, the `window.Kortix` IIFE global, and under the RN transport.

### The tripwire has a hole, and RN is how you fall in it

The tripwire walks the **import graph**. `process`, `window`, and `document` are
**globals, not imports** — it cannot see them. So "isomorphic-core" today means
*free of framework imports*, **not** *runs on React Native or in a `<script>` tag*.

A live instance, in the isomorphic-core tier:

```ts
// platform/platform-client/shared.ts:29
const backendUrl = process.env.BACKEND_URL || platformConfig().backendUrl;
```

The SDK's own `platform/feature-flags.ts:14` documents precisely why this is a
bug — *"Non-Next hosts (React Native, a bare browser bundle, a CLI) may not define
a `process` global at all — touching `process.env` there throws a ReferenceError"* —
and ships a `safeEnv()` helper for it. `shared.ts` does not use it.

So the tripwire gains a second check: **the isomorphic core may not touch a bare
`process` / `window` / `document` / `localStorage` global.** Guarded reads
(`typeof window !== 'undefined'`) are fine; `kortix.ts:102` and
`platform/instance-routes.ts` already do this correctly. Enforce it statically,
and ideally also by evaluating the core in a VM with those globals deleted.

### The dual-package hazard

If a page loads both the ESM build and the IIFE global, it gets two distinct
`ApiError` classes and `err instanceof ApiError` silently returns `false`. This is
why D3 tests `instanceof` **under the browser bundle**, not only in Node.

### Distribution

Keep the existing `tsc` ESM `dist/` exactly as-is; it is what the workspace and
npm consumers resolve. Add `tsup` as an SDK-only devDependency producing two
additional artifacts:

- a minified ESM bundle for `<script type="module">` / CDN
- an IIFE `dist/kortix.global.js` exposing `window.Kortix` (the root barrel)

Wire `browser` / `unpkg` / `jsdelivr` fields. Both are **purely additive**; no
existing consumer is affected. The tripwire extends to cover the bundle entries.

### The safety net, and why it comes first

`publishConfig` maintains a *second, parallel* export map rewriting all entries
from `src/*.ts` to `dist/*.js`. Nothing tests it. CI's `npm pack --dry-run` only
lists tarball contents. **Add one export, forget the `publishConfig` half, and CI
stays green while every `npm install @kortix/sdk` gets a module-not-found.**

So before anything else: `npm pack` → install the tarball into a throwaway
project → `import` it in Node ESM and in a `<script type="module">` page. Wired
into `.github/workflows/package-tests.yml`, so it protects every future change
rather than this one.

This is also what makes a 29.5k-LOC restructure survivable. Build the net, then
do the trapeze.

---

## Lumen ships anonymous — and none of that is SDK work

`apps/whitelabel-demo` (Lumen) will let visitors try Kortix **without logging in**.
Two conclusions, and the second is the important one.

**1. The SDK needs zero changes for this. It is a validation, not a gap.**

Lumen already runs "wrapper mode": the Kortix PAT lives only on the server, the
browser talks to `/api/kortix/[...path]`, and the SDK is configured with Lumen's
*own* HMAC-signed session token via `getToken()`. The SDK never knew or cared what
identity backed that token — which is precisely what the `getToken` seam is for.

Today `POST /api/auth/login` takes an email and *any* password, with no user
directory; `userId` is just the email. Going fully anonymous means minting a signed
session with a random `userId` on first visit instead of asking for one. Nothing
below `getToken` changes.

Two properties already verified and worth protecting:

- **The proxy streams SSE.** `api/kortix/[...path]/route.ts` buffers *request*
  bodies deliberately (an ALB rejects chunked ones) but passes **response bodies
  through untouched**, except on two ownership-tracking routes. Streaming survives
  the proxy. Any future change there must preserve this.
- **Ownership scoping is keyed on `session.userId`** (`filterProjectsList`,
  `recordProvisionOwner`), not on an account. Anonymous ids drop straight in.

**2. Lumen is NOT production-ready, and it says so itself.**

These are Lumen blockers, not SDK blockers. They must not enter this spec — they
belong to a separate Lumen-productionisation spec — but the SDK cannot be called
"shipped" until they are solved, because Lumen is the ship.

| Blocker | Where | Why it breaks in production |
|---|---|---|
| Project ownership is a **JSON file** (`.lumen-data/users.json`) | `src/server/users.ts` | *This is the entire isolation model.* Multi-instance or serverless ⇒ visitors see each other's projects, or lose their own on restart. Its own doc comment says "not a production multi-instance deployment". |
| Rate limiter is an **in-memory `Map`** | `src/server/rate-limit.ts` | Process-local: N replicas ⇒ N× the limit. Doc comment says "single-instance deployment". |
| Rate limit is keyed on `userId` | `src/server/rate-limit.ts` | **Anonymous makes this worse.** Every visitor mints a fresh `userId`, so a bot gets a fresh bucket per visit. Must also key on IP / fingerprint. |
| Anonymous visitors provision **real Daytona sandboxes** | — | Direct, unbounded cost exposure. Needs sandbox quotas, TTL, and GC of orphaned sandboxes (a visitor who clears cookies abandons theirs forever). |

**Scope discipline:** the SDK spec stays an SDK spec. Step 5 dogfoods Lumen against
the public surface — root-only imports, no raw `fetch`, e2e green. That proves the
*SDK*. Making Lumen safe to expose to the public internet is separate, and larger
than it looks.

## Open decisions

Neither blocks steps 1–3. Both must close before step 4 (Axis 2).

- ~~**What is the second `KortixProject` actually called?**~~ **RESOLVED
  (Jay, 2026-07-10):** the platform type keeps `KortixProject`; the kortix-master
  daemon's becomes `KortixMasterProject`, with a `@deprecated` alias on the
  `opencode-client` shim. See "Collapsing the barrel" above. Step 4 is unblocked.

- **Scope input: "shift the cortex tab to SDK."** Raised verbally, never
  clarified. If this names work Marko is waiting on, it may sit outside this spec
  entirely and re-order everything. **Owner: Jay.** Resolve before the
  implementation plan is written, not after.

## Implementation order

Each step is the guardrail for the next. This ordering is load-bearing.

> **`apps/whitelabel-demo` is the acceptance harness, not an afterthought.** It is
> the **first app shipping to production** on this SDK (Jay, 2026-07-10). It stops
> being a demo the moment this lands. If the SDK cannot power it end to end,
> through the public surface alone, the SDK is not done — that is the definition
> of done, and it is checked at step 5, not at the end.

1. **Install smoke test in CI.** `npm pack` → install → import (Node ESM +
   script tag). The net.
2. **Public-export snapshot test.** Records today's surface so every subsequent
   step's effect on it is visible in review.
3. **Axis 1 — internal restructure.** `core/` / `browser/` / `node/` / `react/`;
   split `turns/index.ts`; lift `event-stream` out of `state/`. Update `exports`
   + `publishConfig.exports` + `SUBPATH_TIERS`. Add the path-based tier rule to
   the tripwire. *Snapshot must not change.* That is the proof it was invisible.
4. **Axis 2 — narrow the public surface, additively.** Make root canonical; fix
   the 8 ambiguities; resolve `KortixProject`; add `internal/*`; turn the 21
   subpaths into `@deprecated` aliases under `src/deprecated/`. **No consumer
   changes. No import site rewritten. No breaking change.** *Snapshot grows;
   review the diff — every entry should be additive.*
5. **Dogfood on `whitelabel-demo` — the acceptance gate.** Three things, together:
   - Migrate its **39 SDK import sites to root-only `@kortix/sdk`** (14 already
     are; the rest are `projects-client` 10, `react` 9, `turns` 4, `session` 1,
     `opencode-client` 1 — `react` stays a subpath, by rule).
   - Replace the two raw-transport routes with `@kortix/sdk/server`.
     **Both endpoints already exist in the SDK** — `projects-client/tokens.ts:127`
     (`POST /projects/:id/cli-token`) and `projects-client/gateway.ts:210`
     (`GET /projects/:id/gateway/sessions`). These routes duplicate the SDK, they
     do not extend it.
   - `typecheck` + `bun test tests/e2e` green.

   This validates the single-entry design on a **real, production-bound app**,
   at 39 sites, before `apps/web`'s 340 ever move — and before bundles are built
   on a surface nobody has used in anger.

6. **Portability hardening.** Extend the tripwire to ban bare
   `process`/`window`/`document`/`localStorage` globals in the isomorphic core.
   Fix `platform/platform-client/shared.ts:29` to use `safeEnv()`.
   **This is browser work, not RN work.** A bare `process.env` read throws a
   `ReferenceError` in the CDN `<script>` bundle (step 7). RN is merely the *other*
   place it breaks. Not skippable.
7. **`tsup` bundles** on the final shape — CDN ESM + `window.Kortix`.
8. **Tripwire over `examples/`** — asserts the framework-free claim in CI.
9. **`examples/07-vanilla.ts`** (full flow, plain TS) and **`examples/08-cdn.html`**
   (no build step, streams and renders via `Kortix.classifyTurn`).
10. **Docs** — CHANGELOG, README, API-MAP with a stability table. The README's
    install-and-first-call section is now the front door for a shipping product,
    not a demo.

**There is no version-bump step.** An earlier plan called for bumping to `0.3.0`.
That is a no-op — `stage-npm-publish.mjs` overwrites `version` from the root
`VERSION` file — and had it applied, `0.3.0` would have landed *below* `latest
0.9.100` and never become `latest`. The release stamps the SDK; the SDK does not
stamp itself.

## Done when

- **D1** A plain `.ts` file runs `createKortix → projects.list() → session().send()
  → session.stream() → classifyTurn`, with zero React/DOM/Node in the import
  graph, asserted by the tripwire.
- **D2** A `<script type="module">` page and a `window.Kortix` IIFE page both
  stream a session and render its transcript, with no build step.
- **D2a** **Streaming is observed delivering events in all three distribution
  targets** — the ESM `dist/`, the CDN ESM bundle, and the IIFE global. Not
  inferred from unit tests.
- **D2c** The isomorphic core touches **no bare `process`/`window`/`document`/
  `localStorage` global**, asserted statically. `platform-client/shared.ts:29`
  uses `safeEnv()`. Without this the CDN bundle throws a `ReferenceError` on the
  first `getPlatformUrl()` call.
- **D2d** `apps/web`, `apps/mobile`, and `apps/whitelabel-demo` all typecheck
  and pass their suites **without a single import line changed**. This is the
  proof that the deprecated-alias design worked.

*(RN streaming under an injected `EventSource` transport was a criterion here and
has been deferred with the seam. It returns with the follow-up spec.)*
- **D2b** No browser bundle contains `node:child_process`. Asserted, not assumed —
  `tsup` must resolve `@opencode-ai/sdk/v2/client`, never the root or `/server`.
- **D3** `instanceof ApiError` and the domain result types work under the browser
  bundle (guards the dual-package hazard).
- **D4** The tripwire passes, extended to the path-based tier rule, the examples,
  and the bundle entry points.
- **D5** `npm pack` → install → import passes in CI for Node ESM and a script tag.
- **D6** The public-export snapshot is committed, and its diff across the whole
  restructure is reviewed and intentional.
- **D7** `@kortix/sdk/react` consumes only the public contract.
- **D8** `apps/whitelabel-demo` — **the first production ship** — reaches the
  Kortix backend exclusively through `@kortix/sdk*`, imports it via the **root
  entry only** (plus `/react` and `/server`, by rule), typechecks, and passes
  `bun test tests/e2e`. No raw `fetch` to the Kortix API remains. This is the
  acceptance test for the whole spec: if the public surface cannot power a real
  shipping app, the surface is wrong.
- **D9** `typecheck` + `test` + tripwire green at every step, not just the last.

## Risks

- **The restructure is 29.5k LOC of moves.** Mitigated by ordering: the install
  test and the export snapshot both land before the first file moves, so "did I
  break the package" and "did I change the API" are both answered mechanically.
- **`publishConfig.exports` cannot be cross-checked by the tripwire** (it points
  at `dist/`, which does not exist in the workspace). The install smoke test is
  the only thing that catches a missing entry. It must not be skippable in CI.
- **`workspace:*` dependencies are pinned to the lockstep version at publish.**
  `@kortix/llm-catalog` must publish alongside. Do not add new `workspace:*`
  dependencies to this package.
- **`apps/web` stays untouched, and that is now a hard constraint, not a hope.**
  An earlier draft of this spec proposed collapsing 21 subpaths and "updating 16
  imports". The real figure is **340 import sites**, and deleting the subpaths
  would have violated this package's own *alias-never-replace* law. The deprecated-
  alias design above reduces the consumer diff to zero. **If any step of the
  implementation starts editing host import lines, that is the signal the design
  drifted — stop.**
- **`./internal/*` needs the tripwire's `SUBPATH_TIERS` check taught about
  wildcards.** That test currently asserts exact set-equality between
  `SUBPATH_TIERS` and the `exports` keys. A wildcard key will fail it until
  updated. Expected, not a surprise.
- **We do not own the streaming transport.** It lives in `@opencode-ai/sdk`. A
  minor bump there can change `fetch`/`TextDecoderStream` behaviour under us. The
  version is pinned exactly (`1.17.11`, not `^`) — keep it that way, and re-run
  the D2a streaming checks on any bump.
- **Deferring RN is a debt with interest.** `apps/mobile/lib/opencode/event-stream.ts`
  (655 loc) diverges from `state/event-stream.ts` (571 loc) for as long as the seam
  waits, and mobile's `sync-store.ts` / `session-sync.ts` diverge alongside it.
  Deferral does not avoid this bill; it grows it. Schedule the follow-up before
  reconciling the two becomes its own project.
- **Do not let the README or docs claim React Native support** while the seam is
  deferred. The SDK's `fetch` transport cannot stream on RN. Mobile works today
  only because it bypasses the SDK entirely.
- **Step 5 is the only step that touches runtime behaviour** (`shared.ts:29`
  gains a guard). Everything else is structure and packaging. If any other step
  changes observable behaviour, it is wrong.
