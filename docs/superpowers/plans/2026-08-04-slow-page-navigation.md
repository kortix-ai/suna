# Slow Page Navigation Fix + Next.js 16 Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project page-to-page navigation respond instantly by removing
blocking per-navigation server work and giving dynamic routes a prefetchable
loading boundary, and move `apps/web` to Next.js 16.2.0.

**Architecture:** Four independent navigation fixes in `apps/web`
(maintenance-config TTL cache in middleware's path, removal of a duplicate auth
round-trip in the project layout, a `loading.tsx` boundary for
`projects/[id]/`, and deletion of dead auth constants), followed by the Next.js
16 upgrade split into a core bump and a separate fumadocs major so the latter
can be dropped without losing the former.

**Tech Stack:** Next.js 16.2.0, React 19.2, TypeScript 5, `bun:test`, pnpm 8
workspaces, Supabase SSR, Turbopack.

**Spec:** `docs/superpowers/specs/2026-08-04-project-navigation-latency-design.md`

## Global Constraints

- Work in the existing worktree `/Users/jay/root/kortix/suna-next-16` on a NEW
  branch `fix/slow-page-navigation`, cut from `next-16` (which is identical to
  `main`).
- **Commits are authorized for this work.** The user explicitly asked for the
  change to be committed on a branch and for a PR to be opened. Commit at the
  end of each task as written. Push and PR happen once, in Task 6, after
  verification — not per task.
- **Commit messages carry no trailers.** No `Co-Authored-By`, no "Generated with
  Claude Code", no session URL, no AI attribution of any kind. The message ends
  after the body. The PR body contains only summary and test plan.
- TDD is mandatory: write the failing test, observe it fail, implement, observe
  it pass. Never write implementation before a red test.
- Verification is code + `bun test` + `eslint` + `tsc` + `next build`. **No
  browser, no dev stacks** — standing user instruction that overrides the repo
  `CLAUDE.md` end-to-end section.
- `tsc --noEmit` in `apps/web` emits ~1500 bogus `TS2786` /
  `IntrinsicAttributes` errors from a React 19↔18 types mismatch. Grep for the
  files you changed; ignore the rest.
- Do not add `experimental.staleTimes`. Do not rename `middleware.ts` to
  `proxy.ts`. Do not touch `sessions/[sessionId]/` or any session loader
  component. All four are explicit non-goals.
- Node 22 is required (`nvm use 22`). Next 16 needs ≥ 20.9.
- Secrets are dotenvx-encrypted. Never write a plaintext secret into a tracked
  file.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/web/src/lib/maintenance-store.ts` | add TTL cache + coalescing + test reset around `getMaintenanceConfig` | 1 |
| `apps/web/src/lib/maintenance-store.test.ts` | extend with TTL/coalescing/invalidation tests | 1 |
| `apps/web/src/app/(app)/projects/[id]/layout.tsx` | drop the duplicate Supabase auth check | 2 |
| `apps/web/src/middleware.ts` | delete `PROTECTED_ROUTES`, `BILLING_ROUTES` and its dead branch | 2 |
| `apps/web/src/app/(app)/projects/[id]/project-layout-auth-contract.test.ts` | pin the middleware invariant that makes Task 2 safe | 2 |
| `apps/web/src/app/(app)/projects/[id]/loading.tsx` | prefetchable loading boundary for project home | 3 |
| `apps/web/src/app/(app)/projects/[id]/project-loading-contract.test.ts` | keep the boundary payload small | 3 |
| `apps/web/package.json`, `apps/whitelabel-demo/package.json`, `package.json` | Next 16 dependency bumps + scripts | 4 |
| `apps/web/next.config.ts` | remove `webpack` block and removed `eslint` key | 4 |
| `apps/web/src/app/layout.tsx` | `data-scroll-behavior="smooth"` on `<html>` | 4 |
| fumadocs deps + 11 consuming files | fumadocs 16 major | 5 |

---

### Task 1: TTL-cache the maintenance config

Removes an uncached network fetch from the critical path of every production
page-to-page navigation.

**Files:**
- Modify: `apps/web/src/lib/maintenance-store.ts:128-158`
- Test: `apps/web/src/lib/maintenance-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `getMaintenanceConfig(): Promise<MaintenanceConfig>` — unchanged public signature.
  - `setMaintenanceConfig(config: MaintenanceConfig, accessToken: string): Promise<MaintenanceConfig>` — unchanged signature, now invalidates the cache.
  - `__resetMaintenanceCacheForTests(): void` — new, test-only.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/jay/root/kortix/suna-next-16
git checkout -b fix/slow-page-navigation
```

- [ ] **Step 2: Wire the cache reset into the existing `beforeEach`**

The existing test file imports the module once at file scope
(`maintenance-store.test.ts:42`) and asserts exact `events` arrays. A
module-scope cache is shared across tests, so without this reset the existing
tests fail. Change the import line at `:42` to also pull the reset, and add the
call as the first line of `beforeEach` (`:44`).

```ts
const { getMaintenanceConfig, setMaintenanceConfig, __resetMaintenanceCacheForTests } =
  await import('./maintenance-store');

beforeEach(() => {
  __resetMaintenanceCacheForTests();
  databaseConfig = {
```

- [ ] **Step 3: Write the failing tests**

Append inside the existing `describe('maintenance store', ...)` block in
`apps/web/src/lib/maintenance-store.test.ts`:

```ts
  test('serves a cached config within the TTL window', async () => {
    const first = await getMaintenanceConfig();
    events = [];

    const second = await getMaintenanceConfig();

    expect(second).toEqual(first);
    expect(events).toEqual([]);
  });

  test('coalesces concurrent reads into a single upstream read', async () => {
    const [a, b, c] = await Promise.all([
      getMaintenanceConfig(),
      getMaintenanceConfig(),
      getMaintenanceConfig(),
    ]);

    expect(a).toEqual(databaseConfig);
    expect(b).toEqual(databaseConfig);
    expect(c).toEqual(databaseConfig);
    expect(events.filter((event) => event === 'database-read')).toHaveLength(1);
  });

  test('setMaintenanceConfig invalidates the cache immediately', async () => {
    await getMaintenanceConfig();

    await setMaintenanceConfig(
      {
        level: 'blocking',
        title: 'Lockdown',
        message: 'Paused.',
        updatedAt: 'request-time',
      },
      'admin-token',
    );
    events = [];

    await getMaintenanceConfig();

    expect(events).toContain('database-read');
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
cd apps/web && bun test src/lib/maintenance-store.test.ts
```

Expected: FAIL. `__resetMaintenanceCacheForTests is not a function` on every
test, because the export does not exist yet.

- [ ] **Step 5: Implement the cache**

In `apps/web/src/lib/maintenance-store.ts`, rename the existing exported
`getMaintenanceConfig` (line 128) to a private `readMaintenanceConfig` — keep
its body byte-for-byte, including the `if (!process.env.EDGE_CONFIG) return
{ ...memoryStore };` guard and the whole try/catch. Then add above it:

```ts
/**
 * Middleware calls getMaintenanceConfig() on every non-public request, and in
 * the App Router every client-side navigation is an RSC request that runs
 * middleware. Uncached, that put a `no-store` fetch (2s timeout ceiling) plus an
 * Edge Config read on the critical path of EVERY page-to-page transition.
 *
 * A 5s TTL takes that off the critical path without making the flag unusable: a
 * blocking lockdown engages up to 5s later per serverless instance, and an admin
 * toggle stays immediate because setMaintenanceConfig() invalidates synchronously.
 *
 * `inFlight` coalesces: a burst of concurrent navigations on a cold cache shares
 * one upstream read instead of issuing one each.
 */
const CONFIG_TTL_MS = 5_000;
let cachedConfig: { value: MaintenanceConfig; expiresAt: number } | null = null;
let inFlight: Promise<MaintenanceConfig> | null = null;

function invalidateMaintenanceCache(): void {
  cachedConfig = null;
  inFlight = null;
}

/** Test-only. Clears the TTL cache so each test starts from a cold cache. */
export function __resetMaintenanceCacheForTests(): void {
  invalidateMaintenanceCache();
}

export async function getMaintenanceConfig(): Promise<MaintenanceConfig> {
  // The memory-store path does no I/O, so caching it would only add staleness.
  if (!process.env.EDGE_CONFIG) return { ...memoryStore };

  if (cachedConfig && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  if (inFlight) return inFlight;

  inFlight = readMaintenanceConfig()
    .then((config) => {
      cachedConfig = { value: config, expiresAt: Date.now() + CONFIG_TTL_MS };
      return config;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
```

- [ ] **Step 6: Invalidate on write**

In `setMaintenanceConfig` (line ~182), add the invalidation to **both** return
paths so the non-Edge-Config path cannot drift later:

```ts
export async function setMaintenanceConfig(
  config: MaintenanceConfig,
  accessToken: string,
): Promise<MaintenanceConfig> {
  invalidateMaintenanceCache();

  if (!process.env.EDGE_CONFIG) {
    memoryStore = { ...config };
    return { ...memoryStore };
  }

  const saved = await sdkSetMaintenanceConfig<MaintenanceConfig>(config, {
    backendUrl: backendUrl(),
    accessToken,
  });
  await writeEdgeConfig(saved);
  return saved;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/web && bun test src/lib/maintenance-store.test.ts
```

Expected: PASS, 7 tests — the 4 pre-existing plus the 3 new. If any of the 4
pre-existing tests fail, the reset in Step 2 was not wired correctly; fix that
rather than weakening their `events` assertions.

- [ ] **Step 8: Lint and typecheck**

```bash
cd apps/web && npx eslint src/lib/maintenance-store.ts src/lib/maintenance-store.test.ts
```

Expected: clean.

- [ ] **Step 9: Commit (ASK THE USER FIRST)**

```bash
git add apps/web/src/lib/maintenance-store.ts apps/web/src/lib/maintenance-store.test.ts
git commit -m "perf(web): cache the maintenance config off the navigation path

Middleware read the maintenance config on every non-public request, and every
client-side navigation is an RSC request that runs middleware. In production
that put an uncached fetch plus an Edge Config read on the critical path of
every page-to-page transition.

A 5s TTL with in-flight coalescing removes it. Admin toggles stay immediate
because setMaintenanceConfig invalidates synchronously."
```

---

### Task 2: Remove the duplicate auth round-trip and the dead constants that hide the real gate

**Files:**
- Modify: `apps/web/src/app/(app)/projects/[id]/layout.tsx:1-31`
- Modify: `apps/web/src/middleware.ts:132`, `:135`, `:494-497`
- Create: `apps/web/src/app/(app)/projects/[id]/project-layout-auth-contract.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: no new exports. The layout keeps its default export
  `ProjectLayout({ children, params }: ProjectLayoutProps)`.

- [ ] **Step 1: Write the failing contract test**

Create `apps/web/src/app/(app)/projects/[id]/project-layout-auth-contract.test.ts`.

This test is the load-bearing guard for the whole task: it converts the
invisible assumption "middleware already authenticated this request" into a
failing test if anyone ever makes `/projects` public.

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dir, '../../../../..');
const LAYOUT = resolve(WEB_ROOT, 'src/app/(app)/projects/[id]/layout.tsx');
const MIDDLEWARE = resolve(WEB_ROOT, 'src/middleware.ts');

/**
 * The project layout deliberately does NOT verify the session: middleware
 * already did, and doing it again cost a second GoTrue round-trip on every
 * project switch and hard load.
 *
 * That is only safe while middleware default-denies `/projects`. These tests pin
 * that invariant, so making `/projects` public fails here loudly instead of
 * silently rendering the project shell to a signed-out visitor.
 */
describe('project layout auth contract', () => {
  test('middleware does not treat /projects as a public route', () => {
    const source = readFileSync(MIDDLEWARE, 'utf8');
    const publicRoutes = source.slice(
      source.indexOf('const PUBLIC_ROUTES'),
      source.indexOf('const STATIC_PUBLIC_ROUTES'),
    );

    expect(publicRoutes.length).toBeGreaterThan(0);
    expect(publicRoutes).not.toMatch(/'\/projects'/);
  });

  test('middleware still redirects unauthenticated non-public traffic to /auth', () => {
    const source = readFileSync(MIDDLEWARE, 'utf8');

    expect(source).toContain('if (authError || !user)');
    expect(source).toContain("url.pathname = '/auth'");
  });

  test('the project layout does not create a Supabase server client', () => {
    const source = readFileSync(LAYOUT, 'utf8');

    expect(source).not.toContain('@/lib/supabase/server');
    expect(source).not.toContain('auth.getUser');
  });
});
```

- [ ] **Step 2: Run it to verify the third test fails**

```bash
cd apps/web && bun test "src/app/(app)/projects/[id]/project-layout-auth-contract.test.ts"
```

Expected: the first two tests PASS (they describe today's middleware), the third
FAILS on `expect(source).not.toContain('@/lib/supabase/server')` because the
layout still imports it. That split is intentional — the passing tests document
the precondition, the failing one drives the change.

- [ ] **Step 3: Remove the duplicate auth check from the layout**

Replace the entire contents of
`apps/web/src/app/(app)/projects/[id]/layout.tsx` with:

```tsx
import { cookies } from 'next/headers';

import { LlmCatalogBootstrap } from '@/components/projects/llm-catalog-bootstrap';
import { ProjectAccessBoundary } from '@/components/projects/project-access-boundary';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';

interface ProjectLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

/**
 * Shell for every /projects/[id] route.
 *
 * It deliberately does NOT verify the session. Middleware default-denies every
 * route outside PUBLIC_ROUTES, so an unauthenticated request never reaches this
 * layout — it is already redirected to /auth. Re-checking here meant a second
 * GoTrue round-trip on every project switch and hard load, in series behind the
 * one middleware had just made.
 *
 * `project-layout-auth-contract.test.ts` pins that invariant: adding '/projects'
 * to PUBLIC_ROUTES fails the suite rather than silently rendering this shell to
 * a signed-out visitor.
 *
 * The bare `await cookies()` stays. It is the deliberate opt-in that keeps this
 * subtree dynamically rendered; removing it changes rendering semantics well
 * beyond the scope of this change.
 */
export default async function ProjectLayout({ children, params }: ProjectLayoutProps) {
  void (await cookies());

  const { id: projectId } = await params;

  return (
    <ProjectAccessBoundary projectId={projectId}>
      <LlmCatalogBootstrap projectId={projectId} />
      <ProjectShell projectId={projectId}>{children}</ProjectShell>
    </ProjectAccessBoundary>
  );
}
```

- [ ] **Step 4: Delete the dead middleware constants**

In `apps/web/src/middleware.ts`:

Delete lines 131-135 (the `BILLING_ROUTES` and `PROTECTED_ROUTES` declarations
and their comments):

```ts
// Routes that require authentication but are related to billing/setup
const BILLING_ROUTES: string[] = [];

// Routes that require authentication and active subscription
const PROTECTED_ROUTES = ['/projects', '/accounts', '/invites', '/admin'];
```

Then delete the dead branch at lines 494-497, which returns exactly what the
line after it returns:

```ts
    // ── Billing-related routes (activate-trial, etc.) ────────────────────
    if (BILLING_ROUTES.some((route) => pathname.startsWith(route))) {
      return supabaseResponse;
    }
```

Leave everything else in the `try` block untouched.

- [ ] **Step 5: Verify no references remain**

```bash
cd /Users/jay/root/kortix/suna-next-16 && grep -rn "PROTECTED_ROUTES\|BILLING_ROUTES" apps/web/src/
```

Expected: no output.

- [ ] **Step 6: Run the contract test and the full web suite**

```bash
cd apps/web && bun test "src/app/(app)/projects/[id]/project-layout-auth-contract.test.ts" && bun test
```

Expected: the contract test PASSES all three, and the full suite is green. A
failure elsewhere means something imported the layout's auth behavior — stop and
report rather than weakening the test.

- [ ] **Step 7: Lint and typecheck**

```bash
cd apps/web && npx eslint "src/app/(app)/projects/[id]/layout.tsx" src/middleware.ts "src/app/(app)/projects/[id]/project-layout-auth-contract.test.ts"
npx tsc --noEmit 2>&1 | grep -E "projects/\[id\]/layout|middleware" || echo "no errors in changed files"
```

Expected: eslint clean; the tsc grep prints the "no errors" fallback. Ignore all
other tsc output (~1500 known-bogus TS2786).

- [ ] **Step 8: Commit (ASK THE USER FIRST)**

```bash
git add "apps/web/src/app/(app)/projects/[id]/layout.tsx" apps/web/src/middleware.ts "apps/web/src/app/(app)/projects/[id]/project-layout-auth-contract.test.ts"
git commit -m "perf(web): stop re-verifying auth in the project layout

The layout called supabase.auth.getUser() to redirect signed-out visitors, but
middleware default-denies everything outside PUBLIC_ROUTES and had already made
that exact call. The second round-trip ran in series behind the first on every
project switch and hard load.

A contract test pins the invariant that makes the removal safe, so adding
/projects to PUBLIC_ROUTES fails loudly instead of un-authing the shell.

Also deletes PROTECTED_ROUTES (declared, never read) and the BILLING_ROUTES
no-op branch. Both described an auth gate the code does not use, which is
exactly the thing a reviewer of this change needs to be able to trust."
```

---

### Task 3: Add the prefetchable loading boundary for project home

Next.js prefetches a dynamic route only as far as its nearest `loading.tsx`.
`projects/[id]/` has none, so prefetching is skipped entirely and a click waits
out a full server round-trip with nothing on screen.

**Files:**
- Create: `apps/web/src/app/(app)/projects/[id]/loading.tsx`
- Create: `apps/web/src/app/(app)/projects/[id]/project-loading-contract.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: default export `ProjectHomeLoading(): JSX.Element`.

- [ ] **Step 1: Write the failing contract test**

Create `apps/web/src/app/(app)/projects/[id]/project-loading-contract.test.ts`.
It mirrors the existing `files/files-route-contract.test.ts` convention.

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dir, '../../../../..');
const LOADING = resolve(WEB_ROOT, 'src/app/(app)/projects/[id]/loading.tsx');

/**
 * Modules too heavy to sit in the loading boundary's payload. ProjectHome is on
 * the list because it pulls the composer, SessionWelcome and the billing stack —
 * the whole point of this boundary is a payload small enough to prefetch.
 */
const HEAVY = [
  '@/features/project-files',
  '@/features/file-viewer',
  '@/features/workspace/project-layout/project-home',
];

/** Matches import specifiers rather than raw text, so a doc comment ABOUT an
 * import cannot fail the test. Same approach as files-route-contract.test.ts. */
function importedSpecifiers(source: string): string[] {
  return [
    ...[...source.matchAll(/import\s[^;]*?from\s+'([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/import\s+'([^']+)'/g)].map((m) => m[1]),
  ];
}

describe('project home loading boundary', () => {
  test('exists', () => {
    expect(existsSync(LOADING)).toBe(true);
  });

  test('default-exports a component', () => {
    expect(readFileSync(LOADING, 'utf8')).toContain('export default function');
  });

  test('imports no heavy feature module', () => {
    const specifiers = importedSpecifiers(readFileSync(LOADING, 'utf8'));

    const offenders = specifiers.filter((specifier) =>
      HEAVY.some((heavy) => specifier === heavy || specifier.startsWith(`${heavy}/`)),
    );

    expect(offenders).toEqual([]);
  });

  test("matches ProjectHome's root container so the handover does not shift layout", () => {
    const source = readFileSync(LOADING, 'utf8');

    expect(source).toContain('relative flex min-h-0 flex-1 flex-col overflow-hidden');
    expect(source).toContain('px-4.5');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web && bun test "src/app/(app)/projects/[id]/project-loading-contract.test.ts"
```

Expected: FAIL — all four tests, starting with `existsSync(LOADING)` returning
`false`.

- [ ] **Step 3: Create the loading boundary**

Create `apps/web/src/app/(app)/projects/[id]/loading.tsx`. The container classes
are copied from `ProjectHome`'s root (`project-home.tsx:140-142`), NOT from
`page.tsx` — `page.tsx` has no wrapper of its own, it returns `<ProjectHome>`
directly.

```tsx
/**
 * Navigation Suspense boundary for /projects/[id].
 *
 * Two jobs, the same two as the sibling boundary at files/loading.tsx:
 *  1. Paint project chrome the instant the click lands, instead of leaving the
 *     previous page frozen while the RSC payload and route chunk arrive.
 *  2. Give Next.js a prefetch target. This route is dynamic — the project layout
 *     awaits cookies() — and for a dynamic route Next.js prefetches only as far
 *     as the nearest loading boundary. Without this file, prefetching this route
 *     is skipped altogether and every click pays a full server round-trip.
 *
 * Deliberately imports nothing: no ProjectHome (composer + SessionWelcome +
 * billing), no UI primitives. Plain markup keeps the prefetched payload small,
 * which is the entire point of the boundary.
 *
 * The outer container mirrors ProjectHome's root so the handover does not shift
 * layout. project-loading-contract.test.ts pins both properties.
 */
export default function ProjectHomeLoading() {
  return (
    <div className="bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden px-4.5">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="m-auto flex w-full max-w-[52rem] flex-col items-center gap-8 px-2 py-8 sm:px-4">
          {/* Greeting line */}
          <div className="bg-muted-foreground/10 h-9 w-[22rem] max-w-full animate-pulse rounded-md" />

          {/* Composer */}
          <div className="bg-muted-foreground/10 h-28 w-full animate-pulse rounded-xl" />

          {/* Suggestion row */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <div className="bg-muted-foreground/10 h-8 w-32 animate-pulse rounded-md" />
            <div className="bg-muted-foreground/10 h-8 w-40 animate-pulse rounded-md" />
            <div className="bg-muted-foreground/10 h-8 w-28 animate-pulse rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && bun test "src/app/(app)/projects/[id]/project-loading-contract.test.ts"
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Lint**

```bash
cd apps/web && npx eslint "src/app/(app)/projects/[id]/loading.tsx" "src/app/(app)/projects/[id]/project-loading-contract.test.ts"
```

Expected: clean.

- [ ] **Step 6: Commit (ASK THE USER FIRST)**

```bash
git add "apps/web/src/app/(app)/projects/[id]/loading.tsx" "apps/web/src/app/(app)/projects/[id]/project-loading-contract.test.ts"
git commit -m "perf(web): add a loading boundary to /projects/[id]

Next.js prefetches a dynamic route only as far as its nearest loading.tsx. This
route is dynamic (the layout awaits cookies()) and had no boundary, so
prefetching was skipped entirely: every click paid a full server round-trip with
nothing on screen.

The sibling files/ route already had one, with a comment explaining exactly this.
It was never applied here."
```

---

### Task 4: Upgrade to Next.js 16.2.0 (core)

Everything except fumadocs, so a fumadocs stall cannot block the rest.

**Files:**
- Modify: `apps/web/package.json`, `apps/whitelabel-demo/package.json`, `package.json`
- Modify: `apps/web/next.config.ts`
- Modify: `apps/web/src/app/layout.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1-3.
- Produces: no new exports.

- [ ] **Step 1: Read the version-matched agent docs**

Next 16 differs from training data. Before editing, generate the local docs
pointer so subsequent steps are grounded:

```bash
cd /Users/jay/root/kortix/suna-next-16 && npx @next/codemod@canary agents-md
```

If it writes an `AGENTS.md` block, read it. If it fails, continue — the breaking
changes needed are enumerated below.

- [ ] **Step 2: Bump the core packages**

In `apps/web/package.json`:

**VERSION CONSTRAINT — read this before touching any version number.**
The repo `.npmrc` sets `minimum-release-age=4320` (72 hours): pnpm REFUSES any
package published less than 3 days ago. This is deliberate supply-chain
hardening and must NOT be weakened. `next@16.2.0` (published 2026-08-03,
~17h old at planning time) is therefore uninstallable, along with
`next-intl@4.13.5`, `@next/third-parties@16.3.0`, `eslint-config-next@16.3.0`
and `fumadocs-mdx@15.2.2`. The user chose to target **16.2.0** rather than
weaken the control. Every version below has been verified to clear the cooldown
and to have compatible peer ranges. Do NOT "helpfully" bump any of them to a
newer version, and do NOT add anything to `minimumReleaseAgeExclude`.

| Key | From | To | Age at planning |
|---|---|---|---|
| `dependencies.next` | `"15.5.21"` | `"16.2.0"` | 138.9d |
| `dependencies.react` | `"^19.1.0"` | `"^19.2.0"` | 306.7d |
| `dependencies.react-dom` | `"^19.1.0"` | `"^19.2.0"` | 306.7d |
| `dependencies.@next/third-parties` | `"^15.3.1"` | `"^16.2.0"` | 138.9d |
| `dependencies.@sentry/nextjs` | `"^10.47.0"` | `"^10.69.0"` | 6.1d |
| `dependencies.next-intl` | `"^4.5.3"` | `"^4.13.4"` | 12.0d |
| `dependencies.@logtail/next` | `"^0.3.1"` | `"^0.4.0"` | 18.1d |
| `devDependencies.eslint-config-next` | `"15.2.2"` | `"16.2.0"` | 138.9d |
| `devDependencies.@types/react` | `"^19.1.17"` | `"^19.2.0"` | — |
| `devDependencies.@types/react-dom` | `"^19.2.3"` | `"^19.2.0"` | — |

In `apps/whitelabel-demo/package.json`: `"next": "15.5.21"` → `"16.2.0"`.

In the root `package.json`, `pnpm.overrides`, replace:

```json
      "next@>=15.0.0 <15.5.21": "15.5.21",
```

with:

```json
      "next@>=15.0.0 <16.2.0": "16.2.0",
```

Also bump the `next-intl` override to match the new floor:

```json
      "next-intl@>=4.0.0 <4.13.4": "4.13.4",
      "icu-minify@>=4.0.0 <4.9.2": "4.9.2",
```

- [ ] **Step 3: Update the scripts**

In `apps/web/package.json`:

`next lint` is removed in Next 16. Replace the `lint` script:

```json
    "lint": "eslint .",
```

`--turbopack` is the default in 16. In the `dev` script, change
`next dev --turbopack --port` to `next dev --port`:

```json
    "dev": "node scripts/copy-viewer-wasm.mjs && node scripts/copy-emojibase-data.mjs && NODE_OPTIONS='--max-http-header-size=32768' dotenvx run --ignore=MISSING_ENV_FILE -f .env.local -f .env -- next dev --port ${WEB_PORT:-3000}",
```

Leave `dev:staging-env` consistent by removing `--turbopack` there too.

- [ ] **Step 4: Fix `next.config.ts`**

Two edits. First, **delete the entire `webpack` block**:

```ts
  // Webpack configuration to make Konva work with Next.js
  webpack: (config) => {
    config.externals = [...config.externals, { canvas: 'canvas' }]; // required to make Konva & react-konva work
    return config;
  },
```

Turbopack is the default builder in 16, and `next build` **fails outright** when
a custom `webpack` config is present. The existing `turbopack.resolveAlias`
block already aliases `canvas` to `./src/lib/empty-module.ts` for the browser,
which is what the webpack externals were doing.

Second, **delete the `eslint` key** — the option was removed in 16:

```ts
  // Lint runs in CI (`pnpm lint`); skip it during local preview builds for speed.
  // Prod/CI builds (no KORTIX_PREVIEW_BUILD) keep Next's default lint-on-build.
  eslint: {
    ignoreDuringBuilds: IS_PREVIEW_BUILD,
  },
```

Leave `typescript.ignoreBuildErrors`, `devIndicators: false` (still valid in
Next 16 — only the `appIsrStatus`/`buildActivity`/`buildActivityPosition`
sub-options were removed; the boolean form is confirmed in the current
devIndicators reference), `images.qualities`,
`experimental.serverActions` and `experimental.optimizePackageImports` alone.

- [ ] **Step 5: Preserve smooth scrolling**

Next 16 no longer overrides `scroll-behavior` during transitions. `globals.css:774`
sets `scroll-behavior: smooth`. In `apps/web/src/app/layout.tsx`, add the opt-in
attribute to the `<html>` element:

```tsx
<html lang={locale} data-scroll-behavior="smooth" suppressHydrationWarning>
```

Match the existing attributes on that element — read the current `<html>` tag
and add only `data-scroll-behavior="smooth"`, changing nothing else.

- [ ] **Step 6: Install**

```bash
cd /Users/jay/root/kortix/suna-next-16 && nvm use 22 && pnpm install
```

Expected: resolves without peer-dependency errors for the packages above.
`fumadocs-ui@15.8.5` WILL warn or error about its `next: 15.x` peer — that is
expected and is Task 5's job. Record the exact message.

- [ ] **Step 7: Run the full web suite**

```bash
cd apps/web && bun test
```

Expected: green. Tasks 1-3's tests must still pass.

- [ ] **Step 8: Lint and typecheck**

```bash
cd apps/web && npx eslint . 2>&1 | tail -30
npx tsc --noEmit 2>&1 | grep -vE "TS2786|IntrinsicAttributes" | head -40
```

Expected: eslint clean under the new flat config from `eslint-config-next@16`.
For tsc, ignore the known-bogus React types noise; report anything else.

- [ ] **Step 9: Commit (ASK THE USER FIRST)**

```bash
git add apps/web/package.json apps/whitelabel-demo/package.json package.json pnpm-lock.yaml apps/web/next.config.ts apps/web/src/app/layout.tsx
git commit -m "chore(web): upgrade to Next.js 16.2.0

Turbopack is the default builder in 16 and next build fails when a custom
webpack config is present, so the canvas externals block is removed — the
existing turbopack.resolveAlias already covers it. The eslint config key and the
next lint command were both removed in 16.

Next 16 no longer overrides scroll-behavior during transitions, so <html> opts
back in explicitly to preserve globals.css.

fumadocs is bumped separately."
```

---

### Task 5: fumadocs 16 major

Highest-risk task, isolated so it can be dropped. `fumadocs-ui@16` hard-pins
peer `next: "16.x.x"`, so it cannot stay on 15 once Task 4 lands.

**Files:**
- Modify: `apps/web/package.json`
- Modify: whichever of the 11 fumadocs consumers break:
  `src/app/docs/layout.tsx`, `src/app/docs/docs-controls.tsx`,
  `src/app/docs/[[...slug]]/page.tsx`, `src/app/api/search/route.ts`,
  `src/components/markdown/docs-mdx-components.tsx`,
  `src/components/use-cases/use-case-toc.tsx`, `src/lib/source.ts`,
  `src/lib/use-cases-source.ts`, `src/lib/use-cases.ts`,
  `src/lib/seo/public-content.test.ts`, `src/app/globals.css`

**Interfaces:**
- Consumes: Task 4's `next@16.2.0`.
- Produces: no new exports.

- [ ] **Step 1: Read the fumadocs 16 migration notes**

```bash
npm view fumadocs-ui@16.14.0 peerDependencies --json
npm view fumadocs-mdx@15.2.1 peerDependencies --json
```

Then fetch `https://fumadocs.dev/docs/ui/migration` (or the version's changelog)
and note every breaking change that touches the 11 files above. Do not guess at
API changes — read them.

- [ ] **Step 2: Bump the packages**

In `apps/web/package.json`:

| Key | From | To |
|---|---|---|
| `fumadocs-core` | `"15.8.5"` | `"16.14.0"` (4.9d — clears cooldown) |
| `fumadocs-ui` | `"15.8.5"` | `"16.14.0"` (4.9d — clears cooldown) |
| `fumadocs-mdx` | `"11.10.1"` | `"15.2.1"` (4.9d — **NOT 15.2.2**, which is 2.2d old and refused by the 72h cooldown) |

```bash
cd /Users/jay/root/kortix/suna-next-16 && pnpm install
```

Expected: peer warnings from Task 4 are gone.

- [ ] **Step 3: Run the suite and typecheck to surface the breakage**

```bash
cd apps/web && bun test src/lib/seo/public-content.test.ts
npx tsc --noEmit 2>&1 | grep -E "fumadocs|src/app/docs|src/lib/source|use-cases" | head -40
```

Expected: a concrete list of API changes to fix. Fix each against the migration
notes from Step 1 — do not suppress with `any` or `@ts-ignore`.

- [ ] **Step 4: Fix the consumers**

Apply the migration notes to each failing file. Keep the docs site's rendering
behavior identical; this is a dependency migration, not a redesign. Per the
`suna-docs-worktree-fumadocs` convention, docs are stock fumadocs-ui on the black
preset — do not app-skin the `fd-*` tokens while migrating.

- [ ] **Step 5: Verify**

```bash
cd apps/web && bun test && npx eslint . 2>&1 | tail -20
```

Expected: green.

- [ ] **Step 6: Commit (ASK THE USER FIRST)**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src
git commit -m "chore(web): upgrade fumadocs to 16 for Next 16 compatibility

fumadocs-ui@16 pins peer next: 16.x.x, so the docs stack has to move with the
framework. fumadocs-mdx goes 11 -> 15 for its fumadocs-core ^16.7.0 peer."
```

**If Step 4 cannot be completed:** stop and report. Do not force it. The
fallback recorded in the spec is to drop this task and ship Tasks 1-4, which
requires confirming whether the app builds with fumadocs 15 against Next 16
despite the peer mismatch.

---

### Task 6: Full verification

**Files:** none modified. This task produces evidence, not code.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: the verification record for the PR body.

- [ ] **Step 1: Full test suite**

```bash
cd /Users/jay/root/kortix/suna-next-16/apps/web && bun test 2>&1 | tail -20
```

Record pass/fail counts verbatim.

- [ ] **Step 2: Lint**

```bash
cd /Users/jay/root/kortix/suna-next-16/apps/web && npx eslint . 2>&1 | tail -20
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/jay/root/kortix/suna-next-16/apps/web && npx tsc --noEmit 2>&1 | grep -vE "TS2786|IntrinsicAttributes" | head -40
```

- [ ] **Step 4: Production build — the real gate**

```bash
cd /Users/jay/root/kortix/suna-next-16 && nvm use 22 && pnpm --filter Kortix-Computer-Frontend build 2>&1 | tail -40
```

This is what proves the Turbopack switch and the fumadocs migration. Note that
Next 16 removed the `size` / `First Load JS` columns from build output, so do
not look for them.

If the build fails with a webpack-config error, the Task 4 Step 4 deletion was
incomplete or a plugin is injecting one — check `withSentryConfig`,
`withBetterStack`, `withMDX` and `withNextIntl` for an injected `webpack` key
before reaching for `--webpack`.

- [ ] **Step 5: Write the verification record**

Produce a summary containing, verbatim:
- `bun test` output tail (counts)
- `eslint` result
- `tsc` result after filtering
- `next build` result
- **An explicit statement that click-to-paint latency was NOT measured**, because
  no browser was driven and no dev stack was booted. Do not imply a measured
  improvement anywhere in the PR body.

- [ ] **Step 6: Open the PR (ASK THE USER FIRST — do not push unprompted)**

```bash
git push -u origin fix/slow-page-navigation
gh pr create --base main --title "fix: slow project page navigation, and upgrade to Next.js 16" --body "<summary + test plan only>"
```

PR body contains ONLY summary and test plan. No footer, no "Generated with"
line, no session URL, no trailer of any kind.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| R1 maintenance TTL cache | Task 1 |
| R2 remove layout `getUser()` | Task 2 |
| R3 `loading.tsx` for `projects/[id]/` | Task 3 |
| R4 delete dead middleware constants | Task 2 |
| R5 Next 16 packages/config/scripts/markup | Task 4 |
| R5 fumadocs 16 | Task 5 |
| Testing table (3 test files) | Tasks 1, 2, 3 |
| Verification (test/lint/tsc/build) | Task 6 |
| P1 R6, P2 R7-R10 | out of scope by design |

No gaps.

**Placeholder scan:** no TBD/TODO. Every code step contains real code. Task 5
Step 4 is the one step that cannot contain final code — the fumadocs API deltas
are only knowable after Step 1's migration notes and Step 3's error list — so it
is bounded by an explicit stop-and-report instruction rather than left open.

**Type consistency:** `__resetMaintenanceCacheForTests` is named identically in
Task 1 Step 2 (test), Step 5 (implementation) and the spec.
`invalidateMaintenanceCache` is used in Steps 5 and 6 and defined in Step 5.
`MaintenanceConfig` matches the existing exported type. The loading component is
`ProjectHomeLoading` in both Task 3's implementation and its contract test's
`export default function` assertion. Container classes in Task 3's test
(`relative flex min-h-0 flex-1 flex-col overflow-hidden`, `px-4.5`) match the
implementation and `project-home.tsx:141` exactly.
