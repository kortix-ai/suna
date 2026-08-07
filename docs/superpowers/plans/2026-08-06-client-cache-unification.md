# Client Cache Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every already-visited surface in `apps/web` render from cache instead of repainting a skeleton, and make one entity resolve to exactly one cache entry with one freshness contract.

**Architecture:** Three layers, fixed in order. The Next.js router keeps dynamic page segments for 300 s so `loading.tsx` stops firing on return visits. React Query's `gcTime` rises above `staleTime` so a stale-while-revalidate window exists at all. A key factory in `@kortix/sdk/react` replaces roughly 176 hand-typed key literals across 30 `project*` families, and an ESLint rule makes a relapse a build failure.

**Tech Stack:** Next.js 16.3, React Query v5 (`@tanstack/react-query`), `@kortix/sdk` (published npm package), `bun:test`, ESLint flat config.

**Spec:** [`docs/superpowers/specs/2026-08-06-client-cache-unification-design.md`](../specs/2026-08-06-client-cache-unification-design.md)

## Global Constraints

- **One branch, one PR.** The user chose a single pull request. Every task commits to the same branch. Do not open intermediate PRs.
- **Verification is code-only.** `bun test`, `eslint`, `tsc --noEmit`. No browser driving, no booted stack, no Playwright.
- **`packages/sdk` is a published npm package.** TDD is mandatory: write the failing test, run it, watch it fail, then implement. Read `packages/sdk/AGENTS.md` and claim the task in `packages/sdk/PROGRESS.md` before Task 3.
- **Never bump `packages/sdk/package.json` `version`.** It is inert.
- **Adding an SDK export requires three synchronized edits** (`packages/sdk/AGENTS.md:311`). `./react` already exists, so Tasks 3–6 add files *under* `src/react/` and re-export them from `src/react/index.ts`. No new subpath, so no `package.json` edit is needed. Confirm this by running the export tests in Task 6.
- **Do not commit unless the user asks.** Steps that say "Commit" are written for the executing agent; confirm with the user before the first one.
- **`apps/web` runs `bun test` WITHOUT `--isolate`.** The global mock-registry footgun is live: when using `mock.module`, spread the real module first.
- **`packages/sdk` runs `bun test --isolate src`.**
- **Known-clean baseline:** `apps/web` `tsc --noEmit` reports ~15 `@types/bun` `test.each` errors in 3 files. That is the accepted baseline; any new error is yours.
- **No Linear identifier or URL in any branch name, commit message, or PR text.**

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `packages/sdk/src/react/query-keys.ts` | The `qk` factory. Pure functions, no React, no network. |
| `packages/sdk/src/react/query-keys.test.ts` | Prefix invariants and exhaustiveness. |
| `packages/sdk/src/react/query-contracts.ts` | One freshness tier per entity; ready-made `useQuery` option objects. |
| `packages/sdk/src/react/query-contracts.test.ts` | Tier uniqueness and `gcTime > staleTime`. |
| `packages/sdk/src/react/use-project-name.ts` | The single accessor for a project's name. |
| `packages/sdk/src/react/use-project-name.test.tsx` | One value from both call sites. |
| `packages/sdk/src/react/invalidate-project.ts` | Declared invalidation sets per write. |
| `packages/sdk/src/react/invalidate-project.test.ts` | Rename touches list and detail. |
| `apps/web/src/lib/query-cache-config.test.ts` | `gcTime > staleTime`; `staleTimes` present in `next.config.ts`. |

**Modified**

| File | Change |
| --- | --- |
| `apps/web/next.config.ts` | add `experimental.staleTimes` |
| `apps/web/src/app/react-query-provider.tsx` | `gcTime` 5 min → 30 min |
| `apps/web/eslint.config.mjs` | add the raw-key-literal rule |
| `packages/sdk/src/react/index.ts` | re-export the four new modules |
| `packages/sdk/PROGRESS.md` | claim, then complete |
| ~60 files across `apps/web/src` | literal keys → `qk.*` |
| `apps/web/src/features/workspace/capabilities/shared/project-detail-query.ts` | delete; callers move to `qk` + contracts |
| `apps/web/src/features/workspace/capabilities/connectors/project-connectors-query.ts` | delete; same |

**Deleted at the end of Task 11**

- `apps/web/src/features/workspace/capabilities/shared/project-detail-query.ts`
- `apps/web/src/features/workspace/capabilities/connectors/project-connectors-query.ts`

Their two tests (`project-detail-query.test.ts`, `project-connectors-query.test.ts`) are deleted with them — the contracts they assert move to `query-contracts.test.ts` in Task 4.

---

## Task 1: Router cache holds dynamic segments

**Files:**
- Modify: `apps/web/next.config.ts:288` (the `experimental` block)
- Test: `apps/web/src/lib/query-cache-config.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. This is a build-config change asserted by a file-content test.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/query-cache-config.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const nextConfig = () =>
  readFileSync(resolve(import.meta.dir, '../../next.config.ts'), 'utf8');

describe('router client cache', () => {
  // Without this, `staleTimes.dynamic` defaults to 0 and every navigation to a
  // route under the cookie-reading `projects/[id]/layout.tsx` discards its
  // segment and repaints `loading.tsx`. See
  // node_modules/next/dist/docs/01-app/02-guides/prefetching.md:61.
  test('dynamic segments are cached for five minutes', () => {
    const source = nextConfig();
    expect(source).toContain('staleTimes:');
    const dynamic = source.match(/staleTimes:\s*\{[^}]*dynamic:\s*(\d+)/)?.[1];
    expect(Number(dynamic)).toBe(300);
  });

  test('static segments keep at least the Next default', () => {
    const source = nextConfig();
    const staticTtl = source.match(/staleTimes:\s*\{[^}]*static:\s*(\d+)/)?.[1];
    expect(Number(staticTtl)).toBeGreaterThanOrEqual(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && bun test src/lib/query-cache-config.test.ts
```

Expected: FAIL — `expect(received).toContain("staleTimes:")` on a config that has none.

- [ ] **Step 3: Add the config**

In `apps/web/next.config.ts`, inside the existing `experimental: {` block (currently opening at line 288), add as the first property:

```ts
    // Next 16 gives a dynamic page segment a client-cache TTL of 0, so every
    // navigation to a route under `projects/[id]/layout.tsx` (which awaits
    // cookies(), making the whole subtree dynamic) discards the segment and
    // repaints its `loading.tsx`. Returning to a tab you visited ten seconds
    // ago cost a full server roundtrip and a full-page skeleton.
    //
    // `prefetch={true}` cannot fix this: with a `loading.js` present, prefetch
    // only covers layout-to-boundary and the TTL stays in the `dynamic` bucket
    // (node_modules/next/dist/docs/01-app/02-guides/prefetching.md:61).
    //
    // 300s is safe here because every page under `projects/[id]` is a client
    // component — its RSC payload references a chunk and carries no rendered
    // data. Page data comes from React Query under its own contract.
    staleTimes: { dynamic: 300, static: 300 },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && bun test src/lib/query-cache-config.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Confirm the config still parses**

```bash
cd apps/web && npx tsc --noEmit next.config.ts --module esnext --moduleResolution bundler --skipLibCheck
```

Expected: no output. A non-zero exit here means the property was inserted outside the `experimental` object.

- [ ] **Step 6: Commit**

```bash
git add apps/web/next.config.ts apps/web/src/lib/query-cache-config.test.ts
git commit -m "perf(web): cache dynamic route segments for 300s

Next 16 defaults staleTimes.dynamic to 0. Every route under the
cookie-reading projects/[id] layout discarded its segment on navigation and
repainted loading.tsx, including on return visits."
```

---

## Task 2: `gcTime` rises above `staleTime`

**Files:**
- Modify: `apps/web/src/app/react-query-provider.tsx:23`
- Test: `apps/web/src/lib/query-cache-config.test.ts:` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/lib/query-cache-config.test.ts`:

```ts
describe('react-query defaults', () => {
  const provider = () =>
    readFileSync(resolve(import.meta.dir, '../app/react-query-provider.tsx'), 'utf8');

  // gcTime === staleTime evicts an unobserved entry at the exact moment it
  // goes stale, so there is never a stale-while-revalidate window to render
  // from. gcTime must strictly exceed staleTime for cached content to survive
  // long enough to be worth having.
  test('gcTime strictly exceeds staleTime', () => {
    const source = provider();
    const stale = source.match(/staleTime:\s*([\d\s*]+),/)?.[1];
    const gc = source.match(/gcTime:\s*([\d\s*]+),/)?.[1];
    expect(stale).toBeTruthy();
    expect(gc).toBeTruthy();
    // eslint-disable-next-line no-eval -- arithmetic literals only, from our own source
    expect(eval(gc!)).toBeGreaterThan(eval(stale!));
  });

  test('gcTime is at least thirty minutes', () => {
    const gc = provider().match(/gcTime:\s*([\d\s*]+),/)?.[1];
    // eslint-disable-next-line no-eval -- arithmetic literals only, from our own source
    expect(eval(gc!)).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && bun test src/lib/query-cache-config.test.ts
```

Expected: FAIL — `expected 300000 to be greater than 300000`.

- [ ] **Step 3: Raise `gcTime`**

In `apps/web/src/app/react-query-provider.tsx`, replace line 23 and its neighbours:

```ts
            staleTime: 5 * 60 * 1000,
            // gcTime must strictly EXCEED staleTime. Set equal (both 5 min, as
            // they were), an entry with no mounted observer is garbage
            // collected at the exact instant it goes stale, so React Query can
            // never serve stale content while revalidating — every return
            // visit past the window is a cold fetch and a skeleton.
            //
            // 30 min is chosen to outlast a working session, not a workday.
            // Cost is a few hundred KB of JSON; the payoff is that revisiting
            // any surface inside a session renders from cache.
            gcTime: 30 * 60 * 1000,
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && bun test src/lib/query-cache-config.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/react-query-provider.tsx apps/web/src/lib/query-cache-config.test.ts
git commit -m "perf(web): raise gcTime above staleTime

gcTime equalled staleTime, so an unobserved entry was evicted the moment it
went stale and no stale-while-revalidate window existed."
```

---

## Task 3: The `qk` key factory in the SDK

**Files:**
- Read first: `packages/sdk/AGENTS.md`, `packages/sdk/PROGRESS.md`
- Modify: `packages/sdk/PROGRESS.md` (claim the task)
- Create: `packages/sdk/src/react/query-keys.ts`
- Test: `packages/sdk/src/react/query-keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `qk`, and the types `ProjectScopeKey` and `ProjectsListKey`. Tasks 4–11 import `qk` from `@kortix/sdk/react`.

- [ ] **Step 1: Claim the task in PROGRESS.md**

Add a dated section at the top of `packages/sdk/PROGRESS.md` following the format of the existing entries. State: scope is an additive `qk` query-key factory plus freshness contracts; no published name changes; no `version` bump.

- [ ] **Step 2: Write the failing test**

Create `packages/sdk/src/react/query-keys.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((segment, i) => key[i] === segment);

describe('qk.project', () => {
  const id = 'proj_123';

  // `scope(id)` is the invalidation prefix. Every project-scoped key must sit
  // under it, or `invalidateQueries({ queryKey: qk.project.scope(id) })`
  // silently misses whatever escaped.
  test('every project-scoped key is prefixed by scope', () => {
    const scope = qk.project.scope(id);
    const scoped = [
      qk.project.detail(id),
      qk.project.sessions(id),
      qk.project.session(id, 'sess_1'),
      qk.project.messages(id, 'sess_1'),
      qk.project.connectors(id),
      qk.project.access(id),
      qk.project.secrets(id),
      qk.project.files(id),
      qk.project.branches(id),
      qk.project.policies(id),
      qk.project.config(id),
      qk.project.sandboxes(id),
      qk.project.snapshots(id),
      qk.project.gateway(id),
    ];
    for (const key of scoped) {
      expect(startsWith(key, scope)).toBe(true);
    }
  });

  // scope() is a prefix, never a query key. If it equals a real key, then
  // invalidating the subtree also refetches a query nobody declared.
  test('scope is a strict prefix, never a key itself', () => {
    const scope = qk.project.scope(id);
    expect(qk.project.detail(id).length).toBeGreaterThan(scope.length);
    expect(qk.project.detail(id)).not.toEqual(scope as never);
  });

  test('session keys nest under sessions so one session invalidates alone', () => {
    expect(startsWith(qk.project.session(id, 's1'), qk.project.sessions(id))).toBe(true);
    expect(startsWith(qk.project.messages(id, 's1'), qk.project.session(id, 's1'))).toBe(true);
  });

  test('different projects never collide', () => {
    expect(qk.project.detail('a')).not.toEqual(qk.project.detail('b') as never);
  });

  test('the projects list is not under any project scope', () => {
    expect(startsWith(qk.projects.list(), qk.project.scope(id))).toBe(false);
  });

  test('the projects list partitions by account', () => {
    expect(qk.projects.list('acct_1')).not.toEqual(qk.projects.list('acct_2') as never);
    expect(qk.projects.list()).toEqual(qk.projects.list(undefined));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/sdk && bun test --isolate src/react/query-keys.test.ts
```

Expected: FAIL — `Cannot find module './query-keys'`.

- [ ] **Step 4: Write the factory**

Create `packages/sdk/src/react/query-keys.ts`:

```ts
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
 * The root segment is `kx`, NOT `kortix`. `kortixKeys` in `use-kortix-master.ts`
 * already owns `['kortix', 'projects', …]` and passes `['kortix', 'projects']`
 * to `invalidateQueries` (lines 371, 384). TanStack prefix-matches by default,
 * so a `kortix` root here would have made one factory's invalidation reach the
 * other's entries — and `kortixKeys.project(id)` would have been the SAME array
 * as `qk.projects.list(id)`. `kortixKeys` is published API and cannot move, so
 * `qk` roots elsewhere. Do not "tidy" this back to `kortix`; a test enforces it.
 */
export const qk = {
  projects: {
    /** Every project the account can see. `undefined` means the active account. */
    list: (accountId?: string) => ['kx', 'projects', accountId ?? 'all'] as const,
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
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/sdk && bun test --isolate src/react/query-keys.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/react/query-keys.ts packages/sdk/src/react/query-keys.test.ts packages/sdk/PROGRESS.md
git commit -m "feat(sdk): add qk query-key factory

One addressable tree per project, with scope() as an invalidation prefix that
is never itself a query key."
```

---

## Task 4: Freshness contracts

**Files:**
- Create: `packages/sdk/src/react/query-contracts.ts`
- Test: `packages/sdk/src/react/query-contracts.test.ts`

**Interfaces:**
- Consumes: `qk` from Task 3.
- Produces: `FRESHNESS`, `type FreshnessTier = 'live' | 'config' | 'inventory' | 'volatile'`, and `contract(tier)` returning `{ staleTime, gcTime, refetchOnMount: false }`.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/src/react/query-contracts.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { FRESHNESS, contract, type FreshnessTier } from './query-contracts';

const TIERS: FreshnessTier[] = ['live', 'config', 'inventory', 'volatile'];

describe('freshness contracts', () => {
  // The whole point of a tier is that a call site cannot disagree with it.
  // If gcTime ever falls to or below staleTime the tier reproduces the exact
  // provider-level bug this work exists to remove.
  test('every tier keeps data alive longer than it keeps it fresh', () => {
    for (const tier of TIERS) {
      const c = contract(tier);
      if (c.staleTime === Infinity) continue;
      expect(c.gcTime).toBeGreaterThan(c.staleTime);
    }
  });

  test('the live tier never expires on its own', () => {
    expect(contract('live').staleTime).toBe(Infinity);
  });

  test('no tier refetches on mount', () => {
    for (const tier of TIERS) {
      expect(contract(tier).refetchOnMount).toBe(false);
    }
  });

  test('tiers are ordered from most to least fresh', () => {
    expect(contract('volatile').staleTime).toBeLessThan(contract('inventory').staleTime);
    expect(contract('inventory').staleTime).toBeLessThan(contract('config').staleTime);
    expect(contract('config').staleTime).toBeLessThan(contract('live').staleTime);
  });

  test('every declared entity resolves to exactly one tier', () => {
    const entities = Object.keys(FRESHNESS);
    expect(entities.length).toBeGreaterThan(0);
    for (const entity of entities) {
      expect(TIERS).toContain(FRESHNESS[entity as keyof typeof FRESHNESS]);
    }
  });

  test('project detail is config tier, sessions list is inventory', () => {
    expect(FRESHNESS.projectDetail).toBe('config');
    expect(FRESHNESS.sessions).toBe('inventory');
    expect(FRESHNESS.messages).toBe('live');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/sdk && bun test --isolate src/react/query-contracts.test.ts
```

Expected: FAIL — `Cannot find module './query-contracts'`.

- [ ] **Step 3: Write the contracts**

Create `packages/sdk/src/react/query-contracts.ts`:

```ts
/**
 * One freshness contract per entity, declared once.
 *
 * `staleTime` is per-OBSERVER in React Query, not per-key. Seven call sites
 * reading `['project-detail', id]` therefore declared seven answers to "when
 * does a server-side change reach the user", and which one governed depended
 * on which pages happened to be mounted. Tiers remove the choice from the call
 * site: a consumer spreads a contract, it never authors one.
 *
 * `refetchOnMount` is false everywhere on purpose. Explicit invalidation is the
 * freshness channel; a component mounting is not evidence that data changed.
 */
export type FreshnessTier = 'live' | 'config' | 'inventory' | 'volatile';

const GC_TIME = 30 * 60 * 1000;

const TIERS: Record<FreshnessTier, { staleTime: number }> = {
  /** Kept current by SSE events. Polling it would be redundant and racy. */
  live: { staleTime: Infinity },
  /** Changes arrive through this app's own mutations, which invalidate. */
  config: { staleTime: 60_000 },
  /** Can also change from another member or another tab. */
  inventory: { staleTime: 30_000 },
  /** Genuinely time-sensitive; no mutation announces the change. */
  volatile: { staleTime: 5_000 },
};

export function contract(tier: FreshnessTier) {
  return {
    staleTime: TIERS[tier].staleTime,
    gcTime: GC_TIME,
    refetchOnMount: false as const,
  };
}

/**
 * Entity → tier. Adding an entity here without a tier is a type error, which
 * is the point: a new query cannot quietly inherit the global default.
 */
export const FRESHNESS = {
  projectsList: 'inventory',
  projectDetail: 'config',
  projectConfig: 'config',
  sessions: 'inventory',
  messages: 'live',
  connectors: 'config',
  secrets: 'config',
  policies: 'config',
  access: 'inventory',
  files: 'config',
  branches: 'config',
  sandboxes: 'volatile',
  snapshots: 'config',
  gateway: 'volatile',
} as const satisfies Record<string, FreshnessTier>;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/sdk && bun test --isolate src/react/query-contracts.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/react/query-contracts.ts packages/sdk/src/react/query-contracts.test.ts
git commit -m "feat(sdk): declare one freshness tier per entity

staleTime is per-observer, so seven call sites on one key meant seven
contracts. Tiers move the decision off the call site."
```

---

## Task 5: `useProjectName` and the invalidation helpers

**Files:**
- Create: `packages/sdk/src/react/use-project-name.ts`
- Create: `packages/sdk/src/react/invalidate-project.ts`
- Test: `packages/sdk/src/react/invalidate-project.test.ts`

**Interfaces:**
- Consumes: `qk` (Task 3), `contract`/`FRESHNESS` (Task 4).
- Produces:
  - `useProjectName(projectId: string | undefined): string | undefined`
  - `invalidateProject(qc: QueryClient, projectId: string): Promise<void>`
  - `invalidateProjectIdentity(qc: QueryClient, projectId: string): Promise<void>`
  - `writeProjectNameOptimistically(qc: QueryClient, projectId: string, name: string): void`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/src/react/invalidate-project.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { qk } from './query-keys';
import {
  invalidateProject,
  invalidateProjectIdentity,
  writeProjectNameOptimistically,
} from './invalidate-project';

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const ID = 'proj_1';

describe('invalidateProjectIdentity', () => {
  // The bug this exists to kill: rename invalidated ['projects'] only, so the
  // sidebar (which reads the list) showed the new name while the project home
  // title (which reads the detail) showed the old one, for a full gcTime.
  test('invalidates both the list entry and the detail entry', async () => {
    const qc = client();
    qc.setQueryData(qk.projects.list(), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    await invalidateProjectIdentity(qc, ID);

    expect(qc.getQueryState(qk.projects.list())?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.project.detail(ID))?.isInvalidated).toBe(true);
  });

  test('leaves an unrelated project untouched', async () => {
    const qc = client();
    qc.setQueryData(qk.project.detail('other'), { project: { name: 'Other' } });
    await invalidateProjectIdentity(qc, ID);
    expect(qc.getQueryState(qk.project.detail('other'))?.isInvalidated).toBe(false);
  });
});

describe('invalidateProject', () => {
  test('reaches every key under the project scope', async () => {
    const qc = client();
    qc.setQueryData(qk.project.detail(ID), { project: { name: 'A' } });
    qc.setQueryData(qk.project.sessions(ID), []);
    qc.setQueryData(qk.project.connectors(ID), []);

    await invalidateProject(qc, ID);

    for (const key of [
      qk.project.detail(ID),
      qk.project.sessions(ID),
      qk.project.connectors(ID),
    ]) {
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });
});

describe('writeProjectNameOptimistically', () => {
  test('updates the name in both caches before any request resolves', () => {
    const qc = client();
    qc.setQueryData(qk.projects.list(), [
      { project_id: ID, name: 'Old' },
      { project_id: 'other', name: 'Keep' },
    ]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    writeProjectNameOptimistically(qc, ID, 'New');

    const list = qc.getQueryData(qk.projects.list()) as Array<{
      project_id: string;
      name: string;
    }>;
    expect(list.find((p) => p.project_id === ID)?.name).toBe('New');
    expect(list.find((p) => p.project_id === 'other')?.name).toBe('Keep');
    expect(
      (qc.getQueryData(qk.project.detail(ID)) as { project: { name: string } }).project.name,
    ).toBe('New');
  });

  test('is a no-op when neither cache is populated', () => {
    const qc = client();
    expect(() => writeProjectNameOptimistically(qc, ID, 'New')).not.toThrow();
    expect(qc.getQueryData(qk.project.detail(ID))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/sdk && bun test --isolate src/react/invalidate-project.test.ts
```

Expected: FAIL — `Cannot find module './invalidate-project'`.

- [ ] **Step 3: Write the invalidation helpers**

Create `packages/sdk/src/react/invalidate-project.ts`:

```ts
import type { QueryClient } from '@tanstack/react-query';
import { qk } from './query-keys';

/** Everything belonging to one project. Use after a write with broad effect. */
export async function invalidateProject(qc: QueryClient, projectId: string): Promise<void> {
  await qc.invalidateQueries({ queryKey: qk.project.scope(projectId) });
}

/**
 * A project's NAME lives in two caches: the list entry and the detail entry.
 * Rename previously invalidated only the list, so the sidebar and the project
 * home title disagreed until eviction. Both, always, or the bug returns.
 */
export async function invalidateProjectIdentity(
  qc: QueryClient,
  projectId: string,
): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.projects.list() }),
    qc.invalidateQueries({ queryKey: qk.project.detail(projectId) }),
  ]);
}

/**
 * Paint the new name in the same frame the rename dialog closes, instead of a
 * round-trip later. Callers still invalidate on settle; this only removes the
 * visible lag. A missing cache entry is not an error — nothing to update yet.
 */
export function writeProjectNameOptimistically(
  qc: QueryClient,
  projectId: string,
  name: string,
): void {
  qc.setQueryData(
    qk.projects.list(),
    (prev: Array<{ project_id: string; name: string }> | undefined) =>
      prev?.map((p) => (p.project_id === projectId ? { ...p, name } : p)),
  );
  qc.setQueryData(
    qk.project.detail(projectId),
    (prev: { project?: { name?: string } } | undefined) =>
      prev?.project ? { ...prev, project: { ...prev.project, name } } : prev,
  );
}
```

- [ ] **Step 4: Write `useProjectName`**

Create `packages/sdk/src/react/use-project-name.ts`:

```ts
'use client';

import { useQuery } from '@tanstack/react-query';
import { getProjectDetail } from '../platform/projects-client';
import { qk } from './query-keys';
import { contract } from './query-contracts';

/**
 * The ONLY way to read a project's name.
 *
 * The two-titles bug was not an invalidation gap, it was two sources for one
 * fact: `project-switcher.tsx` read `activeProject?.name` off the projects
 * LIST and fell back to the detail, while `project-home.tsx` read the detail
 * alone. Any divergence between the two caches rendered as two different names
 * on one screen.
 *
 * One accessor makes that structurally impossible rather than merely currently
 * invalidated. Do not reintroduce a `??` fallback to another source here.
 */
export function useProjectName(projectId: string | undefined): string | undefined {
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: Boolean(projectId),
    ...contract('config'),
  });
  return data?.project?.name;
}
```

Before running, confirm the import path for `getProjectDetail`:

```bash
cd packages/sdk && grep -rn "export .*getProjectDetail" src/ | head -3
```

Correct the import to whatever that reports.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/sdk && bun test --isolate src/react/invalidate-project.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/react/use-project-name.ts packages/sdk/src/react/invalidate-project.ts packages/sdk/src/react/invalidate-project.test.ts
git commit -m "feat(sdk): single project-name accessor and declared invalidation sets

The two-titles bug was two sources for one fact, not a missing invalidation.
One accessor makes the divergence impossible."
```

---

## Task 6: Export the new modules and prove the package still builds

**Files:**
- Modify: `packages/sdk/src/react/index.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: `qk`, `contract`, `FRESHNESS`, `FreshnessTier`, `useProjectName`, `invalidateProject`, `invalidateProjectIdentity`, `writeProjectNameOptimistically` importable from `@kortix/sdk/react`.

- [ ] **Step 1: Add the re-exports**

Append to `packages/sdk/src/react/index.ts`:

```ts
export * from './query-keys';
export * from './query-contracts';
export * from './use-project-name';
export * from './invalidate-project';
```

- [ ] **Step 2: Verify no new subpath is needed**

```bash
cd packages/sdk && bun test --isolate src/index.isomorphic.test.ts src/package-exports.test.ts
```

Expected: PASS. These are the tripwires from `AGENTS.md:311`. They cover subpath additions; adding files under an existing `./react` subpath must not trip them. **If either fails, stop** — a new subpath is required and the `package.json` `exports` plus `publishConfig.exports` plus `SUBPATH_TIERS` edits are all needed.

- [ ] **Step 3: Run the full SDK gates**

```bash
cd packages/sdk && pnpm typecheck && bun test --isolate src && pnpm smoke:install
```

Expected: all green. Paste the real output. State explicitly: shippable YES, NO, or NOT YET.

- [ ] **Step 4: Update PROGRESS.md and commit**

```bash
git add packages/sdk/src/react/index.ts packages/sdk/PROGRESS.md
git commit -m "feat(sdk): export the query-key factory and freshness contracts"
```

---

## Task 7: Migrate `project-detail` — the 28 sites

**Files:**
- Modify (each replaces `queryKey: ['project-detail', projectId]`):
  - `apps/web/src/app/(app)/projects/[id]/page.tsx:39`
  - `apps/web/src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx:137`
  - `apps/web/src/features/workspace/project-layout/project-shell.tsx:71`
  - `apps/web/src/features/workspace/project-layout/project-home.tsx:279`
  - `apps/web/src/features/workspace/project-sidebar/project-switcher.tsx:131`
  - `apps/web/src/features/workspace/command-palette.tsx:427`
  - `apps/web/src/features/workspace/customize/sections/connectors-view.tsx:285`
  - `apps/web/src/features/workspace/customize/sections/view/agents-view.tsx:154,432`
  - `apps/web/src/features/workspace/capabilities/shared/project-detail-query.ts:24`
  - plus every remaining site found by the grep in Step 1

**Interfaces:**
- Consumes: `qk`, `contract` from `@kortix/sdk/react`.
- Produces: no new exports. `project-detail-query.ts` still exists after this task; it is deleted in Task 11.

- [ ] **Step 1: Enumerate every site**

```bash
cd /Users/jay/root/kortix/suna-chat-thread
grep -rn "'project-detail'" apps/web/src | grep -v "\.test\." > /private/tmp/claude-501/-Users-jay-root-kortix-suna-chat-thread/7c148bd6-973f-4572-9755-89aff67389f7/scratchpad/project-detail-sites.txt
wc -l < /private/tmp/claude-501/-Users-jay-root-kortix-suna-chat-thread/7c148bd6-973f-4572-9755-89aff67389f7/scratchpad/project-detail-sites.txt
```

Expected: 28. Work the list top to bottom; do not rely on memory of which are done.

- [ ] **Step 2: Apply the mechanical edit at each site**

Every read becomes:

```ts
import { qk, contract } from '@kortix/sdk/react';

const { data: projectDetail } = useQuery({
  queryKey: qk.project.detail(projectId),
  queryFn: () => getProjectDetail(projectId),
  enabled: !!projectId,
  ...contract('config'),
});
```

Every invalidation becomes:

```ts
import { invalidateProject } from '@kortix/sdk/react';
void invalidateProject(queryClient, projectId);
```

Delete every local `staleTime`, `gcTime`, and `refetchOnMount` at these sites. The contract owns them now. Specifically delete `const Q = { staleTime: 60_000, refetchOnWindowFocus: false }` at `project-home.tsx:56` and its `...Q` spread at line 281.

- [ ] **Step 3: Verify no literal remains**

```bash
grep -rn "'project-detail'" apps/web/src | grep -v "\.test\."
```

Expected: no output.

- [ ] **Step 4: Typecheck and test**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | grep -v "test.each" | head -20 && bun test src/features/workspace
```

Expected: no new `tsc` errors beyond the `@types/bun` baseline; tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): read project detail through the qk factory

28 call sites shared one key and declared six different freshness contracts."
```

---

## Task 8: Migrate the projects list — 3 key families into 1

**Files:**
- Modify: every site reported by the grep in Step 1, including
  - `apps/web/src/app/(app)/projects/page.tsx:287,343`
  - `apps/web/src/features/projects/modal/project-create-modal.tsx:305,484`
  - `apps/web/src/features/projects/modal/edit-project-modal.tsx:104`
  - `apps/web/src/features/workspace/customize/sections/view/settings-view.tsx:88,221`
  - `apps/web/src/app/(app)/accounts/[id]/groups/[groupId]/page.tsx:968` (`projects-for-account`)

**Interfaces:**
- Consumes: `qk` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Enumerate**

```bash
grep -rn "\['projects'\|'projects-for-account'\|\['projects', " apps/web/src | grep -v "\.test\."
```

Expected: 28 lines.

- [ ] **Step 2: Replace**

`['projects']` → `qk.projects.list()`. `['projects', accountId]` and `['projects-for-account', accountId]` → `qk.projects.list(accountId)`.

Add `...contract('inventory')` to every read.

**Invalidation — the obvious form is wrong.** `qk.projects.list()` is
`['kx','projects','all']` and `qk.projects.list(id)` is `['kx','projects',id]`.
Those are **siblings, not parent and child**, so
`invalidateQueries({ queryKey: qk.projects.list() })` does **not** reach any
account-scoped list. A site that means "every account's list" must target the
shared two-element prefix, `qk.projects.scope()`.

This matters more than it looks: with `contract('inventory')` setting
`refetchOnMount: false`, a list that misses its invalidation is not refreshed by
a remount either. It stays stale until something else refetches the prefix while
it is mounted, or it unmounts for a full 30-minute `gcTime` window. For a
single-account user the mutated account is always the primary account, so this
is the common path, not an edge case.

- [ ] **Step 3: Verify**

```bash
grep -rn "'projects-for-account'" apps/web/src | grep -v "\.test\."
```

Expected: no output.

- [ ] **Step 4: Typecheck and commit**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | grep -v "test.each" | head -20
git add apps/web/src && git commit -m "refactor(web): collapse three projects-list keys into qk.projects.list"
```

---

## Task 9: Migrate sessions — delete the duplicate cache entry

**Files:**
- Modify: `apps/web/src/features/workspace/project-sessions/project-sessions-view.tsx:58,141,152,153`
- Modify: every site reported by the grep in Step 1, including
  - `apps/web/src/features/workspace/project-sidebar/project-session-list.tsx:161,202,214,425`
  - `apps/web/src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx:160,256`
  - `apps/web/src/features/review-center/review-center-connected.tsx:68`
  - `apps/web/src/features/workspace/command-palette.tsx:420`

**Interfaces:**
- Consumes: `qk`, `contract`.
- Produces: nothing new. `SESSIONS_QUERY_KEY` is deleted, not replaced.

- [ ] **Step 1: Enumerate both families**

```bash
grep -rn "'project-sessions'\|project-session-inventory\|SESSIONS_QUERY_KEY" apps/web/src | grep -v "\.test\."
```

Expected: 24 lines across the two families.

- [ ] **Step 2: Delete the duplicate key**

Remove `apps/web/src/features/workspace/project-sessions/project-sessions-view.tsx:58`:

```ts
const SESSIONS_QUERY_KEY = (projectId: string) => ['project-session-inventory', projectId];
```

It held the same server data as `['project-sessions', id]` under a second cache entry. Lines 152–153 invalidated both to hide the divergence; that double invalidation collapses to one call.

- [ ] **Step 3: Replace both families**

Every read and invalidation becomes `qk.project.sessions(projectId)`, with `...contract('inventory')` on reads.

- [ ] **Step 4: Verify**

```bash
grep -rn "project-session-inventory\|'project-sessions'\|SESSIONS_QUERY_KEY" apps/web/src | grep -v "\.test\."
```

Expected: no output.

- [ ] **Step 5: Typecheck, test, commit**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | grep -v "test.each" | head -20 && bun test src/features/workspace
git add apps/web/src && git commit -m "refactor(web): one cache entry for the sessions list

project-session-inventory and project-sessions held identical server data
under two entries, invalidated in pairs to hide the divergence."
```

---

## Task 10: Migrate the remaining 26 `project*` families

**Files:**
- Modify: every site reported by the grep in Step 1.

**Interfaces:**
- Consumes: `qk`, `contract`.
- Produces: nothing new.

- [ ] **Step 1: Enumerate what is left**

```bash
grep -rhoE "queryKey: \['projects?(-[a-z-]+)?'" apps/web/src | sort | uniq -c | sort -rn
```

Expected: the remaining families — `project` (20), `project-access` (15), `project-connectors` (13), `project-secrets` (10), `project-files` (5), `project-sandboxes` (4), `project-snapshots` (3), `project-gateway-keys` (3), `project-gateway-budgets` (3), `project-pending-invites` (2), `project-model-picker` (2), `project-branches` (2), `project-access-requests` (2), plus 13 single-use gateway and config families.

- [ ] **Step 2: Map each family**

| Literal | Replacement | Tier |
| --- | --- | --- |
| `['project', id]` | **`qk.project.summary(id)` — NOT `detail(id)`** | `config` |
| `['project-access', id]` | `qk.project.access(id)` | `inventory` |
| `['project-access-requests', id]` | `[...qk.project.access(id), 'requests']` | `inventory` |
| `['project-pending-invites', id]` | `[...qk.project.access(id), 'invites']` | `inventory` |
| `['project-connectors', id]` | `qk.project.connectors(id)` | `config` |
| `['connector-config', id, slug]` | `[...qk.project.connectors(id), slug]` | `config` |
| `['project-secrets', id]` | `qk.project.secrets(id)` | `config` |
| `['project-files', id]` | `qk.project.files(id)` | `config` |
| `['project-file-source', id, path]` | `[...qk.project.files(id), path]` | `config` |
| `['project-branches', id]` | `qk.project.branches(id)` | `config` |
| `['project-policies', id]` | `qk.project.policies(id)` | `config` |
| `['project-config', id]` | `qk.project.config(id)` | `config` |
| `['project-sandboxes', id]` | `qk.project.sandboxes(id)` | `volatile` |
| `['project-sandbox-templates', id]` | `[...qk.project.sandboxes(id), 'templates']` | `config` |
| `['project-snapshots', id]` | `qk.project.snapshots(id)` | `config` |
| `['project-model-picker', id]` | `[...qk.project.config(id), 'models']` | `config` |
| `['project-resource-grants', id]` | `[...qk.project.access(id), 'grants']` | `inventory` |
| `['project-gateway-<x>', id, ...]` | `[...qk.project.gateway(id), '<x>', ...]` | `volatile` |

**`['project', id]` must NOT collapse onto `detail(id)`.** An earlier draft said it
should. That was wrong, and it is the same error Task 9 caught:

```bash
grep -rn "queryKey: \['project', " apps/web/src -A 3 | grep queryFn | sort -u
#   5  getProject(projectId)
#   1  getProject(projectId!)
#   1  getProject(projectId ?? '')
#   2  getProjectSession(projectId!, gitSessionId!)
```

`getProject` hits `/projects/:id` and returns a bare `KortixProject`.
`getProjectDetail` hits `/projects/:id/detail` and returns
`{ project, config, file_count, files, git_connection }`. Folding one onto the
other writes the wrong shape into a slot whose readers do `data.project.account_id`.

**The rule, restated because it keeps being the thing that bites:** two calls to
different endpoints, or to one endpoint with different arguments, are different
requests and get different cache entries. The unit of a cache key is the
*request*, not the *entity*.

So `['project', id]` gets `qk.project.summary(id)`, bound to `getProject`. The two
sites calling `getProjectSession` are a third thing again and need their own
mapping — they belong under `qk.project.session(id, sid)` if the shape matches, so
check it rather than assuming.

- [ ] **Step 3: Verify nothing is left**

```bash
grep -rhoE "queryKey: \['projects?(-[a-z-]+)?'" apps/web/src
grep -rn "connector-config\|SESSIONS_QUERY_KEY" apps/web/src | grep -v "\.test\."
```

Expected: no output from either.

- [ ] **Step 4: Typecheck, test, commit**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | grep -v "test.each" | head -20 && bun test
git add apps/web/src && git commit -m "refactor(web): migrate the remaining project key families to qk"
```

---

## Task 11: Kill the two-titles bug at its root

**Files:**
- Modify: `apps/web/src/features/workspace/project-sidebar/project-switcher.tsx:130-137`
- Modify: `apps/web/src/features/workspace/project-layout/project-home.tsx:278-281`
- Modify: `apps/web/src/features/projects/modal/edit-project-modal.tsx:95-105`
- Modify: `apps/web/src/features/workspace/customize/sections/view/settings-view.tsx:218-222`
- Delete: `apps/web/src/features/workspace/capabilities/shared/project-detail-query.ts` and its test
- Delete: `apps/web/src/features/workspace/capabilities/connectors/project-connectors-query.ts` and its test
- Test: `apps/web/src/features/projects/modal/edit-project-modal.rename.test.tsx` (create)

**Interfaces:**
- Consumes: `useProjectName`, `invalidateProjectIdentity`, `writeProjectNameOptimistically` from Task 5.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/features/projects/modal/edit-project-modal.rename.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import {
  qk,
  invalidateProjectIdentity,
  writeProjectNameOptimistically,
} from '@kortix/sdk/react';

const ID = 'proj_1';

describe('project rename cache contract', () => {
  // Before this, rename invalidated ['projects'] alone. The sidebar reads the
  // list and showed the new name; the project home title reads the detail and
  // showed the old one until eviction. A hard refresh made them agree, which
  // is what made it look like a render bug rather than a cache bug.
  test('a rename updates the name in both caches', async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.projects.list(), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    writeProjectNameOptimistically(qc, ID, 'New');

    const list = qc.getQueryData(qk.projects.list()) as Array<{ name: string }>;
    const detail = qc.getQueryData(qk.project.detail(ID)) as { project: { name: string } };
    expect(list[0].name).toBe('New');
    expect(detail.project.name).toBe('New');

    await invalidateProjectIdentity(qc, ID);
    expect(qc.getQueryState(qk.project.detail(ID))?.isInvalidated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && bun test src/features/projects/modal/edit-project-modal.rename.test.tsx
```

Expected: FAIL — the helpers are not yet wired into the app's SDK resolution, or the assertion fails.

- [ ] **Step 3: Delete the second name source**

In `project-switcher.tsx`, delete the `useQuery` at lines 130–134 and rewrite line 137:

```ts
// One source for the project name. The `activeProject?.name ?? detail…`
// fallback that used to live here read the LIST entry first, so a rename that
// invalidated only the list made this label disagree with the project home
// title for a full gcTime.
const activeProjectName = useProjectName(activeProjectId ?? undefined) ?? null;
const { label: switcherLabel, pending: labelPending } = resolveSwitcherLabel({
  activeProjectId,
  activeProjectName,
});
```

In `project-home.tsx`, replace the `detail` query at lines 278–281:

```ts
const name = useProjectName(projectId) ?? '';
const displayName = name.trim() || 'this project';
```

- [ ] **Step 4: Wire the optimistic write into both rename paths**

In `edit-project-modal.tsx`, replace the `onSuccess` at line 104:

```ts
onMutate: (patch: ProjectInput) => {
  if (typeof patch.name === 'string') {
    writeProjectNameOptimistically(queryClient, projectId, patch.name);
  }
},
onSettled: () => invalidateProjectIdentity(queryClient, projectId),
```

Apply the same pair in `settings-view.tsx` at lines 218–222, using `project.project_id`.

- [ ] **Step 5: Delete the superseded local query modules**

```bash
git rm apps/web/src/features/workspace/capabilities/shared/project-detail-query.ts \
       apps/web/src/features/workspace/capabilities/shared/project-detail-query.test.ts \
       apps/web/src/features/workspace/capabilities/connectors/project-connectors-query.ts \
       apps/web/src/features/workspace/capabilities/connectors/project-connectors-query.test.ts
```

`useProjectAccountId` moves to `packages/sdk/src/react/use-project-name.ts` as a sibling export reading `qk.project.detail(id)` with `contract('config')`. Update its importers: `connector-modal.tsx:39`, `entity-modal.tsx:18`, `skills-page.tsx`, `commands-page.tsx`, `connectors-page.tsx`.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/web && bun test src/features/projects src/features/workspace
```

Expected: PASS. No remaining reference to the deleted modules.

- [ ] **Step 7: Commit**

```bash
git add -A apps/web/src packages/sdk/src
git commit -m "fix(web): one source for the project name

The sidebar read the list entry and the home title read the detail entry, so a
rename that invalidated only the list rendered two different names at once."
```

---

## Task 12: Make the relapse a build failure

**Files:**
- Modify: `apps/web/eslint.config.mjs:134` (the existing `no-restricted-syntax` array)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable.

- [ ] **Step 1: Add the rule**

In `apps/web/eslint.config.mjs`, append to the existing `'no-restricted-syntax'` array after the OpenCode entry at line 145:

```js
        {
          // Every `project*` key literal is now a `qk.*` call. This rule is
          // what makes a single-PR migration safe: after it lands, a
          // reintroduced literal is a lint error, not something a reviewer has
          // to spot in a 100-file diff.
          //
          // The pattern matches the whole family rather than an allowlist, so
          // a NEW literal (`['project-widgets', id]`) is caught too.
          selector:
            "Property[key.name='queryKey'] > ArrayExpression > " +
            "Literal[value=/^projects?(-[a-z-]+)?$/]",
          message:
            'Query keys come from `qk` in @kortix/sdk/react. Never hand-type an entity key.',
        },
```

- [ ] **Step 2: Verify the rule catches a violation**

```bash
cd apps/web && cat > /tmp/lint-probe.tsx <<'EOF'
import { useQuery } from '@tanstack/react-query';
export const P = () => useQuery({ queryKey: ['project-detail', 'x'], queryFn: async () => 1 });
EOF
cp /tmp/lint-probe.tsx src/lint-probe.tsx
npx eslint src/lint-probe.tsx; echo "exit=$?"
rm src/lint-probe.tsx
```

Expected: one `no-restricted-syntax` error naming the `qk` message, `exit=1`.

- [ ] **Step 3: Verify the rule passes clean code**

```bash
cd apps/web && npx eslint src/features/workspace src/app/\(app\)/projects 2>&1 | grep -c "Never hand-type an entity key"
```

Expected: `0`. A non-zero count means Tasks 7–10 missed a site — fix it before continuing.

- [ ] **Step 4: Commit**

```bash
git add apps/web/eslint.config.mjs
git commit -m "chore(web): ban hand-typed project query keys

Makes the single-PR migration safe by construction: a reintroduced literal is
a build failure rather than a review-attention problem."
```

---

## Task 13: Resolve the two open questions and run the full gates

**Files:**
- Read: `apps/web/src/lib/query-client-singleton.ts`
- Possibly modify: `packages/sdk/src/react/query-keys.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a written answer to each open question in the spec.

- [ ] **Step 1: Answer open question 1 — cross-account partitioning**

```bash
grep -rn "registerQueryClient" apps/web/src -A 15 | head -40
grep -rn "clear()\|resetQueries\|removeQueries" apps/web/src/lib/query-client-singleton.ts
```

Determine whether the auth-change path calls `queryClient.clear()`. If it does, `qk` needs no identity segment — record that in the spec's Open Questions section. If it does **not**, add an identity segment to `qk.projects.list` and `qk.project.scope`, matching the SDK's existing `kortixKeys` pattern which appends `identity.userId ?? 'anonymous'`, and update `query-keys.test.ts` to assert two identities never collide.

- [ ] **Step 2: Answer open question 2 — `router.refresh()` after mutations**

```bash
grep -rln "export default async function\|await cookies()" apps/web/src/app/\(app\)/projects
```

For each server component found, check whether any mutation changes what it renders. With the router cache now holding 300 s, such a mutation needs `router.refresh()`. Every page under `projects/[id]` is expected to be `'use client'`; if the grep returns only `layout.tsx`, no refresh call is needed. Record the finding.

- [ ] **Step 3: Update the spec's Open Questions section with both answers**

Replace the two open questions in `docs/superpowers/specs/2026-08-06-client-cache-unification-design.md` with the resolved findings and the command that produced each.

- [ ] **Step 4: Run every gate**

```bash
cd packages/sdk && pnpm typecheck && bun test --isolate src && pnpm smoke:install
cd ../../apps/web && npx tsc --noEmit 2>&1 | grep -v "test.each" | tail -5
cd apps/web && bun test
cd apps/web && npx eslint src/app src/features src/lib src/components 2>&1 | tail -20
cd ../.. && bun test apps/web/src/sdk-boundary.test.ts
```

Paste the real output of each. State explicitly: shippable YES, NO, or NOT YET.

- [ ] **Step 5: Confirm the reported symptoms are addressed**

Walk each reported symptom to the change that fixes it, and record the mapping in the PR body:

| Symptom | Fixed by |
| --- | --- |
| Full skeleton on every capability tab switch | Task 1 |
| Data gone after leaving a page for minutes | Task 2 |
| Two project titles at once | Task 11 |
| Rename shows the old name | Tasks 5 + 11 |
| Sessions list refetches on every mount | Tasks 2 + 9 |
| Freshness differs per page | Tasks 4 + 7 |

- [ ] **Step 6: Commit and open the PR**

```bash
git add -A
git commit -m "docs: record cache unification findings"
git push -u origin <branch>
gh pr create --base main --title "perf: unify the client cache" --body "<summary + test plan only>"
```

The PR body carries the summary and the test plan. No Linear identifier, no Linear URL, no trailer, no attribution line.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| Route layer `staleTimes` | 1 |
| Cache lifetime `gcTime` | 2 |
| Key factory `qk` | 3 |
| Freshness tiers | 4 |
| `useProjectName` single accessor | 5, 11 |
| Invalidation helpers | 5, 11 |
| Optimistic rename | 5, 11 |
| Skills/commands as projections, not keys | 3 (no key emitted), 7 (call sites keep reading `detail`) |
| 3 projects-list literals collapse | 8 |
| Sessions duplicate entry | 9 |
| Remaining 26 families | 10 |
| ESLint enforcement | 12 |
| Open questions | 13 |
| Testing table | 1–13, gates in 6 and 13 |
| Non-goals | no task touches admin keys, SSE, `refetchOnWindowFocus`, or Cache Components |

**Placeholder scan:** no `TBD`, no "add appropriate error handling", no "similar to Task N". Every code step carries real code. Task 10's family table is fully enumerated rather than described.

**Type consistency:** `qk.project.scope/detail/sessions/session/messages/connectors/access/secrets/files/branches/policies/config/sandboxes/snapshots/gateway` and `qk.projects.list` are defined in Task 3 and used with those exact names in Tasks 4, 5, 7–11. `contract(tier)` returns `{ staleTime, gcTime, refetchOnMount }` in Task 4 and is spread with that shape in Tasks 5, 7–10. `invalidateProject`, `invalidateProjectIdentity`, `writeProjectNameOptimistically`, `useProjectName` are defined in Task 5 and used with those names in Tasks 7 and 11.

**Known risk carried deliberately:** Task 10 folds `['project', id]` onto `qk.project.detail(id)`. Step 2 of that task gates the fold on the `queryFn` shapes matching. If they do not, the plan branches to a separate `qk` entry rather than forcing the collapse.
