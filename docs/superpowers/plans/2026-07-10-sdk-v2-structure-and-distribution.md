# `@kortix/sdk` v2 — Structure & Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `@kortix/sdk` so its directories encode runtime tiers, collapse its 25-subpath public surface to a single canonical root entry (additively, breaking nobody), and make it consumable with no bundler — all guarded by tests that land *before* the code they protect.

**Architecture:** Two independent axes. **Axis 1** (internal file layout) is invisible to consumers because `package.json#exports` maps public names to internal files — so files move freely at zero compatibility cost. **Axis 2** (the public surface) makes the root barrel canonical and demotes the 21 non-tier subpaths to `@deprecated` aliases in `src/deprecated/`, so all 340 existing import sites keep compiling. Safety nets (install smoke test, export snapshot) are built first, because they are what make a 29.5k-LOC move survivable.

**Tech Stack:** TypeScript 5.4, Bun test, `tsc` + `tsc-alias` (existing ESM build), `tsup` (new, SDK-only devDep, for browser bundles), pnpm workspaces, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-10-sdk-v2-structure-and-distribution-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

- **TDD is mandatory.** Invoke the `tdd` skill before writing implementation code.
  Every task below is already written RED → GREEN → REFACTOR: write the failing
  test, **run it and watch it fail**, implement, run it and watch it pass, commit.
  A test you have never seen fail is not a test — do not skip the "verify it
  fails" step, even when it feels obvious.
- **Never end a task with a red suite.** Loop — run, read the failure, fix, re-run —
  until green. **Loop on the CODE, never on the TEST.** Deleting, `skip`-ing,
  weakening an assertion, filtering the run, or re-recording a snapshot to reach
  green is forbidden. Three exceptions, all of which mean *stop the loop and
  report*: (a) the test encodes a wrong expectation — change it in its own commit,
  with reasoning; (b) the test found a **pre-existing** bug you did not introduce
  (Task 2's smoke test may do exactly this on its first run — that is the test
  working); (c) the same failure survives three different fixes — stop guessing and
  invoke `superpowers:systematic-debugging`.
- **A snapshot diff is a question, not a failure.** If `public-surface.snapshot.json`
  changes, ask *"did I mean to change the public API?"* Additions are fine.
  A removal or rename means you broke a consumer — add an alias, do not accept the diff.
- **Never report a subset as the whole.** Pointing `bun test` at a directory with
  no `*.test.ts` files exits **0** and runs nothing (verified, bun 1.3.14). Always
  finish on the full `pnpm --filter @kortix/sdk test` and check the count against
  the **1046** baseline. `Ran 0 tests` is not a green run.
- **Never end a task without running the gates and pasting the real output:**
  `pnpm --filter @kortix/sdk typecheck && pnpm --filter @kortix/sdk test` (plus
  `run smoke:install` from Task 2 onward). Then state explicitly whether the work
  is **shippable to production: YES / NO / NOT YET**, listing what was verified,
  what was not, and the concrete risk. `typecheck` is not verification.

- **Never edit `version` in `packages/sdk/package.json`.** It is inert. `scripts/stage-npm-publish.mjs:32` overwrites it from the root `VERSION` file. There is no version-bump task in this plan.
- **Exported names are public API — including types, interfaces, and string-literal union members.** Renaming one is a breaking change. **Alias, never replace.**
- **The isomorphic core may not import** `react`, `react-dom`, `next`, `zustand`, `@tanstack/react-query`, or any `node:` specifier — *including type-only imports*. Enforced by `packages/sdk/src/index.isomorphic.test.ts`.
- **The isomorphic core may not touch bare `process` / `window` / `document` / `localStorage` globals.** Guarded reads (`typeof window !== 'undefined'`) are fine.
- **Adding or moving an export requires three synchronized edits:** `exports`, `publishConfig.exports`, and `SUBPATH_TIERS` in `src/index.isomorphic.test.ts`.
- **`@opencode-ai/sdk` is pinned exactly to `1.17.11`** (no caret). Never resolve its root, `/server`, or `/v2/server` into a browser bundle — they pull `node:child_process`. Only `@opencode-ai/sdk/v2/client`.
- **`react` and `@tanstack/react-query` are optional `peerDependencies`.** Never promote to `dependencies`.
- **Do not add new `workspace:*` dependencies** to this package. They get pinned at publish and force the sibling to publish too.
- **Every task ends green:** `pnpm --filter @kortix/sdk typecheck` && `pnpm --filter @kortix/sdk test`. Baseline is 1046 passing tests across 65 files.
- **Do not claim React Native streaming support** anywhere. The transport seam is deferred.
- **Hosts (`apps/web`, `apps/mobile`, `apps/whitelabel-demo`) must keep compiling with zero import-line changes** through Tasks 1–4 and 6–9. Only Task 5 touches a host, and only `whitelabel-demo`.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `packages/sdk/src/package-exports.test.ts` | Asserts `exports` and `publishConfig.exports` key sets match | 1 |
| `packages/sdk/scripts/smoke-install.mjs` | Packs, installs into a temp dir, imports in Node ESM | 2 |
| `.github/workflows/package-tests.yml` | Adds the install smoke test to the release gate | 2 |
| `packages/sdk/src/public-surface.test.ts` | Snapshot of every public export name | 3 |
| `packages/sdk/src/public-surface.snapshot.json` | The committed snapshot | 3 |
| `packages/sdk/src/core/**` | Isomorphic core (no react/zustand/node:/DOM) | 4 |
| `packages/sdk/src/browser/**` | Browser-only tier (zustand, `window`, IndexedDB) | 4 |
| `packages/sdk/src/node/server.ts` | Node-allowed tier (`node:async_hooks`) | 4 |
| `packages/sdk/src/core/turns/{parts,grouping,shell,state}.ts` | The split of the 1434-loc `turns/index.ts` | 4 |
| `packages/sdk/src/deprecated/*.ts` | `@deprecated` re-export shims for the 21 subpaths | 5 |
| `packages/sdk/src/internal/*.ts` | The 5 zustand stores, explicitly unsupported | 5 |
| `packages/sdk/tsup.config.ts` | CDN ESM + IIFE `window.Kortix` bundles | 7 |
| `packages/sdk/examples/07-vanilla.ts` | Full S1 flow, plain TS, zero framework | 9 |
| `packages/sdk/examples/08-cdn.html` | No build step; streams + renders via `Kortix.classifyTurn` | 9 |

---

## Task 1: Assert the two export maps agree

The single cheapest, highest-value guard in this plan. `scripts/stage-npm-publish.mjs:60-80` already fails CI if a `publishConfig.exports` **path** is missing from `dist/`. Nothing asserts the two maps have the same **keys**. Add `./foo` to `exports`, forget `publishConfig.exports`, and CI stays green while `npm install @kortix/sdk` gets no `./foo`.

**Files:**
- Create: `packages/sdk/src/package-exports.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. A test only.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/src/package-exports.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Pkg {
  exports: Record<string, unknown>;
  publishConfig: { exports: Record<string, unknown> };
}

function pkg(): Pkg {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as Pkg;
}

test('exports and publishConfig.exports declare the same subpaths', () => {
  const { exports: src, publishConfig } = pkg();
  // A subpath present in one map and absent from the other is invisible in the
  // workspace (which resolves `exports` → src/) and only explodes for someone
  // who ran `npm install @kortix/sdk` (which resolves publishConfig → dist/).
  expect(Object.keys(publishConfig.exports).sort()).toEqual(Object.keys(src).sort());
});

test('every publishConfig entry declares both types and import', () => {
  const { publishConfig } = pkg();
  for (const [subpath, entry] of Object.entries(publishConfig.exports)) {
    expect(typeof entry === 'object' && entry !== null ? Object.keys(entry).sort() : null).toEqual([
      'import',
      'types',
    ]);
    const { types, import: imp } = entry as { types: string; import: string };
    expect(`${subpath} types`).toBe(`${subpath} types`);
    expect(types.startsWith('./dist/') && types.endsWith('.d.ts')).toBe(true);
    expect(imp.startsWith('./dist/') && imp.endsWith('.js')).toBe(true);
  }
});
```

- [ ] **Step 2: Run it — it should PASS today**

```bash
pnpm --filter @kortix/sdk test src/package-exports.test.ts
```

Expected: **2 pass**. The maps agree right now (25 keys each). This test is a *regression guard*, not a bug fix — it must pass on the unmodified tree, or the tree is already broken.

- [ ] **Step 3: Prove the test actually catches the bug**

Temporarily add a bogus key to `exports` only, in `packages/sdk/package.json`:

```jsonc
"exports": {
  ".": "./src/index.ts",
  "./__probe": "./src/index.ts",
  // …rest unchanged
}
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
pnpm --filter @kortix/sdk test src/package-exports.test.ts
```

Expected: **FAIL** on `exports and publishConfig.exports declare the same subpaths` — the arrays differ by `./__probe`.

A test you have never seen fail is not a test. Do not skip this step.

- [ ] **Step 5: Revert the probe**

```bash
git checkout -- packages/sdk/package.json
pnpm --filter @kortix/sdk test src/package-exports.test.ts
```

Expected: **2 pass**.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/package-exports.test.ts
git commit -m "test(sdk): assert exports and publishConfig.exports declare the same subpaths"
```

---

## Task 2: Install smoke test — pack, install, import

Nothing in this repo installs the published tarball and imports it. `npm pack --dry-run` in CI only lists tarball *contents*. This is the net that makes Task 4's 29.5k-LOC restructure survivable.

**Files:**
- Create: `packages/sdk/scripts/smoke-install.mjs`
- Modify: `.github/workflows/package-tests.yml:81-99`
- Modify: `packages/sdk/package.json` (add a `smoke:install` script)

**Interfaces:**
- Consumes: `scripts/stage-npm-publish.mjs` (existing), `pnpm --filter @kortix/sdk run build`.
- Produces: `pnpm --filter @kortix/sdk run smoke:install`, exit 0 on success.

- [ ] **Step 1: Write the smoke script**

Create `packages/sdk/scripts/smoke-install.mjs`:

```js
#!/usr/bin/env node
/**
 * Packs @kortix/sdk exactly as `npm publish` would, installs the tarball into a
 * throwaway project, and imports it in Node ESM.
 *
 * This is the ONLY check that exercises the published artifact's module
 * resolution. `npm pack --dry-run` lists tarball contents; stage-npm-publish.mjs
 * asserts publishConfig paths exist in dist/. Neither proves the thing imports.
 *
 * Run from packages/sdk:  node scripts/smoke-install.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG_DIR = process.cwd();

/** `execFileSync` takes an options object — cwd and env both live there. */
const run = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, { cwd, env: env ?? process.env, stdio: 'pipe', encoding: 'utf8' });

const backup = join(tmpdir(), `kortix-sdk-pkg-${process.pid}.json`);
const workdir = mkdtempSync(join(tmpdir(), 'kortix-sdk-smoke-'));
let staged = false;

try {
  console.log('→ building dist/');
  run('pnpm', ['run', 'build'], PKG_DIR);

  console.log('→ staging the published manifest');
  copyFileSync(join(PKG_DIR, 'package.json'), backup);
  staged = true;
  run('node', ['../../scripts/stage-npm-publish.mjs'], PKG_DIR, {
    ...process.env,
    VERSION: '0.0.0-smoke',
  });

  console.log('→ npm pack');
  const tarball = run('npm', ['pack', '--silent'], PKG_DIR).trim().split('\n').pop();
  const tarballPath = join(PKG_DIR, tarball);

  console.log(`→ installing ${tarball} into ${workdir}`);
  writeFileSync(
    join(workdir, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, type: 'module' }, null, 2),
  );
  run('npm', ['install', '--no-audit', '--no-fund', tarballPath], workdir);

  console.log('→ importing in Node ESM');
  writeFileSync(
    join(workdir, 'smoke.mjs'),
    [
      "import { createKortix, ApiError, classifyTurn } from '@kortix/sdk';",
      "import { createServerKortix } from '@kortix/sdk/server';",
      "if (typeof createKortix !== 'function') throw new Error('createKortix is not a function');",
      "if (typeof classifyTurn !== 'function') throw new Error('classifyTurn is not a function');",
      "if (typeof createServerKortix !== 'function') throw new Error('createServerKortix missing');",
      "if (!(new ApiError('x') instanceof Error)) throw new Error('ApiError is not an Error');",
      "const k = createKortix({ backendUrl: 'http://smoke.test/v1', getToken: async () => null });",
      "if (typeof k.projects.list !== 'function') throw new Error('facade is not wired');",
      "console.log('OK: @kortix/sdk imports and constructs from a packed tarball');",
    ].join('\n'),
  );
  process.stdout.write(run('node', ['smoke.mjs'], workdir));

  rmSync(tarballPath, { force: true });
  console.log('✔ install smoke test passed');
} finally {
  if (staged) copyFileSync(backup, join(PKG_DIR, 'package.json'));
  rmSync(backup, { force: true });
  rmSync(workdir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run it and watch it pass**

```bash
cd packages/sdk && node scripts/smoke-install.mjs
```

Expected, on the last two lines:

```
OK: @kortix/sdk imports and constructs from a packed tarball
✔ install smoke test passed
```

If it fails, that is a real, pre-existing bug in the published artifact. Fix it before continuing — that is the entire point of this task.

- [ ] **Step 3: Prove it catches a broken `publishConfig`**

Temporarily break one entry in `packages/sdk/package.json` → `publishConfig.exports`:

```jsonc
"./server": { "types": "./dist/server.d.ts", "import": "./dist/NOPE.js" },
```

Run `node scripts/smoke-install.mjs`. Expected: **FAIL** — `stage-npm-publish.mjs` reports `./dist/NOPE.js` missing from the build output. Revert:

```bash
git checkout -- packages/sdk/package.json
```

- [ ] **Step 4: Add the package script**

In `packages/sdk/package.json` → `scripts`, add:

```jsonc
"smoke:install": "node scripts/smoke-install.mjs"
```

- [ ] **Step 5: Wire it into CI**

In `.github/workflows/package-tests.yml`, inside the `Build + dry-pack publishable npm packages (release gate)` step, **after** the existing `for dir in …` loop, append:

```yaml
      - name: Install smoke test — pack, install, import (@kortix/sdk)
        run: |
          set -euo pipefail
          # `npm pack --dry-run` above lists tarball CONTENTS. stage-npm-publish
          # asserts publishConfig paths exist in dist/. Neither proves the
          # published package actually RESOLVES and IMPORTS. This does.
          pnpm --filter @kortix/sdk run smoke:install
```

- [ ] **Step 6: Verify the whole gate still passes locally**

```bash
pnpm --filter @kortix/sdk typecheck && pnpm --filter @kortix/sdk test && pnpm --filter @kortix/sdk run smoke:install
```

Expected: typecheck exit 0; **1048 pass, 0 fail** (1046 baseline + 2 from Task 1); smoke test `✔`.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/scripts/smoke-install.mjs packages/sdk/package.json .github/workflows/package-tests.yml
git commit -m "test(sdk): pack, install, and import the tarball in CI"
```

---

## Task 3: Public-export snapshot

Records today's public surface so Tasks 4–5's effect on it is visible in review. Task 4 must not change it at all; Task 5 must only *grow* it.

**Files:**
- Create: `packages/sdk/src/public-surface.test.ts`
- Create: `packages/sdk/src/public-surface.snapshot.json` (generated in Step 3)

**Interfaces:**
- Consumes: `package.json#exports`.
- Produces: `UPDATE_SURFACE_SNAPSHOT=1` env var regenerates the snapshot.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/src/public-surface.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A committed snapshot of every name reachable from every public entry point.
 *
 * This is the guardrail behind "exported names ARE the API". A rename, a
 * removal, or an addition changes this file, and the diff lands in review where
 * a human decides: additive (fine) or breaking (needs an alias)?
 *
 * A snapshot diff is a QUESTION — "did I mean to change the public API?" — not
 * a file to re-record until the test goes green.
 *
 * Regenerate deliberately:  UPDATE_SURFACE_SNAPSHOT=1 bun test src/public-surface.test.ts
 */
const SNAPSHOT = join(import.meta.dir, 'public-surface.snapshot.json');

async function collectSurface(): Promise<Record<string, string[]>> {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
  ) as { exports: Record<string, string> };

  const surface: Record<string, string[]> = {};
  for (const [subpath, file] of Object.entries(pkg.exports)) {
    // `./react` pulls React in; import it anyway — bun can load it, and its
    // export names are as public as any other.
    const mod = (await import(file.replace(/^\.\/src\//, './'))) as Record<string, unknown>;
    surface[subpath] = Object.keys(mod).sort();
  }
  return surface;
}

test('public export surface matches the committed snapshot', async () => {
  const actual = await collectSurface();

  if (process.env.UPDATE_SURFACE_SNAPSHOT === '1') {
    writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    console.warn('public-surface.snapshot.json regenerated — REVIEW THE DIFF.');
    return;
  }

  expect(existsSync(SNAPSHOT)).toBe(true);
  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, string[]>;
  expect(actual).toEqual(expected);
});
```

> **Note on runtime-vs-type names.** `Object.keys(await import(...))` sees only *runtime* exports — `export type`/`export interface` erase and will not appear. That is a known, accepted limitation: it guards classes, functions, and consts, which is where `instanceof` and call-site breakage live. Type-level renames remain guarded by `typecheck` across the monorepo's 340 import sites.

- [ ] **Step 2: Run it — it must fail (no snapshot yet)**

```bash
pnpm --filter @kortix/sdk test src/public-surface.test.ts
```

Expected: **FAIL** on `expect(existsSync(SNAPSHOT)).toBe(true)`.

- [ ] **Step 3: Generate the snapshot**

```bash
cd packages/sdk && UPDATE_SURFACE_SNAPSHOT=1 bun test src/public-surface.test.ts
```

Expected: `public-surface.snapshot.json regenerated — REVIEW THE DIFF.` and the file exists.

- [ ] **Step 4: Read the snapshot before committing it**

```bash
cat packages/sdk/src/public-surface.snapshot.json | head -40
```

Sanity-check: 25 subpath keys; `"."` contains `createKortix`, `ApiError`, `SessionNotReadyError`, `configureKortix`. If a name surprises you, that is the snapshot doing its job on day one.

- [ ] **Step 5: Run again to verify it passes**

```bash
pnpm --filter @kortix/sdk test src/public-surface.test.ts
```

Expected: **1 pass**.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/public-surface.test.ts packages/sdk/src/public-surface.snapshot.json
git commit -m "test(sdk): snapshot the public export surface"
```

---

## Task 4: Axis 1 — internal restructure (invisible to consumers)

Directories encode the runtime tier. `exports` is updated to point at the new paths, so **no consumer changes and the Task 3 snapshot must not move**. That invariance is the proof the move was invisible.

**Files:**
- Move: `src/kortix.ts` → `src/core/client/kortix.ts`
- Move: `src/platform/{api-client,auth,config,feature-flags,fresh-sessions,instance-routes,opencode-errors}.ts` → `src/core/http/`
- Move: `src/platform/{projects-client,platform-client,api,storage}/**` → `src/core/rest/`
- Move: `src/opencode/**` → `src/core/runtime/`
- Move: `src/session/**` → `src/core/session/`
- Move: `src/files/**` → `src/core/files/`
- Move: `src/turns/**` → `src/core/turns/`
- Move: `src/state/event-stream.ts` → `src/core/stream/event-stream.ts`
- Move: `src/state/{sync-store,server-store,sandbox-connection-store,opencode-pending-store,idb-sync-cache,tab-store,diagnostics-store,opencode-compaction-store}.ts` → `src/browser/stores/` (and `src/browser/cache/`)
- Move: `src/server.ts` → `src/node/server.ts`
- Split: `src/core/turns/index.ts` (1434 loc) → `parts.ts`, `grouping.ts`, `shell.ts`, `state.ts`, and a barrel
- Modify: `packages/sdk/package.json` (`exports` + `publishConfig.exports`)
- Modify: `packages/sdk/src/index.isomorphic.test.ts` (`SUBPATH_TIERS` paths + a new path-based rule)

**Interfaces:**
- Consumes: Tasks 1–3's tests, which must all stay green.
- Produces: no new public names. Public surface byte-identical.

> **This task is large. Do it in the sub-steps below, committing after each, and run the full suite every time.** If the Task 3 snapshot ever changes here, stop — you moved a public name, not a file.

- [ ] **Step 1: Add the path-based tier rule to the tripwire (failing first)**

In `packages/sdk/src/index.isomorphic.test.ts`, append:

```ts
// ── Path-based tier rule ────────────────────────────────────────────────────
// The whole point of the core/ | browser/ | node/ | react/ layout: a file's
// directory declares what it may import. This is checkable by PATH, with no
// list to maintain — which is what makes the tier boundary hard to cross by
// accident rather than merely discouraged.
import { readdirSync, statSync } from 'node:fs';

function walkDir(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkDir(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

test('core/ never imports from browser/, node/, or react/', () => {
  const coreDir = join(SRC_ROOT, 'core');
  if (!existsSync(coreDir)) return; // pre-restructure: nothing to check
  const importRe = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g;
  for (const file of walkDir(coreDir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importRe)) {
      const spec = match[1];
      const resolved = spec.startsWith('.') ? resolve(dirname(file), spec) : null;
      const crosses =
        resolved &&
        (resolved.startsWith(join(SRC_ROOT, 'browser')) ||
          resolved.startsWith(join(SRC_ROOT, 'node')) ||
          resolved.startsWith(join(SRC_ROOT, 'react')));
      expect(
        crosses ? `${file.slice(SRC_ROOT.length + 1)} imports "${spec}" — crosses a tier boundary` : null,
      ).toBeNull();
    }
  }
});
```

- [ ] **Step 2: Run the suite — the new test must PASS trivially (no `core/` yet)**

```bash
pnpm --filter @kortix/sdk test src/index.isomorphic.test.ts
```

Expected: all pass; the new test early-returns. It arms itself the moment `core/` exists.

- [ ] **Step 3: Commit the armed tripwire**

```bash
git add packages/sdk/src/index.isomorphic.test.ts
git commit -m "test(sdk): arm the path-based tier rule before the restructure"
```

- [ ] **Step 4: Move the `node/` and `browser/` tiers first (smallest, clearest)**

```bash
cd packages/sdk/src
mkdir -p node browser/stores browser/cache
git mv server.ts node/server.ts
git mv server.test.ts node/server.test.ts
for f in sync-store server-store sandbox-connection-store opencode-pending-store tab-store diagnostics-store opencode-compaction-store; do
  git mv "state/$f.ts" "browser/stores/$f.ts" 2>/dev/null || true
done
git mv state/idb-sync-cache.ts browser/cache/idb-sync-cache.ts
```

Then fix every broken relative import (`tsc` will list them):

```bash
pnpm --filter @kortix/sdk typecheck 2>&1 | head -40
```

Repair each reported path. Update `exports` **and** `publishConfig.exports` for the five moved public subpaths (`./server`, `./sync-store`, `./server-store`, `./sandbox-connection-store`, `./opencode-pending-store`, `./idb-sync-cache`), and their entries in `SUBPATH_TIERS`.

- [ ] **Step 5: Verify nothing public moved**

```bash
pnpm --filter @kortix/sdk typecheck && pnpm --filter @kortix/sdk test
```

Expected: typecheck exit 0. **All tests pass, including `public export surface matches the committed snapshot`.** If the snapshot test fails, you renamed something. Revert and try again.

- [ ] **Step 6: Commit**

```bash
git add -A packages/sdk
git commit -m "refactor(sdk): move node/ and browser/ tiers into their own directories"
```

- [ ] **Step 7: Move the `core/` tier**

```bash
cd packages/sdk/src
mkdir -p core/{client,http,rest,runtime,session,files,turns,stream}
git mv kortix.ts core/client/kortix.ts
git mv kortix.test.ts core/client/kortix.test.ts
git mv opencode core/runtime
git mv session core/session
git mv files core/files
git mv turns core/turns
git mv state/event-stream.ts core/stream/event-stream.ts
git mv state/event-stream.test.ts core/stream/event-stream.test.ts
for f in api-client auth config feature-flags fresh-sessions instance-routes opencode-errors logger; do
  git mv "platform/$f.ts" "core/http/$f.ts" 2>/dev/null || true
  git mv "platform/$f.test.ts" "core/http/$f.test.ts" 2>/dev/null || true
done
git mv platform/api core/http/api
git mv platform/projects-client core/rest/projects-client
git mv platform/platform-client core/rest/platform-client
```

Then repeat the repair loop:

```bash
pnpm --filter @kortix/sdk typecheck 2>&1 | head -60
```

Update all remaining `exports`, `publishConfig.exports`, and `SUBPATH_TIERS` paths.

- [ ] **Step 8: Verify — this is the moment the tier rule arms itself**

```bash
pnpm --filter @kortix/sdk typecheck && pnpm --filter @kortix/sdk test
```

Expected: typecheck exit 0; **all pass**, including `core/ never imports from browser/, node/, or react/` and the snapshot test.

If `core/ never imports…` fails, a core file reaches into `browser/` — most likely `core/client/kortix.ts` importing `state/server-store/url-helpers` or `state/current-runtime`. Those two are *pure*; move them to `core/stream/` or `core/session/` rather than widening the rule.

- [ ] **Step 9: Commit**

```bash
git add -A packages/sdk
git commit -m "refactor(sdk): move the isomorphic core into core/"
```

- [ ] **Step 10: Split the 1434-loc `turns/index.ts` god-file**

`core/turns/index.ts` has 67 top-level declarations and only 5 re-exports. Split along its existing seams. Create four files, moving declarations verbatim:

- `core/turns/parts.ts` — `isTextPart`, `isReasoningPart`, `isToolPart`, `isFilePart`, `isAgentPart`, `isCompactionPart`, `isSnapshotPart`, `isPatchPart`, `getPartText`, `isAttachment`, `splitUserParts`
- `core/turns/grouping.ts` — `groupMessagesIntoTurns`, `collectTurnParts`, `findLastTextPart`, `turnHasSteps`
- `core/turns/shell.ts` — `isShellMode`, `getShellModePart`
- `core/turns/state.ts` — `getWorkingState`, `isLastUserMessage`

Then reduce `core/turns/index.ts` to a barrel:

```ts
export type * from './types';
export * from './classify';
export * from './errors';
export * from './grouping';
export * from './parts';
export * from './shell';
export * from './state';
export * from './tool-registry';
export * from './view-model';
```

Move any remaining declarations into whichever of the four files they belong to. **Do not rename anything.**

- [ ] **Step 11: Verify the split changed nothing public**

```bash
pnpm --filter @kortix/sdk typecheck && pnpm --filter @kortix/sdk test
```

Expected: all pass. The snapshot test proves `./turns` still exports the exact same names.

```bash
wc -l packages/sdk/src/core/turns/index.ts
```

Expected: under 15 lines.

- [ ] **Step 12: Commit**

```bash
git add -A packages/sdk
git commit -m "refactor(sdk): split turns/index.ts god-file into parts/grouping/shell/state"
```

---

## Task 5: Axis 2 — root becomes canonical, subpaths become deprecated aliases

Additive only. All 340 existing import sites keep compiling. The Task 3 snapshot **grows**; every entry in the diff must be an addition.

**Files:**
- Create: `packages/sdk/src/deprecated/<21 files>.ts`
- Create: `packages/sdk/src/internal/{sync-store,server-store,sandbox-connection-store,opencode-pending-store,idb-sync-cache}.ts`
- Modify: `packages/sdk/src/index.ts` (the canonical barrel)
- Modify: `packages/sdk/src/core/runtime/kortix-master.ts` (`KortixProject` → `KortixMasterProject`)
- Modify: `packages/sdk/package.json` (`exports`, `publishConfig.exports`)
- Modify: `packages/sdk/src/index.isomorphic.test.ts` (`SUBPATH_TIERS` + wildcard handling)

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: `KortixMasterProject` (new name), `KortixProject` (unchanged, platform), `PatchKortixMasterProjectInput`.

- [ ] **Step 1: Write the failing test for the `KortixProject` disambiguation**

Create `packages/sdk/src/core/runtime/kortix-master.names.test.ts`:

```ts
import { expect, test } from 'bun:test';
import * as master from './kortix-master';
import type { KortixProject as PlatformProject } from '../rest/projects-client/projects';

test('the daemon project is exported as KortixMasterProject', () => {
  const project: master.KortixMasterProject = {
    id: 'p1',
    name: 'demo',
    path: '/work/demo',
    description: '',
    created_at: '2026-07-10T00:00:00Z',
    opencode_id: null,
  };
  expect(project.id).toBe('p1');
});

test('the deprecated KortixProject alias still resolves to the daemon shape', () => {
  // Back-compat: `@kortix/sdk/opencode-client` consumers keep compiling.
  const legacy: master.KortixProject = {
    id: 'p1',
    name: 'demo',
    path: '/work/demo',
    description: '',
    created_at: '2026-07-10T00:00:00Z',
    opencode_id: null,
  };
  expect(legacy.path).toBe('/work/demo');
});

test('the platform project is a DIFFERENT shape and keeps its name', () => {
  const platform: PlatformProject = {
    project_id: 'proj_1',
    account_id: 'acct_1',
    name: 'demo',
    repo_url: 'https://example.test/r.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-07-10T00:00:00Z',
    updated_at: '2026-07-10T00:00:00Z',
  };
  expect(platform.project_id).toBe('proj_1');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @kortix/sdk test src/core/runtime/kortix-master.names.test.ts
```

Expected: **FAIL** — `KortixMasterProject` does not exist on the module.

- [ ] **Step 3: Rename the daemon type, keep an alias**

In `packages/sdk/src/core/runtime/kortix-master.ts`, change `export interface KortixProject {` to:

```ts
/**
 * A project inside the sandbox's kortix-master daemon — the `/kortix/projects`
 * board surface (tasks, tickets, milestones), NOT the Kortix platform project.
 * The platform's project is `KortixProject` in `core/rest/projects-client`.
 */
export interface KortixMasterProject {
  id: string;
  name: string;
  path: string;
  description: string;
  created_at: string;
  opencode_id: string | null;
  /** 1 = legacy tasks layout, 2 = new tickets/board. */
  structure_version?: number;
  sessionCount?: number;
  worktree?: string;
  time?: {
    created: number;
    updated: number;
    initialized?: number;
  };
}

/**
 * @deprecated Renamed to `KortixMasterProject` — it models the kortix-master
 * daemon's board project, not the Kortix platform project (which keeps the name
 * `KortixProject`, exported from the root barrel). Removed in the next major.
 */
export type KortixProject = KortixMasterProject;
```

Rename `PatchKortixProjectInput` → `PatchKortixMasterProjectInput` and add:

```ts
/** @deprecated Renamed to `PatchKortixMasterProjectInput`. Removed in the next major. */
export type PatchKortixProjectInput = PatchKortixMasterProjectInput;
```

Update the file's internal uses (`listKortixProjects`, `getKortixProject`, `patchKortixProject` return types) to `KortixMasterProject`. **Do not rename those functions** — they do not collide.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @kortix/sdk test src/core/runtime/kortix-master.names.test.ts
pnpm --filter @kortix/sdk typecheck
```

Expected: **3 pass**; typecheck exit 0 (the alias keeps `react/use-kortix-master.ts` compiling).

- [ ] **Step 5: Commit**

```bash
git add -A packages/sdk
git commit -m "refactor(sdk)!: rename the kortix-master daemon project to KortixMasterProject (aliased)"
```

- [ ] **Step 6: Build the canonical root barrel**

Rewrite `packages/sdk/src/index.ts` to re-export the whole isomorphic core. Resolve the seven known ambiguities with **explicit** re-exports rather than `export *`:

```ts
// Explicit re-exports resolve TS2308: each of these names is declared ONCE but
// reachable through two `export *` paths. Naming them here picks the canonical
// module and silences the ambiguity without renaming anything.
export { ApiError, type ApiErrorFields } from './core/http/api/errors';
export { type FileContent, type FileNode } from './core/files/types';
export { type QuestionOption } from './core/turns/view-model';
export {
  type PermissionAction,
  type PermissionConfig,
  type PermissionRule,
} from './core/rest/projects-client/agent-config';

export * from './core/client/kortix';
export * from './core/http/api-client';
export * from './core/http/auth';
export * from './core/http/config';
export * from './core/http/feature-flags';
export * from './core/http/fresh-sessions';
export * from './core/http/instance-routes';
export * from './core/http/opencode-errors';
export * from './core/rest/platform-client';
export * from './core/rest/projects-client';
export * from './core/runtime/client';
export * from './core/session';
export * from './core/session/url';
export * from './core/stream/event-stream';
export * from './core/turns';
export * from './transcript';
```

- [ ] **Step 7: Run typecheck — expect TS2308 if any ambiguity was missed**

```bash
pnpm --filter @kortix/sdk typecheck 2>&1 | grep TS2308 || echo "no ambiguities"
```

Expected: `no ambiguities`. Any `TS2308` names a symbol declared twice — add an explicit re-export, or, if it is genuinely two different concepts, rename one with an alias (as with `KortixMasterProject`).

- [ ] **Step 8: Create `internal/` and `deprecated/` shims**

For each of the five stores, create `packages/sdk/src/internal/<name>.ts`:

```ts
/**
 * @internal Not covered by semver. `apps/web` depends on these zustand stores;
 * nothing else should. They may change shape in any release.
 */
export * from '../browser/stores/<name>';
```

(`idb-sync-cache` re-exports from `../browser/cache/idb-sync-cache`.)

For each of the 21 collapsed subpaths, create `packages/sdk/src/deprecated/<name>.ts`:

```ts
/**
 * @deprecated Import from `@kortix/sdk` instead — the root entry is canonical.
 * This subpath still works and will keep working until the next major.
 */
export * from '../core/rest/projects-client';
```

…pointing each at its new `core/` home. For the five stores, point at `../internal/<name>`.

- [ ] **Step 9: Rewrite both export maps**

`packages/sdk/package.json`:

```jsonc
"exports": {
  ".": "./src/index.ts",
  "./react": "./src/react/index.ts",
  "./server": "./src/node/server.ts",
  "./internal/sync-store": "./src/internal/sync-store.ts",
  "./internal/server-store": "./src/internal/server-store.ts",
  "./internal/sandbox-connection-store": "./src/internal/sandbox-connection-store.ts",
  "./internal/opencode-pending-store": "./src/internal/opencode-pending-store.ts",
  "./internal/idb-sync-cache": "./src/internal/idb-sync-cache.ts",

  "./opencode-client": "./src/deprecated/opencode-client.ts",
  "./config": "./src/deprecated/config.ts",
  "./auth": "./src/deprecated/auth.ts",
  "./api-client": "./src/deprecated/api-client.ts",
  "./projects-client": "./src/deprecated/projects-client.ts",
  "./feature-flags": "./src/deprecated/feature-flags.ts",
  "./fresh-sessions": "./src/deprecated/fresh-sessions.ts",
  "./instance-routes": "./src/deprecated/instance-routes.ts",
  "./opencode-errors": "./src/deprecated/opencode-errors.ts",
  "./platform-client": "./src/deprecated/platform-client.ts",
  "./event-stream": "./src/deprecated/event-stream.ts",
  "./files": "./src/deprecated/files.ts",
  "./session": "./src/deprecated/session.ts",
  "./session/url": "./src/deprecated/session-url.ts",
  "./turns": "./src/deprecated/turns.ts",
  "./sync-store": "./src/deprecated/sync-store.ts",
  "./server-store": "./src/deprecated/server-store.ts",
  "./sandbox-connection-store": "./src/deprecated/sandbox-connection-store.ts",
  "./opencode-pending-store": "./src/deprecated/opencode-pending-store.ts",
  "./idb-sync-cache": "./src/deprecated/idb-sync-cache.ts"
}
```

Mirror **every** key into `publishConfig.exports` with `{ "types": "./dist/<path>.d.ts", "import": "./dist/<path>.js" }`. Task 1's test enforces this.

- [ ] **Step 10: Update `SUBPATH_TIERS` for the new keys**

In `src/index.isomorphic.test.ts`, add the five `./internal/*` entries (tier `browser-only`) and repoint the 21 deprecated names at `deprecated/<file>.ts`. The deprecated store shims are `browser-only`; the rest are `isomorphic-core`.

- [ ] **Step 11: Run everything**

```bash
pnpm --filter @kortix/sdk typecheck && pnpm --filter @kortix/sdk test && pnpm --filter @kortix/sdk run smoke:install
```

Expected: typecheck exit 0; all tests pass **except** `public export surface matches the committed snapshot`, which now fails because the surface **grew**.

- [ ] **Step 12: Review the snapshot diff before regenerating**

```bash
cd packages/sdk && UPDATE_SURFACE_SNAPSHOT=1 bun test src/public-surface.test.ts
git diff packages/sdk/src/public-surface.snapshot.json
```

**Read the diff.** Every line must be an addition (`+`) or a new subpath key. If any line *removes* a name, you broke a consumer — fix it with an alias, do not accept the diff.

Expected removals: **zero**. Expected additions: 5 `./internal/*` keys, and a much larger `"."` name list.

- [ ] **Step 13: Verify the hosts still compile untouched**

```bash
# apps/web's package name is `Kortix-Computer-Frontend`, not @kortix/web.
pnpm --filter Kortix-Computer-Frontend typecheck 2>&1 | grep "@kortix/sdk" || echo "no SDK resolution errors"
pnpm --filter @kortix/whitelabel-demo typecheck
```

`apps/web` emits ~1500 bogus `TS2786` React-19-vs-18 errors (see root `AGENTS.md`) — grep for `@kortix/sdk` in the output instead of trusting the exit code. Expected: `no SDK resolution errors`. `whitelabel-demo` must exit 0.

- [ ] **Step 14: Commit**

```bash
git add -A packages/sdk
git commit -m "feat(sdk): make the root entry canonical; demote 21 subpaths to deprecated aliases"
```

---

## Task 6: Dogfood `whitelabel-demo` — the acceptance gate

Lumen is the **first app shipping to production** on this SDK. If the public surface cannot power it through the root entry alone, the surface is wrong.

**Files:**
- Modify: `apps/whitelabel-demo/src/**` (25 import lines)
- Modify: `apps/whitelabel-demo/src/app/api/preview-token/route.ts:57`
- Modify: `apps/whitelabel-demo/src/app/api/usage/route.ts:67`

**Interfaces:**
- Consumes: the root barrel from Task 5; `@kortix/sdk/server`.
- Produces: nothing importable.

- [ ] **Step 1: Migrate the demo's imports to the root entry**

39 SDK import sites; 14 are already root. Rewrite the rest:

```bash
cd apps/whitelabel-demo
grep -rl "@kortix/sdk/\(projects-client\|turns\|session\|opencode-client\)" src/ \
  | xargs sed -i '' -E "s#'@kortix/sdk/(projects-client|turns|session|opencode-client)'#'@kortix/sdk'#g"
```

`@kortix/sdk/react` stays a subpath — React is a peer dependency (the one-sentence rule).

- [ ] **Step 2: Merge now-duplicate import statements and typecheck**

```bash
pnpm --filter @kortix/whitelabel-demo typecheck
```

Expected: exit 0. Fix any "duplicate identifier" from two `from '@kortix/sdk'` lines in one file by merging them.

- [ ] **Step 3: Write the failing test for the preview-token route**

Both endpoints already exist in the SDK. Replace the raw `fetch` at `src/app/api/preview-token/route.ts:57` with the SDK server client:

```ts
import { createServerKortix } from '@kortix/sdk/server';

const kortix = createServerKortix({ backendUrl: upstreamBase(), getToken: async () => apiKey });
const token = await kortix.project(projectId).tokens.createCliToken({
  name: `lumen-preview-${Date.now()}`,
});
```

> **Before writing this**, confirm the exact facade path with:
> `grep -n "cliToken\|createCliToken" packages/sdk/src/core/rest/projects-client/tokens.ts packages/sdk/src/core/client/kortix.ts`
> and use whatever name is actually exported. `tokens.ts:127` issues `POST /projects/:id/cli-token`.

- [ ] **Step 4: Do the same for the usage route**

`src/app/api/usage/route.ts:67` → `kortix.project(projectId).gateway.sessions()`. Confirm the facade name against `core/rest/projects-client/gateway.ts:210` (`GET /projects/:id/gateway/sessions`).

- [ ] **Step 5: Verify no raw Kortix `fetch` remains**

```bash
cd apps/whitelabel-demo
grep -rn "fetch(\`\${upstream}" src/ && echo "STILL PRESENT" || echo "clean"
```

Expected: `clean`. The remaining `fetch(` hits are the demo calling its own Next routes (`/api/auth/login`, `/api/mode`, `/api/usage`) and the `[...path]` proxy itself — all legitimate.

- [ ] **Step 6: Run the demo's e2e suite**

```bash
pnpm --filter @kortix/whitelabel-demo typecheck && pnpm --filter @kortix/whitelabel-demo test
```

Expected: typecheck exit 0; `bun test tests/e2e` passes.

- [ ] **Step 7: Commit**

```bash
git add -A apps/whitelabel-demo
git commit -m "refactor(whitelabel-demo): import @kortix/sdk from the root entry; drop raw transport"
```

---

## Task 7: Portability hardening — ban bare globals in the core

**This is browser work, not React Native work.** `platform-client/shared.ts:29` reads a bare `process.env.BACKEND_URL`. On a non-Next host — including the CDN `<script>` bundle built in Task 8 — touching `process.env` throws a **`ReferenceError`**, not `undefined`. The SDK already documents this at `core/http/feature-flags.ts:14` and ships `safeEnv()` for it.

**Files:**
- Modify: `packages/sdk/src/core/rest/platform-client/shared.ts:29`
- Modify: `packages/sdk/src/core/http/feature-flags.ts` (export `safeEnv`)
- Modify: `packages/sdk/src/index.isomorphic.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `safeEnv(name: string): string | undefined` — exported from `core/http/env.ts`.

- [ ] **Step 1: Write the failing tripwire test**

Append to `packages/sdk/src/index.isomorphic.test.ts`:

```ts
test('core/ never touches a bare process/window/document/localStorage global', () => {
  const coreDir = join(SRC_ROOT, 'core');
  if (!existsSync(coreDir)) return;
  // A bare global read throws a ReferenceError on React Native, in a CLI, and in
  // a bare browser <script> bundle. Guarded reads (`typeof x !== 'undefined'`)
  // are fine — this only flags a member access with no guard on the same line.
  const BARE = /(?<!typeof\s)(?<![.\w])(process|window|document|localStorage|sessionStorage)\s*\./g;
  for (const file of walkDir(coreDir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
      if (/typeof\s+(process|window|document|localStorage|sessionStorage)/.test(line)) return;
      const hit = line.match(BARE);
      expect(
        hit ? `${file.slice(SRC_ROOT.length + 1)}:${i + 1} bare global \`${hit[0]}\`` : null,
      ).toBeNull();
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @kortix/sdk test src/index.isomorphic.test.ts
```

Expected: **FAIL** naming `core/rest/platform-client/shared.ts:29 bare global \`process.\``.

If it also flags a guarded read where the guard sits on a *previous* line, widen the skip to check the preceding line too — do not weaken the pattern.

- [ ] **Step 3: Extract `safeEnv` into its own module**

Create `packages/sdk/src/core/http/env.ts`:

```ts
/**
 * Safe `process.env.<name>` read. Non-Next hosts (React Native, a bare browser
 * bundle, a CLI) may not define a `process` global at all — touching
 * `process.env` there throws a ReferenceError, not just returns `undefined`.
 */
export function safeEnv(name: string): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}
```

Update `core/http/feature-flags.ts` to `import { safeEnv } from './env'` and delete its private copy.

- [ ] **Step 4: Fix the bare read**

In `packages/sdk/src/core/rest/platform-client/shared.ts`:

```ts
import { safeEnv } from '../../http/env';

export function getPlatformUrl(): string {
  // Server-side: prefer BACKEND_URL (internal Docker hostname) over
  // NEXT_PUBLIC_BACKEND_URL (browser-facing localhost, unreachable from container).
  // `safeEnv` because this module is isomorphic-core: a bare `process.env` read
  // throws a ReferenceError in a browser <script> bundle and on React Native.
  const backendUrl = safeEnv('BACKEND_URL') || platformConfig().backendUrl;
  if (backendUrl) {
    return backendUrl;
  }
  // …rest unchanged
}
```

- [ ] **Step 5: Run the suite to verify it passes**

```bash
pnpm --filter @kortix/sdk typecheck && pnpm --filter @kortix/sdk test
```

Expected: all pass, including the new bare-global test.

- [ ] **Step 6: Commit**

```bash
git add -A packages/sdk
git commit -m "fix(sdk): guard the bare process.env read in platform-client; ban bare globals in core/"
```

---

## Task 8: `tsup` bundles — CDN ESM + `window.Kortix`

Additive. The `tsc` ESM `dist/` stays exactly as-is; these are two extra artifacts.

Because Task 5 folded `turns`, `files`, and `session` into root, `window.Kortix` **is** the root barrel — one flat global, `classifyTurn` already in it. No namespace curation list to maintain.

**Files:**
- Create: `packages/sdk/tsup.config.ts`
- Modify: `packages/sdk/package.json` (devDep `tsup`, `browser`/`unpkg`/`jsdelivr` fields, `build:bundles` script)
- Create: `packages/sdk/src/bundle.test.ts`

**Interfaces:**
- Consumes: `src/index.ts` from Task 5.
- Produces: `dist/kortix.esm.min.js`, `dist/kortix.global.js` (exposing `window.Kortix`).

- [ ] **Step 1: Add `tsup` and the config**

```bash
pnpm --filter @kortix/sdk add -D tsup
```

Create `packages/sdk/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

/**
 * Browser bundles, beside (never replacing) the `tsc` ESM dist/.
 *
 * `noExternal` inlines the runtime deps a <script> tag cannot resolve. We inline
 * ONLY `@opencode-ai/sdk/v2/client` — its graph is error-interceptor + the three
 * generated modules, all browser-safe. The package's root and `/server` entries
 * pull `node:child_process`; letting a bundler reach them ships a broken global.
 */
export default defineConfig([
  {
    entry: { 'kortix.esm.min': 'src/index.ts' },
    format: ['esm'],
    minify: true,
    platform: 'browser',
    outDir: 'dist',
    dts: false,
    clean: false,
    noExternal: [/^@kortix\//, /^@opencode-ai\//],
  },
  {
    entry: { 'kortix.global': 'src/index.ts' },
    format: ['iife'],
    globalName: 'Kortix',
    minify: true,
    platform: 'browser',
    outDir: 'dist',
    dts: false,
    clean: false,
    noExternal: [/^@kortix\//, /^@opencode-ai\//],
  },
]);
```

- [ ] **Step 2: Write the failing bundle test**

Create `packages/sdk/src/bundle.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(import.meta.dir, '..', 'dist');
const ESM = join(DIST, 'kortix.esm.min.js');
const IIFE = join(DIST, 'kortix.global.js');

// These tests require `pnpm --filter @kortix/sdk run build:bundles` to have run.
const built = existsSync(ESM) && existsSync(IIFE);

test.skipIf(!built)('no browser bundle contains node:child_process', () => {
  for (const file of [ESM, IIFE]) {
    const source = readFileSync(file, 'utf8');
    // @opencode-ai/sdk's dist/process.js imports node:child_process and is reached
    // only from v2/server.js. If it lands here, tsup resolved the wrong entry.
    expect(source.includes('node:child_process') ? `${file} pulls node:child_process` : null).toBeNull();
    expect(source.includes('async_hooks') ? `${file} pulls async_hooks` : null).toBeNull();
  }
});

test.skipIf(!built)('the IIFE bundle assigns a Kortix global with the core API', () => {
  const source = readFileSync(IIFE, 'utf8');
  expect(source.length).toBeGreaterThan(1000);
  // `globalName: 'Kortix'` makes tsup emit `var Kortix=(()=>{…})()`.
  expect(/\bKortix\b/.test(source)).toBe(true);
});
```

- [ ] **Step 3: Run it — it should skip (no bundles yet)**

```bash
pnpm --filter @kortix/sdk test src/bundle.test.ts
```

Expected: **2 skipped**.

- [ ] **Step 4: Add the build script and wire the fields**

In `packages/sdk/package.json`:

```jsonc
"scripts": {
  "build": "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json --resolve-full-paths",
  "build:bundles": "pnpm run build && tsup",
  "smoke:install": "node scripts/smoke-install.mjs"
}
```

And, inside `publishConfig` (so they only apply to the published tarball):

```jsonc
"browser": "./dist/kortix.esm.min.js",
"unpkg": "./dist/kortix.global.js",
"jsdelivr": "./dist/kortix.global.js"
```

- [ ] **Step 5: Build the bundles and run the test**

```bash
pnpm --filter @kortix/sdk run build:bundles
pnpm --filter @kortix/sdk test src/bundle.test.ts
```

Expected: **2 pass**. If `no browser bundle contains node:child_process` fails, some import reached `@opencode-ai/sdk` root or `/server` — find it with `grep -rn "@opencode-ai/sdk'" packages/sdk/src` and repoint it at `@opencode-ai/sdk/v2/client`.

- [ ] **Step 6: Verify `stage-npm-publish.mjs` still accepts the manifest**

```bash
cd packages/sdk && cp package.json /tmp/pkg-bak.json \
  && VERSION=0.0.0-ci node ../../scripts/stage-npm-publish.mjs \
  && mv /tmp/pkg-bak.json package.json
```

Expected: `staged @kortix/sdk@0.0.0-ci for publish`, all entrypoints present. `browser`/`unpkg`/`jsdelivr` are not in its promoted-field list, so they pass through untouched.

- [ ] **Step 7: Commit**

```bash
git add -A packages/sdk
git commit -m "feat(sdk): ship CDN ESM and window.Kortix IIFE bundles via tsup"
```

---

## Task 9: Examples + the tripwire over them

**Files:**
- Create: `packages/sdk/examples/07-vanilla.ts`
- Create: `packages/sdk/examples/08-cdn.html`
- Modify: `packages/sdk/src/index.isomorphic.test.ts`

**Interfaces:**
- Consumes: the root barrel; `dist/kortix.global.js`.
- Produces: nothing importable.

- [ ] **Step 1: Write `examples/07-vanilla.ts` — the full S1 flow**

```ts
/**
 * 07 — The whole flow, framework-free, in one file.
 *
 * createKortix → projects.list() → session(pid, sid).send() → session.stream()
 * → classifyTurn. Zero React, zero DOM, zero Node-specific API beyond
 * `process.env` and `console`.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=... KORTIX_SESSION_ID=... \
 *     bun run examples/07-vanilla.ts "list the files here"
 *
 * As an npm consumer, one import line changes:
 *   import { createKortix, classifyTurn, narrowChatEvent } from '@kortix/sdk';
 */
import { classifyTurn, createKortix, narrowChatEvent } from '../src/index';

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  const projectId = process.env.KORTIX_PROJECT_ID;
  const sessionId = process.env.KORTIX_SESSION_ID;
  const prompt = process.argv[2] ?? 'Say hello in one sentence.';

  if (!apiKey || !projectId || !sessionId) {
    console.error('Set KORTIX_API_KEY, KORTIX_PROJECT_ID and KORTIX_SESSION_ID.');
    process.exit(1);
  }

  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });

  const projects = await kortix.projects.list();
  console.log(`${projects.length} project(s); using ${projectId}`);

  const session = kortix.session(projectId, sessionId);

  // Connect BEFORE sending so no early events are missed.
  await session.ensureReady();
  const handle = await session.stream({
    onEvent: (event) => {
      const narrowed = narrowChatEvent(event);
      if (!narrowed) return;
      console.log(`· ${narrowed.type}`);
    },
  });

  await session.send(prompt);

  // Let the turn settle, then render what arrived.
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  handle.close();

  const messages = await session.transcript();
  for (const turn of messages) {
    for (const part of classifyTurn(turn).parts) {
      if (part.kind === 'text') console.log(part.text);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

> **Before running:** confirm `session.transcript()` and `classifyTurn(...)` shapes against `core/turns/classify.ts` and `core/client/kortix.ts`; adjust the last loop to the real API rather than guessing. `examples/04-render-transcript.ts` is the working reference.

- [ ] **Step 2: Typecheck the examples**

```bash
pnpm --filter @kortix/sdk typecheck
```

Expected: exit 0 (this runs `tsc --noEmit -p examples/tsconfig.json`).

- [ ] **Step 3: Write the failing tripwire test over `examples/`**

Append to `packages/sdk/src/index.isomorphic.test.ts`:

```ts
test('examples/ pull no react, no DOM, no framework', () => {
  const examplesDir = join(SRC_ROOT, '..', 'examples');
  const importRe = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g;
  for (const file of readdirSync(examplesDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const source = readFileSync(join(examplesDir, file), 'utf8');
    for (const match of source.matchAll(importRe)) {
      const spec = match[1];
      if (spec.startsWith('.')) continue; // relative into ../src, already covered
      const forbidden = FORBIDDEN_MODULES.find((m) => spec === m || spec.startsWith(`${m}/`));
      expect(forbidden ? `examples/${file} imports "${spec}"` : null).toBeNull();
    }
  }
});
```

- [ ] **Step 4: Run it**

```bash
pnpm --filter @kortix/sdk test src/index.isomorphic.test.ts
```

Expected: pass. To prove it works, temporarily add `import 'react';` to `examples/07-vanilla.ts`, re-run (expect FAIL), then remove it.

- [ ] **Step 5: Write `examples/08-cdn.html`**

```html
<!doctype html>
<meta charset="utf-8" />
<title>Kortix SDK — no build step</title>
<pre id="out">connecting…</pre>

<!-- The IIFE bundle. `window.Kortix` IS the root barrel: createKortix,
     classifyTurn, ApiError, narrowChatEvent — no namespaces, no build step. -->
<script src="../dist/kortix.global.js"></script>
<script>
  const out = document.getElementById('out');
  const log = (line) => { out.textContent += `\n${line}`; };

  const params = new URLSearchParams(location.search);
  const backendUrl = params.get('api') ?? 'http://localhost:8008/v1';
  const apiKey = params.get('key');
  const projectId = params.get('project');
  const sessionId = params.get('session');

  if (!apiKey || !projectId || !sessionId) {
    out.textContent = 'Add ?key=kortix_pat_…&project=…&session=… to the URL.';
    throw new Error('missing params');
  }

  const kortix = Kortix.createKortix({ backendUrl, getToken: async () => apiKey });

  (async () => {
    try {
      const session = kortix.session(projectId, sessionId);
      await session.ensureReady();
      await session.stream({
        onEvent: (event) => {
          const narrowed = Kortix.narrowChatEvent(event);
          if (narrowed) log(`· ${narrowed.type}`);
        },
      });
      await session.send('Say hello in one sentence.');
      log('sent — streaming…');
    } catch (error) {
      // D3: `instanceof ApiError` must work under the browser bundle. If the page
      // ever loads BOTH this global and the ESM build, there are two ApiError
      // classes and this check silently fails — that is the dual-package hazard.
      if (error instanceof Kortix.ApiError) log(`ApiError ${error.status}: ${error.message}`);
      else log(`error: ${error}`);
    }
  })();
</script>
```

- [ ] **Step 6: Verify the page loads and streams**

```bash
pnpm --filter @kortix/sdk run build:bundles
cd packages/sdk && python3 -m http.server 8099 &
```

Open `http://localhost:8099/examples/08-cdn.html?key=…&project=…&session=…` against a running local stack (`pnpm dev` from the repo root). Expected: `sent — streaming…` followed by `· message.part.updated` lines.

**This is D2a and D3.** Streaming through the IIFE global, and `instanceof ApiError` under the bundle. Do not mark this task done on a typecheck alone.

Kill the server: `kill %1`.

- [ ] **Step 7: Commit**

```bash
git add -A packages/sdk
git commit -m "docs(sdk): add vanilla-TS and no-build CDN examples; assert examples stay framework-free"
```

---

## Task 10: Documentation

**Files:**
- Modify: `packages/sdk/README.md`
- Modify: `packages/sdk/CHANGELOG.md`
- Modify: `packages/sdk/API-MAP.md`

**Interfaces:** none.

- [ ] **Step 1: README — lead with the single import**

Add, near the top:

````markdown
## Install

```bash
npm install @kortix/sdk
```

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({ backendUrl: 'https://api.kortix.com/v1', getToken });
await kortix.projects.list();
```

## No bundler, no framework

```html
<script src="https://unpkg.com/@kortix/sdk"></script>
<script>
  const kortix = Kortix.createKortix({ backendUrl, getToken });
</script>
```

## Entry points

`@kortix/sdk` is the canonical entry — everything framework-free lives there.
Three others exist, each for a reason that fits in one sentence:

| Entry | Why it can't live at root |
|---|---|
| `@kortix/sdk/react` | React is a peer dependency |
| `@kortix/sdk/server` | imports `node:async_hooks` |
| `@kortix/sdk/internal/*` | unsupported, outside semver |

Older subpaths (`@kortix/sdk/projects-client`, `/turns`, …) still work and are
`@deprecated`. Import from the root instead.

> **React Native / Expo:** REST works. **Streaming does not** — RN's `fetch` has
> no `response.body`. Tracked; do not depend on it yet.
````

- [ ] **Step 2: API-MAP — add the stability table**

```markdown
## Stability

| Tier | Entries | Guarantee |
|---|---|---|
| Stable | `.`, `./react`, `./server` | semver |
| Deprecated | the 21 legacy subpaths | works; removed on the next major |
| Internal | `./internal/*` | **no guarantee**, may change in any release |
```

- [ ] **Step 3: CHANGELOG — describe the surface change, not the file moves**

```markdown
## Unreleased

### Added
- The root entry `@kortix/sdk` is now canonical: it exports the whole
  framework-free surface (client, session, turns, files, event stream, errors).
- CDN builds: a minified ESM bundle and an IIFE exposing `window.Kortix`.
  Usable from a `<script>` tag with no bundler.
- `KortixMasterProject` — the kortix-master daemon's board project.
- `@kortix/sdk/internal/*` for the zustand stores. Not covered by semver.

### Deprecated
- The 21 legacy subpaths (`/projects-client`, `/turns`, `/files`, `/session`,
  `/event-stream`, the stores, …). They still work. Import from the root.
- `KortixProject` **as exported from `@kortix/sdk/opencode-client`** — renamed to
  `KortixMasterProject`. The platform's `KortixProject` (from the root) is
  unchanged and keeps its name.

### Fixed
- `getPlatformUrl()` no longer reads a bare `process.env`, which threw a
  `ReferenceError` in a browser `<script>` bundle and on React Native.

### Internal
- `src/` is now tiered: `core/` (isomorphic), `browser/`, `node/`, `react/`.
  A file's directory declares what it may import, enforced by the tripwire.
- `turns/index.ts` (1434 loc) split into `parts`/`grouping`/`shell`/`state`.
- CI now packs, installs, and imports the tarball, and asserts the two export
  maps agree.
```

- [ ] **Step 4: Verify the README's claims are true**

```bash
pnpm --filter @kortix/sdk run build:bundles && pnpm --filter @kortix/sdk run smoke:install
```

Do not document a `<script src="https://unpkg.com/@kortix/sdk">` path unless `publishConfig.unpkg` points at a file that exists in `dist/`.

- [ ] **Step 5: Commit**

```bash
git add -A packages/sdk
git commit -m "docs(sdk): document the single canonical entry, CDN usage, and the stability tiers"
```

---

## Deferred (do not start)

- **The `EventStreamTransport` seam** for React Native. Designed in the spec, deliberately out of scope. Until it lands, `apps/mobile/lib/opencode/event-stream.ts` (655 loc) stays a parallel implementation of the SDK's 571-loc one, and the divergence grows. Schedule it soon.
- **Migrating `apps/web`'s 340 import sites** to the root entry. Optional and mechanical — the deprecated aliases mean it never has to happen on a deadline.
- **Lumen productionisation.** Its ownership store is a JSON file (`src/server/users.ts`) and its rate limiter is an in-memory `Map` (`src/server/rate-limit.ts`); both are documented single-instance. Anonymous visitors mint a fresh `userId` per visit, so a `userId`-keyed rate limit is trivially bypassed, and they provision **real Daytona sandboxes**. Separate spec.

---

## Self-Review

**Spec coverage.** D1 → Task 9 Step 1. D2/D2a → Task 9 Step 6. D2b → Task 8 Step 2. D2c → Task 7. D2d → Task 5 Step 13. D3 → Task 9 Step 5 (`instanceof Kortix.ApiError`). D4 → Tasks 4, 7, 9. D5 → Task 2. D6 → Tasks 3, 5 Step 12. D7 → Task 5 (react consumes the public contract). D8 → Task 6. D9 → every task's final verify. Axis 1 → Task 4. Axis 2 → Task 5. `KortixProject` → Task 5 Steps 1–5. The 7 ambiguities → Task 5 Step 6.

**Known plan risks, stated rather than hidden:**

1. **Task 4 is by far the largest task** and resists TDD, because it is a move, not a behaviour change. Its test is the *invariance* of the Task 3 snapshot — which is why Task 3 must land first. Do not start Task 4 until Tasks 1–3 are committed and green.
2. **Task 2's smoke script has never been executed.** It is written against `stage-npm-publish.mjs`'s real contract (it reads `VERSION` from env, mutates `package.json` in place), and Step 1's `finally` block restores the manifest on any failure. If Step 2 fails on first run, read the error before assuming the script is wrong — a genuine break in the published artifact is exactly what this task exists to surface.
3. **Task 5 Step 6's barrel is a best guess** at the seven ambiguities from a `tsc` probe run before the restructure. Step 7 re-runs the check for real. If new `TS2308`s appear, they are new information — resolve each with an explicit re-export or an alias, and note it in the CHANGELOG.
4. **Task 6 Steps 3–4 name facade methods (`tokens.createCliToken`, `gateway.sessions`) that I have not verified exist** under those exact names. Each step says to `grep` first and use the real name. This is the one place the plan knowingly hands the implementer a lookup instead of an answer.
5. **Task 7's regex** flags a bare global when its `typeof` guard sits on a previous line. Step 2 says to widen the line-window rather than weaken the pattern.
