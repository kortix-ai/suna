# AGENTS.md — `apps/web`

## Test isolation: per-file process separation

`apps/web` runs tests with `bun test --isolate` (each test file in a fresh Bun process). This is **required**, not optional.

### Why

Bun's `mock.module` registry is process-global. A test file that installs a partial or stubbed module doubles (e.g. mocking a single export, leaving others unimported) leaves those stubs in the registry for *every subsequent test file loaded in the same process*. One file's mock leaks into all files after it, creating order-dependent failures.

**Concrete case:** `src/features/session/acp-config-controls.test.tsx` (line 19) sets `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and stubs `window`/`document` at module scope without teardown. Under a shared process, this poisons every Radix component test after it — Radix's mount effects reach for `window`/`document` and find stubs, then happy-dom (imported transitively by other tests) never installs a real DOM, and portals silently fail to mount. The test suite becomes order-dependent; reordering files or adding a new test changes what passes.

Per-file isolation (process restart between files) guarantees that each file's mocks and globals are discarded before the next file loads — **no cleanup code required**, and the test suite order becomes deterministic.

### The old pattern (still valid, and still used)

Many test files use the "spread the real module in `mock.module`" pattern:

```ts
import * as toastModule from '@/components/ui/toast';
mock.module('@/components/ui/toast', () => ({
  ...toastModule,
  useToast: mock.fn(() => ({ /* stub */ }))
}));
```

This is **still good hygiene** — it documents intent and makes the test's dependencies explicit. Keep doing this. Isolation is the real guard, not a replacement.

### Sibling precedent

`apps/api/scripts/test.sh` documents the same pattern over Bun's process-global `mock.module` registry. See that file (lines 1–18) for the exact rationale and implementation.

## Commands

```bash
pnpm --filter kortix-web test              # runs tests with --isolate
pnpm --filter kortix-web typecheck         # tsc --noEmit
pnpm --filter kortix-web build             # next build (slow, for pre-deploy only)
```

Tests must be deterministic and pass regardless of filename order. If a test fails after renaming or reordering files, the failure is a real bug that isolation exposed — do not add `.only`, do not reorder filenames to "fix" it. Fix the test or the source.
