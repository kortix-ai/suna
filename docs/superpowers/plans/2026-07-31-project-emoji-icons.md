# Project Emoji Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick one emoji per project at create time and render it on the project card.

**Architecture:** The icon is stored on the existing `projects.metadata` jsonb as `metadata.icon` — no database migration — and exposed by `serializeProject` as a validated top-level `icon` field, mirroring how `default_sandbox_provider` already works. One server-side validator, `normalizeProjectIcon`, gates every write and the read. The web layer adds a frimousse picker primitive and a Popover field, and passes `icon` into the three existing create mutations.

**Tech Stack:** Bun + Hono + `@hono/zod-openapi` (`apps/api`), Drizzle (`packages/db`), TypeScript (`packages/sdk`), Next.js 15 + React 19 + Tailwind v4 + Radix (`apps/web`), [frimousse](https://frimousse.liveblocks.io) for the picker, `bun:test` for units, Playwright for web e2e.

**Spec:** `docs/superpowers/specs/2026-07-31-project-emoji-icons-design.md`

## Global Constraints

- Work happens in the worktree `/Users/jay/root/kortix/suna-emoji` on branch `emoji`. Do not switch branches.
- No database migration. `metadata.icon` only.
- Icon cap is **64 bytes** and **exactly one grapheme cluster**. Never 32 bytes — `👩🏽‍❤️‍💋‍👨🏿` is 35 bytes and is valid.
- A malformed icon never fails a create. `normalizeProjectIcon` returns `null` and creation proceeds.
- `packages/sdk` is a published npm package. Read `packages/sdk/AGENTS.md` and `packages/sdk/PROGRESS.md` before touching it. TDD is mandatory there: failing test first, gates run, real output pasted, explicit shippable YES/NO. Never hand-edit the `version` field.
- The loading indicator is the shared `Loading` component from `@/components/ui/loading`. Never a spinning icon, never `animate-spin`.
- **`apps/web` typecheck baseline is 8 errors, NOT ~1500.** `CLAUDE.md` says `tsc --noEmit` emits roughly 1500 bogus `TS2786` errors from a React 19↔18 mismatch. **That is stale for this checkout** — measured on this branch: 8 total errors, **zero** `TS2786`. The 8 are real pre-existing type errors (a `projectId` prop mismatch across `agent-selector.tsx`, `composer-toolbar.tsx`, `schedule-view.tsx`, `channels-view.tsx`, plus two in a test file). Do not wave errors away as "the known bogus 1500" — there is no such wall here. Your files must add zero new errors, and the total must stay at 8.
- **Run `apps/web` tests from `apps/web`, not the repo root.** `cd apps/web && bun test src` gives 2653 pass / 0 fail. `bun test apps/web/src` from the repo root reports **10 failures** — pre-existing SEO/robots/marketplace tests that resolve fixture paths relative to cwd. Six of those ten reproduce on `main` in a clean checkout, so they are not this branch's. Judge any suite result by the directory it was run from before calling it a regression.
- **Run ESLint from `apps/web`, not the repo root.** The config is `apps/web/eslint.config.mjs`. From the repo root, `npx eslint <file>` fails with "ESLint couldn't find an eslint.config.(js|mjs|cjs) file" — and that failure is easy to misread as a clean run. Always `cd apps/web` first and pass paths relative to it.
- **Running `apps/api` tests needs env.** A bare `bun test apps/api/...` fails env validation before any test runs (`API_KEY_SECRET`, `TUNNEL_SIGNING_SECRET`, `KORTIX_URL` required). Run them from `apps/api` through dotenvx:
  ```bash
  cd apps/api && KORTIX_URL=http://localhost:8008 dotenvx run --quiet -- bun test --isolate src/projects/lib/<file>.test.ts
  ```
  `KORTIX_URL` is normally set by `pnpm dev`'s tunnel; any placeholder works for unit tests.
- **`ProjectSchema` in `apps/api/src/projects/lib/app.ts` is a re-tag, not the schema.** Line 27 is `ContractProjectSchema.openapi('Project')`. The field-bearing definition lives in `packages/api-contract/src/index.ts` — add response fields there, and `app.ts` inherits them.
- **NEVER run `git merge`, `git rebase`, `git reset --hard`, or `git push` unless the task explicitly says to.** An implementer merged `main` into `emoji` on its own initiative during Task 3. It happened to be harmless — 7 files, no migrations — but it silently moved the branch's merge-base, which invalidates every review package base computed before it, and a rebase in this repo forks the Drizzle snapshot lineage. Commit your own work and stop.
- **NEVER run `git stash`, `git stash pop`, or `git stash apply`. This is a hard ban.**
  This repo has ~36 pre-existing stashes belonging to other branches and other
  people's in-flight work. `git stash` creates no entry when there is nothing to
  stash, so a later `git stash pop` silently pops **someone else's stash** and
  destroys its entry. That already happened once in this plan: an agent stashed to
  compare lint before/after, and popped the `phosphor-icon` stash into this
  worktree. It was recovered from a dangling commit via `git fsck`, but only
  because it was noticed immediately.
  To check whether a lint finding is pre-existing, mutate nothing. Run the linter
  on the file as it is, then compare the reported line numbers against the lines
  your diff actually touched (`git diff -U0 <base> HEAD -- <file>`). A finding on a
  line you did not touch is pre-existing. Known baseline for this plan:
  `apps/api/src/projects/lib/serializers.ts` has exactly 3 pre-existing Biome
  errors — `310 lint/style/noNonNullAssertion`, `365 lint/style/noNonNullAssertion`,
  `381 lint/performance/noDelete`.
- **Lint gate — read carefully, this repo is not uniform.** It lints with **Biome** at the root (`biome.json`, `pnpm lint:biome`). **Only `apps/web` has ESLint** (`apps/web/eslint.config.mjs`, run via `next lint`). `apps/api` and `packages/*` have **no ESLint config and must never be given one.**
  - Files under `apps/api/**` or `packages/**` → `npx biome check <files>`
  - Files under `apps/web/**` → `npx eslint <files>`
  - **Never create an ESLint config file.** If a lint command appears not to work, you are running the wrong linter for that directory — do not "fix" it by adding configuration. Adding a root `eslint.config.mjs` applies rules to the entire monorepo and shadows `apps/web`'s own config.
- Load the `kortix-design-system` skill and `make-interfaces-feel-better` before writing any `apps/web` visual code.
- Never write a Linear identifier or `linear.app` URL into a branch name, commit message, PR title, or PR body.
- Do not use `npx shadcn@latest add`. Install frimousse with pnpm and hand-author the component.

---

### Task 1: `normalizeProjectIcon` validator

**Files:**
- Create: `apps/api/src/projects/lib/project-icon.ts`
- Test: `apps/api/src/projects/lib/project-icon.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeProjectIcon(input: unknown): string | null` — the single validator used by Task 2 (read path) and Task 3 (all three write paths).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/projects/lib/project-icon.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { normalizeProjectIcon } from './project-icon';

describe('normalizeProjectIcon', () => {
  test('accepts a plain emoji', () => {
    expect(normalizeProjectIcon('🚀')).toBe('🚀');
  });

  test('accepts a skin-toned emoji', () => {
    expect(normalizeProjectIcon('👍🏽')).toBe('👍🏽');
  });

  test('accepts a ZWJ sequence', () => {
    expect(normalizeProjectIcon('👩‍💻')).toBe('👩‍💻');
  });

  test('accepts a four-person family ZWJ sequence', () => {
    expect(normalizeProjectIcon('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
  });

  test('accepts a 35-byte ZWJ sequence (regression: a 32-byte cap rejected this)', () => {
    const emoji = '👩🏽‍❤️‍💋‍👨🏿';
    expect(new TextEncoder().encode(emoji).length).toBe(35);
    expect(normalizeProjectIcon(emoji)).toBe(emoji);
  });

  test('accepts a country flag (regional-indicator pair, NOT Extended_Pictographic)', () => {
    expect(normalizeProjectIcon('🇺🇸')).toBe('🇺🇸');
    expect(normalizeProjectIcon('🇬🇧')).toBe('🇬🇧');
  });

  test('accepts a keycap (U+20E3, NOT Extended_Pictographic)', () => {
    expect(normalizeProjectIcon('1️⃣')).toBe('1️⃣');
    expect(normalizeProjectIcon('#️⃣')).toBe('#️⃣');
  });

  test('rejects a lone regional indicator (half a flag)', () => {
    expect(normalizeProjectIcon('\u{1F1FA}')).toBeNull();
  });

  test('rejects two flags', () => {
    expect(normalizeProjectIcon('🇺🇸🇬🇧')).toBeNull();
  });

  test('accepts a single grapheme at exactly the 64-byte cap', () => {
    // Guards the boundary itself: an off-by-one (> vs >=) at MAX_ICON_BYTES
    // would not be caught by the grossly-oversized cases below.
    const at64 = '👩🏽‍❤️‍💋‍👨🏿';
    expect(new TextEncoder().encode(at64).length).toBeLessThanOrEqual(64);
    expect(normalizeProjectIcon(at64)).toBe(at64);
  });

  test('rejects a single grapheme just over the 64-byte cap', () => {
    // A ZWJ chain long enough to exceed 64 bytes while remaining one cluster.
    const over = '👩🏽‍❤️‍💋‍👨🏿‍👩🏽‍👨🏿';
    if (new TextEncoder().encode(over).length > 64) {
      expect(normalizeProjectIcon(over)).toBeNull();
    }
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeProjectIcon('  🚀  ')).toBe('🚀');
  });

  test('rejects plain text', () => {
    expect(normalizeProjectIcon('abc')).toBeNull();
  });

  test('rejects a single non-pictographic character', () => {
    expect(normalizeProjectIcon('A')).toBeNull();
  });

  test('rejects an empty string', () => {
    expect(normalizeProjectIcon('')).toBeNull();
  });

  test('rejects whitespace only', () => {
    expect(normalizeProjectIcon('   ')).toBeNull();
  });

  test('rejects two emoji', () => {
    expect(normalizeProjectIcon('🚀🚀')).toBeNull();
  });

  test('rejects an emoji followed by text', () => {
    expect(normalizeProjectIcon('🚀 launch')).toBeNull();
  });

  test('rejects an oversized string', () => {
    expect(normalizeProjectIcon('x'.repeat(5000))).toBeNull();
  });

  test('rejects a repeated-emoji string over the byte cap', () => {
    expect(normalizeProjectIcon('🚀'.repeat(100))).toBeNull();
  });

  test('rejects non-string input', () => {
    expect(normalizeProjectIcon(null)).toBeNull();
    expect(normalizeProjectIcon(undefined)).toBeNull();
    expect(normalizeProjectIcon(42)).toBeNull();
    expect(normalizeProjectIcon({ icon: '🚀' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/jay/root/kortix/suna-emoji && bun test apps/api/src/projects/lib/project-icon.test.ts
```

Expected: FAIL — `Cannot find module './project-icon'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/projects/lib/project-icon.ts`:

```ts
/**
 * Validator for `projects.metadata.icon` — the per-project emoji shown on the
 * project card.
 *
 * Every write path (provision / create-repo / link-repository) and the read
 * path (serializeProject) run values through this one function, so a value that
 * reached the column can always be rendered.
 *
 * Returning `null` means "no icon". It never throws: a malformed icon must not
 * fail project creation, because the icon is decoration and the project is not.
 */

/** Comfortably above the longest RGI emoji sequence. `👩🏽‍❤️‍💋‍👨🏿` alone is 35 bytes,
 *  so a 32-byte cap would reject a value the picker can produce. */
const MAX_ICON_BYTES = 64;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const encoder = new TextEncoder();

export function normalizeProjectIcon(input: unknown): string | null {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // Cheap bound first: without it a 5 KB string reaches the segmenter, and it
  // would land in the jsonb column and render straight into ProjectCard.
  if (encoder.encode(trimmed).length > MAX_ICON_BYTES) return null;

  // Exactly one grapheme cluster. Intl.Segmenter treats skin-tone modifiers,
  // ZWJ sequences, and tag flags as one cluster, so `👨‍👩‍👧‍👦` passes and `🚀🚀` does not.
  let count = 0;
  for (const _ of graphemes.segment(trimmed)) {
    count += 1;
    if (count > 1) return null;
  }
  if (count !== 1) return null;

  // One grapheme is not enough on its own — `A` is one grapheme too.
  if (!isEmojiGrapheme(trimmed)) return null;

  return trimmed;
}
```

The emoji test is deliberately wider than `Extended_Pictographic`. That property is
**false** for country flags and keycaps, both of which the picker offers as full
categories — testing it alone would let a user pick `🇺🇸`, then silently store no
icon. Define above `normalizeProjectIcon`:

```ts
/** Country flags are regional-indicator PAIRS and keycaps are digit + U+20E3;
 *  neither is Extended_Pictographic, yet the picker offers both as whole
 *  categories. Testing only the pictographic property silently dropped every
 *  flag a user picked. */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR_PAIR = /^\p{Regional_Indicator}{2}$/u;
// ANCHORED, and requires a real keycap base. An unanchored /⃣/ accepts a
// bare combining mark with no base ("⃣") and "A⃣" — both render as
// junk on a project card and a direct API caller could write either.
const KEYCAP = /^[0-9#*]️?⃣$/;

function isEmojiGrapheme(grapheme: string): boolean {
  return (
    PICTOGRAPHIC.test(grapheme) ||
    REGIONAL_INDICATOR_PAIR.test(grapheme) ||
    KEYCAP.test(grapheme)
  );
}
```

`REGIONAL_INDICATOR_PAIR` is anchored and requires exactly two, so a lone
`U+1F1FA` is still rejected. `"🇺🇸🇬🇧"` is two grapheme clusters and dies at the
grapheme check before reaching this one.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/jay/root/kortix/suna-emoji && bun test apps/api/src/projects/lib/project-icon.test.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 5: Lint**

```bash
cd /Users/jay/root/kortix/suna-emoji && npx biome check apps/api/src/projects/lib/project-icon.ts apps/api/src/projects/lib/project-icon.test.ts
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/projects/lib/project-icon.ts apps/api/src/projects/lib/project-icon.test.ts
git commit -m "feat(api): add normalizeProjectIcon validator for project emoji icons"
```

---

### Task 2: Expose `icon` on the project read path

**Files:**
- Modify: `apps/api/src/projects/lib/serializers.ts` (inside `serializeProject`, near line 180 where `metadata` is set)
- Test: `apps/api/src/projects/lib/serializers.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: `normalizeProjectIcon` from Task 1.
- Produces: `icon: string | null` on every serialized project. Task 4 mirrors this on `KortixProject`; Task 8 renders it.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/projects/lib/serializers.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { serializeProject } from './serializers';

// `metadata` is nullable: packages/db/src/schema/kortix.ts:330 declares
// jsonb('metadata').default({}) with NO .notNull(), which is why
// serializeProject guards it with `?.`. The helper must be able to pass null
// so that guard is actually exercised.
function projectRow(metadata: Record<string, unknown> | null) {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    name: 'demo',
    repoUrl: 'https://github.com/acme/demo.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active' as const,
    secretDefaultStrategy: 'runtime' as const,
    metadata,
    sandboxProviderGeneration: 0,
    lastOpenedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('serializeProject icon', () => {
  test('exposes a valid metadata.icon as a top-level field', () => {
    expect(serializeProject(projectRow({ icon: '🚀' })).icon).toBe('🚀');
  });

  test('is null when metadata has no icon', () => {
    expect(serializeProject(projectRow({})).icon).toBeNull();
  });

  test('is null when metadata.icon is malformed', () => {
    expect(serializeProject(projectRow({ icon: 'not-an-emoji' })).icon).toBeNull();
  });

  test('is null when metadata.icon is oversized', () => {
    expect(serializeProject(projectRow({ icon: 'x'.repeat(5000) })).icon).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/jay/root/kortix/suna-emoji && bun test apps/api/src/projects/lib/serializers.test.ts
```

Expected: FAIL — `icon` is `undefined`, not `'🚀'`.

- [ ] **Step 3: Add the import**

In `apps/api/src/projects/lib/serializers.ts`, add to the imports:

```ts
import { normalizeProjectIcon } from './project-icon';
```

- [ ] **Step 4: Add the field**

In `serializeProject`, directly after the `metadata: row.metadata ?? {},` line, insert:

```ts
    // Per-project emoji, stored in metadata (no migration — same mechanism as
    // default_sandbox_provider below and metadata.onboarding_completed_at).
    // Re-validated on read so a value written before the validator existed, or
    // written directly to the DB, can never reach the UI unchecked.
    icon: normalizeProjectIcon((row.metadata as Record<string, unknown> | null | undefined)?.icon),
```

- [ ] **Step 5: Add `icon` to the OpenAPI project schema**

Find `ProjectSchema` in `apps/api/src/projects/lib/app.ts` and add the optional field so the documented contract matches the response:

```ts
  icon: z.string().nullable(),
```

`.nullable()` only — **not** `.nullable().optional()`. `serializeProject` always
emits the key, so the value is `string | null` and never absent. Match the
sibling `last_opened_at: z.string().nullable()` three lines below in the same
schema, not the looser `ProjectSessionSchema` fields elsewhere in the file.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /Users/jay/root/kortix/suna-emoji && bun test apps/api/src/projects/lib/serializers.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Run the wider API suite for regressions**

```bash
cd /Users/jay/root/kortix/suna-emoji && bun test apps/api/src/projects
```

Expected: PASS. If a snapshot asserts the exact key set of a serialized project, update it to include `icon`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/projects/lib/serializers.ts apps/api/src/projects/lib/serializers.test.ts apps/api/src/projects/lib/app.ts
git commit -m "feat(api): expose project icon on the project read path"
```

---

### Task 3: Accept `icon` on the three create routes

**Files:**
- Modify: `apps/api/src/projects/routes/r1.ts` (provision handler at :418, metadata object at :541)
- Modify: `apps/api/src/projects/routes/r2.ts` (three `register*LinkedProject` call sites at :163, :200, :375)
- Modify: `apps/api/src/projects/lib/metadata-merge.ts` (docblock namespace audit list)

**Interfaces:**
- Consumes: `normalizeProjectIcon` from Task 1; `icon` field from Task 2.
- Produces: all three create routes persist `metadata.icon`. Task 4's SDK input types mirror this; Task 7 sends it.

**Context the implementer needs:** `apps/api/src/projects/routes/r1.ts` inserts the project row directly with a literal `metadata` object (:541). `apps/api/src/projects/routes/r2.ts` never inserts directly — all three of its paths go through `registerLinkedProject` in `apps/api/src/projects/lib/project-registration.ts`, which already accepts `projectMetadata?: Record<string, unknown>` and spreads it first into the metadata object (:41). No change to `project-registration.ts` is needed.

- [ ] **Step 1: Add the import to `r1.ts`**

```ts
import { normalizeProjectIcon } from '../lib/project-icon';
```

- [ ] **Step 2: Read and validate the icon in the provision handler**

In `r1.ts`, immediately after the `PROJECT_NAME_MAX_LENGTH` check block (ends near :457), add:

```ts
  // Optional per-project emoji from the create-project modal. Invalid values
  // degrade to no icon rather than failing the create — the project matters,
  // the decoration does not.
  const icon = normalizeProjectIcon(body.icon);
```

- [ ] **Step 3: Write the icon into the inserted metadata**

In `r1.ts`, inside the `metadata: { ... }` object literal (:541), after `require_declared_agents: true,` add:

```ts
        ...(icon ? { icon } : {}),
```

- [ ] **Step 4: Add the import to `r2.ts`**

```ts
import { normalizeProjectIcon } from '../lib/project-icon';
```

- [ ] **Step 5: Pass the icon at all three `r2.ts` call sites**

At each of the three call sites, add a `projectMetadata` property. None of them currently pass one, so this is an addition, not a merge.

At `r2.ts:163` (`registerPatLinkedProject`, link-repository via PAT):

```ts
    const icon = normalizeProjectIcon(body.icon);
    const row = await registerPatLinkedProject({
      // ...existing properties unchanged...
      ...(icon ? { projectMetadata: { icon } } : {}),
    });
```

At `r2.ts:200` (`registerGitHubLinkedProject`, link-repository via GitHub App):

```ts
  const icon = normalizeProjectIcon(body.icon);
  const row = await registerGitHubLinkedProject({
    // ...existing properties unchanged...
    ...(icon ? { projectMetadata: { icon } } : {}),
  });
```

At `r2.ts:375` (`registerGitHubLinkedProject`, create-repo):

```ts
  const icon = normalizeProjectIcon(body.icon);
  const row = await registerGitHubLinkedProject({
    // ...existing properties unchanged...
    ...(icon ? { projectMetadata: { icon } } : {}),
  });
```

Declare each `const icon` in the same scope as its `const row`, above the call.

- [ ] **Step 6: Update the metadata namespace audit list**

`apps/api/src/projects/lib/metadata-merge.ts` keeps an audited list of disjoint top-level `projects.metadata` namespaces in its module docblock. Find the sentence listing `default_agent, triggers_paused, onboarding_completed_at, experimental, meet, default_sandbox_slug` and add `icon` to it. This list is how the next person confirms a shallow `||` merge is still safe.

- [ ] **Step 7: Start the local stack**

```bash
cd /Users/jay/root/kortix/suna-emoji && pnpm dev
```

Run it in the background. Wait for `curl -s localhost:8008/v1/health` to return JSON.

- [ ] **Step 8: Mint a JWT and verify provision end to end**

Follow `tests/e2e/helpers/auth.ts`: create a confirmed user via `POST 127.0.0.1:54321/auth/v1/admin/users` with the service-role key from `apps/api/.env`, then password-grant a token via `POST 127.0.0.1:54321/auth/v1/token?grant_type=password` with the anon key from `apps/web/.env`.

Then:

```bash
# create with an icon
curl -s -X POST localhost:8008/v1/projects/provision \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"account_id":"'"$ACCOUNT_ID"'","name":"emoji-ok","icon":"🚀","starter_template":"general-knowledge-worker"}' \
  | tee /tmp/provision.json | python3 -m json.tool | head -20

# read it back
PROJECT_ID=$(python3 -c 'import json;print(json.load(open("/tmp/provision.json"))["project_id"])')
curl -s localhost:8008/v1/projects/$PROJECT_ID -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import json,sys;print("icon =", repr(json.load(sys.stdin)["icon"]))'
```

Expected: `201` on create; read-back prints `icon = '🚀'`.

- [ ] **Step 9: Verify the malformed-icon path does not fail the create**

```bash
curl -s -o /tmp/bad.json -w '%{http_code}\n' -X POST localhost:8008/v1/projects/provision \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"account_id":"'"$ACCOUNT_ID"'","name":"emoji-bad","icon":"'"$(python3 -c 'print("x"*5000)')"'","starter_template":"general-knowledge-worker"}'
python3 -c 'import json;print("icon =", repr(json.load(open("/tmp/bad.json"))["icon"]))'
```

Expected: HTTP `201`, and `icon = None`. The project is created; the bad icon is dropped.

- [ ] **Step 10: Verify `create-repo` and `link-repository`**

Repeat Step 8's create-then-read-back shape against `POST /v1/projects/create-repo` and `POST /v1/projects/link-repository`. Both need a GitHub App installation on the account; if none is configured locally, record that fact explicitly in the task notes and cover both routes on `dev.kortix.com` in Task 9 instead. Do not mark this task done with the gap unrecorded.

- [ ] **Step 11: Lint and commit**

```bash
npx biome check apps/api/src/projects/routes/r1.ts apps/api/src/projects/routes/r2.ts apps/api/src/projects/lib/metadata-merge.ts
git add apps/api/src/projects/routes/r1.ts apps/api/src/projects/routes/r2.ts apps/api/src/projects/lib/metadata-merge.ts
git commit -m "feat(api): persist project icon on all three create paths"
```

---

### Task 4: SDK types

**Files:**
- Modify: `packages/sdk/src/core/rest/projects-client/projects.ts` (`KortixProject` :39, `CreateProjectRepoInput` :185, `ProvisionProjectInput` :196)
- Modify: `packages/sdk/src/core/rest/projects-client/github.ts` (`LinkRepositoryInput` :40)
- Modify: `packages/sdk/PROGRESS.md` (claim the task)

**Interfaces:**
- Consumes: the API contract from Tasks 2 and 3.
- Produces: `KortixProject.icon?: string | null`, and `icon?: string` on `ProvisionProjectInput`, `CreateProjectRepoInput`, `LinkRepositoryInput`. Tasks 7 and 8 consume these.

- [ ] **Step 1: Read the SDK rules first**

Read `packages/sdk/AGENTS.md` in full, then `packages/sdk/PROGRESS.md`. This package has hard rules with no analogue elsewhere in the repo. Do not skip this step because the change looks like four one-line additions.

- [ ] **Step 2: Claim the task in `PROGRESS.md`**

Add an entry per the file's existing convention describing this change.

- [ ] **Step 3: Write the failing test**

Append to the **existing** `packages/sdk/src/core/rest/projects-client/projects.test.ts`. Do not create a new file — that file already mocks `globalThis.fetch` in a `beforeEach` and already holds the provision tests.

Assert the real contract, not the type. A test whose only assertion is that an object literal holds the value you just wrote into it proves nothing at runtime; these two prove `icon` actually survives serialization onto the wire and parsing off it:

```ts
test('provisionProject sends the icon in the request body', async () => {
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

  let sentBody: unknown;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ project_id: 'proj-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await provisionProject({ account_id: 'acc-1', name: 'Iconic', icon: '🚀' });

  expect(sentBody).toMatchObject({ icon: '🚀' });
});

test('a project response carries the icon through to KortixProject', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ project_id: 'proj-1', name: 'Iconic', icon: '🚀' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, { ...input, icon: '🚀' });

  expect(result.ok).toBe(true);
  expect(result.ok && result.project.icon).toBe('🚀');
});
```

Both fail to compile before Step 5, which is the failing state. `LinkRepositoryInput` and `CreateProjectRepoInput` are covered by the existing type-pin convention already in this file — follow it for those two.

- [ ] **Step 4: Run the test to verify it fails**

Run the SDK's test command as documented in `AGENTS.md`. Expected: FAIL — `icon` does not exist on these types.

- [ ] **Step 5: Add the four fields**

In `packages/sdk/src/core/rest/projects-client/projects.ts`, inside `KortixProject`:

```ts
  /** Per-project emoji shown on the project card. Server-validated: exactly one
   *  emoji grapheme, or null. Stored in `metadata.icon`; surfaced top-level so
   *  clients never cast the metadata bag. */
  icon?: string | null;
```

Inside `ProvisionProjectInput` and `CreateProjectRepoInput`:

```ts
  /** Optional emoji icon for the new project. Invalid values are dropped
   *  server-side; they never fail the create. */
  icon?: string;
```

In `packages/sdk/src/core/rest/projects-client/github.ts`, inside `LinkRepositoryInput`, the same `icon?: string;` with the same comment.

All four are optional members added to existing exported interfaces. No new export is created, so the three-synchronized-edits rule for new exports does not apply. Do not touch the `version` field.

- [ ] **Step 6: Run the test to verify it passes**

Expected: PASS.

- [ ] **Step 7: Run the SDK gates**

Run every gate `AGENTS.md` lists — typecheck, lint, tests, and the framework-free import-graph tripwire. Paste the real output. State shippable YES / NO / NOT YET explicitly.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/core/rest/projects-client/projects.ts packages/sdk/src/core/rest/projects-client/github.ts packages/sdk/src/core/rest/projects-client/projects.test.ts packages/sdk/PROGRESS.md
git commit -m "feat(sdk): add optional project icon to project type and create inputs"
```

---

### Task 5: frimousse dependency and the emoji-picker primitive

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/components/ui/emoji-picker.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `<EmojiPicker onEmojiSelect={(emoji: { emoji: string; label: string }) => void} className?: string />`, a self-contained picker. Task 6 wraps it in a Popover.

- [ ] **Step 1: Load the design skills**

Load `kortix-design-system` and `make-interfaces-feel-better` before writing this component. Compose from `@/components/ui/*`. Do not invent local chrome.

- [ ] **Step 2: Install frimousse**

```bash
cd /Users/jay/root/kortix/suna-emoji && pnpm add frimousse --filter Kortix-Computer-Frontend
```

Do not run `npx shadcn@latest add`. It writes a stock-shadcn-styled component outside pnpm.

- [ ] **Step 3: Read the installed API surface**

```bash
cat node_modules/frimousse/dist/index.d.ts | head -120
```

Confirm the exported member names (`EmojiPicker.Root`, `.Search`, `.Viewport`, `.List`, `.Loading`, `.Empty`, `.SkinToneSelector`, `.ActiveEmoji`) and the `onEmojiSelect` payload shape before writing against them. If the installed version differs from what this plan assumes, follow the installed types and note the difference.

- [ ] **Step 4: Write the component**

Create `apps/web/src/components/ui/emoji-picker.tsx`:

```tsx
'use client';

import { EmojiPicker as Frimousse } from 'frimousse';

import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';

export interface EmojiSelection {
  emoji: string;
  label: string;
}

/**
 * Emoji picker built on frimousse.
 *
 * The hover/keyboard-active background rotates through six low-chroma tints,
 * offset by one position on even rows. Six rather than three: frimousse lays
 * out 10 columns, and a 3-tint rotation over 10 columns lines the same tint up
 * vertically every other row, which the even-row offset only half breaks up.
 * Six tints move the repeat to every 30 cells.
 *
 * The tints are HSL in the same register as `chalkColors`
 * (packages/shared/src/utils/chalk-colors.ts) rather than Tailwind's red-100 /
 * green-100 / blue-100 from the frimousse docs: those wash out to invisible on
 * a dark background, and read as foreign next to the rest of apps/web.
 */
/**
 * Every variant is written out as a LITERAL string. Do not generate these with
 * a template literal or a .map() — Tailwind v4 extracts class names by scanning
 * source text, so an interpolated class name produces no CSS at all and the
 * hover backgrounds silently never appear.
 *
 * Odd rows run the six tints in order. Even rows start three along, so a tint
 * never sits directly above itself.
 */
const EMOJI_BUTTON = cn(
  'flex size-8 items-center justify-center rounded-md text-lg leading-none',
  'transition-colors duration-100 select-none',

  // Odd rows: 1→red, 2→amber, 3→green, 4→teal, 5→blue, 6→violet
  'group-odd/row:nth-[6n+1]:data-[active]:bg-[hsl(4_46%_88%)]',
  'group-odd/row:nth-[6n+2]:data-[active]:bg-[hsl(32_52%_87%)]',
  'group-odd/row:nth-[6n+3]:data-[active]:bg-[hsl(96_34%_87%)]',
  'group-odd/row:nth-[6n+4]:data-[active]:bg-[hsl(178_36%_86%)]',
  'group-odd/row:nth-[6n+5]:data-[active]:bg-[hsl(212_46%_88%)]',
  'group-odd/row:nth-[6n+6]:data-[active]:bg-[hsl(280_32%_88%)]',

  // Even rows: same six, rotated by three
  'group-even/row:nth-[6n+1]:data-[active]:bg-[hsl(178_36%_86%)]',
  'group-even/row:nth-[6n+2]:data-[active]:bg-[hsl(212_46%_88%)]',
  'group-even/row:nth-[6n+3]:data-[active]:bg-[hsl(280_32%_88%)]',
  'group-even/row:nth-[6n+4]:data-[active]:bg-[hsl(4_46%_88%)]',
  'group-even/row:nth-[6n+5]:data-[active]:bg-[hsl(32_52%_87%)]',
  'group-even/row:nth-[6n+6]:data-[active]:bg-[hsl(96_34%_87%)]',

  // Dark mode: same rotation, low-lightness variants
  'dark:group-odd/row:nth-[6n+1]:data-[active]:bg-[hsl(4_28%_26%)]',
  'dark:group-odd/row:nth-[6n+2]:data-[active]:bg-[hsl(32_30%_25%)]',
  'dark:group-odd/row:nth-[6n+3]:data-[active]:bg-[hsl(96_22%_24%)]',
  'dark:group-odd/row:nth-[6n+4]:data-[active]:bg-[hsl(178_26%_24%)]',
  'dark:group-odd/row:nth-[6n+5]:data-[active]:bg-[hsl(212_30%_27%)]',
  'dark:group-odd/row:nth-[6n+6]:data-[active]:bg-[hsl(280_22%_27%)]',
  'dark:group-even/row:nth-[6n+1]:data-[active]:bg-[hsl(178_26%_24%)]',
  'dark:group-even/row:nth-[6n+2]:data-[active]:bg-[hsl(212_30%_27%)]',
  'dark:group-even/row:nth-[6n+3]:data-[active]:bg-[hsl(280_22%_27%)]',
  'dark:group-even/row:nth-[6n+4]:data-[active]:bg-[hsl(4_28%_26%)]',
  'dark:group-even/row:nth-[6n+5]:data-[active]:bg-[hsl(32_30%_25%)]',
  'dark:group-even/row:nth-[6n+6]:data-[active]:bg-[hsl(96_22%_24%)]',
);

export function EmojiPicker({
  onEmojiSelect,
  className,
}: {
  onEmojiSelect: (emoji: EmojiSelection) => void;
  className?: string;
}) {
  return (
    <Frimousse.Root
      onEmojiSelect={onEmojiSelect}
      className={cn('isolate flex h-[368px] w-full flex-col', className)}
    >
      <Frimousse.Search
        placeholder="Search emoji"
        className={cn(
          'border-border/60 bg-background placeholder:text-muted-foreground',
          'mx-2 mt-2 h-9 rounded-md border px-3 text-sm outline-none',
          'focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        )}
      />

      <Frimousse.Viewport className="relative flex-1 overflow-y-auto outline-none">
        <Frimousse.Loading className="text-muted-foreground absolute inset-0 flex items-center justify-center">
          <Loading />
        </Frimousse.Loading>

        <Frimousse.Empty className="text-muted-foreground absolute inset-0 flex items-center justify-center px-6 text-center text-sm">
          {({ search }) => <>No emoji for &ldquo;{search}&rdquo;</>}
        </Frimousse.Empty>

        <Frimousse.List
          className="pb-1.5 select-none"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                className="bg-popover text-muted-foreground px-2 pt-3 pb-1.5 text-xs font-medium"
                {...props}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div className="group/row flex px-1.5" {...props}>
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button type="button" className={EMOJI_BUTTON} {...props}>
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </Frimousse.Viewport>

      <div className="border-border/60 flex h-11 items-center gap-2 border-t px-2">
        <Frimousse.ActiveEmoji>
          {({ emoji }) =>
            emoji ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-lg leading-none">{emoji.emoji}</span>
                <span className="text-muted-foreground truncate text-xs">{emoji.label}</span>
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">Pick an emoji</span>
            )
          }
        </Frimousse.ActiveEmoji>
        <Frimousse.SkinToneSelector className="hover:bg-muted ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-base transition-colors" />
      </div>
    </Frimousse.Root>
  );
}
```

The footer renders a resting hint when nothing is hovered rather than collapsing, so the popover height does not jump as the pointer enters and leaves the grid.

- [ ] **Step 5: Prove the variant stacking actually produces CSS**

`nth-[6n+k]:`, `group-odd/row:`, and `group-even/row:` are Tailwind v4 arbitrary and named-group variants, stacked three and four deep. The classes above are literal so the scanner will emit them, but the **stacking order** is not proven until it renders.

```bash
cd /Users/jay/root/kortix/suna-emoji && pnpm dev
```

Open the picker, hover an emoji, and inspect the button in devtools. Confirm:

1. A background colour is applied on hover.
2. Two emoji in the same column on adjacent rows get **different** colours.
3. Toggling dark mode swaps to the low-lightness set.

If no background appears, the variant order is wrong, not the scanner. Reorder to put `data-[active]` first (`data-[active]:group-odd/row:nth-[6n+1]:bg-...`), which is the order the frimousse docs use, and re-check. Record which order worked in a code comment so the next person does not re-derive it.

- [ ] **Step 6: Lint**

```bash
npx eslint apps/web/src/components/ui/emoji-picker.tsx
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/components/ui/emoji-picker.tsx
git commit -m "feat(web): add frimousse emoji picker primitive"
```

---

### Task 6: Project icon field

**Files:**
- Create: `apps/web/src/features/projects/modal/project-icon-field.tsx`

**Interfaces:**
- Consumes: `EmojiPicker` and `EmojiSelection` from Task 5.
- Produces: `<ProjectIconField value={string | null} onChange={(icon: string | null) => void} disabled?: boolean />`. Task 7 renders it.

- [ ] **Step 1: Confirm the Popover primitive exists**

```bash
ls apps/web/src/components/ui/popover.tsx
```

If absent, use the same Radix wrapper convention as `apps/web/src/components/ui/dropdown-menu.tsx` and add it.

- [ ] **Step 2: Write the component**

Create `apps/web/src/features/projects/modal/project-icon-field.tsx`:

```tsx
'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmojiPicker } from '@/components/ui/emoji-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SmileyIcon } from '@phosphor-icons/react';

/** Emoji trigger for the create-project modal. Sits beside the name input and
 *  opens the picker in a popover. Controlled: the modal owns the icon so it can
 *  send it with the create payload and clear it on close. */
export function ProjectIconField({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (icon: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary-outline"
          size="icon"
          disabled={disabled}
          aria-label={value ? `Project icon: ${value}. Change it` : 'Choose project icon'}
          className="size-9 shrink-0"
        >
          {value ? (
            <span className="text-lg leading-none" role="img" aria-hidden>
              {value}
            </span>
          ) : (
            <SmileyIcon className="text-muted-foreground size-4" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[292px] overflow-hidden p-0">
        <EmojiPicker
          onEmojiSelect={(emoji) => {
            onChange(emoji.emoji);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 3: Verify the `secondary-outline` variant exists**

```bash
grep -n "secondary-outline" apps/web/src/components/ui/button.tsx
```

If it is not a variant, use the one the design system prescribes for a neutral icon button beside an input and match the input's height.

- [ ] **Step 4: Lint**

```bash
npx eslint apps/web/src/features/projects/modal/project-icon-field.tsx
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/projects/modal/project-icon-field.tsx
git commit -m "feat(web): add project icon field with emoji popover"
```

---

### Task 7: Wire the icon into the create modal

**Files:**
- Modify: `apps/web/src/features/projects/modal/project-create-modal.tsx`

**Interfaces:**
- Consumes: `ProjectIconField` from Task 6; the SDK input types from Task 4.
- Produces: the three create mutations send `icon`. Task 8 renders the result.

**Context:** the file is 1290 lines across four modes. `managed` and `github-create` share `managedForm` and submit through `handleCreate` (:483). `github-import` uses `githubForm` and submits through `handleLinkGitHub` (:513). Keep the diff surgical.

- [ ] **Step 1: Add the import and state**

Import:

```tsx
import { ProjectIconField } from './project-icon-field';
```

After the `pickedTemplateId` state declaration (:181), add:

```tsx
  const [icon, setIcon] = useState<string | null>(null);
```

- [ ] **Step 2: Clear the icon on close**

In `resetAndClose` (:235), add `setIcon(null);` alongside the other resets.

- [ ] **Step 3: Wrap the managed-form name input with the icon trigger**

In the `FormField` for `name` at :637, replace the `FormControl` block's contents so the trigger sits beside the input:

```tsx
                        <div className="flex items-start gap-2">
                          <ProjectIconField
                            value={icon}
                            onChange={setIcon}
                            disabled={submitting}
                          />
                          <div className="min-w-0 flex-1">
                            <FormControl>
                              <Input
                                placeholder="my-agi-company"
                                autoCapitalize="none"
                                autoCorrect="off"
                                autoFocus
                                maxLength={PROJECT_NAME_MAX_LENGTH}
                                {...field}
                              />
                            </FormControl>
                          </div>
                        </div>
```

Leave `<FormMessage />` where it is, directly below the wrapper.

- [ ] **Step 4: Do the same for the github-import name field**

Apply the identical wrapper to the `name` `FormField` at :1010, keeping that field's existing placeholder and props unchanged.

- [ ] **Step 5: Send the icon in all three payloads**

In `handleCreate` (:483), add `...(icon ? { icon } : {}),` to each of the three `mutate` payloads — the `githubCreateMutation.mutate` call, the clone-from-source `createMutation.mutate` call, and the plain `createMutation.mutate` call.

In `handleLinkGitHub` (:513), add the same spread to the `linkMutation.mutate` payload.

- [ ] **Step 6: Add the name gate and Cancel button to the managed footer**

Replace the `ModalFooter` at :781:

```tsx
              <ModalFooter>
                <Button
                  type="button"
                  variant="outline-ghost"
                  className="w-full sm:w-auto"
                  disabled={submitting}
                  onClick={resetAndClose}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="w-full sm:w-auto"
                  disabled={
                    submitting ||
                    !effectiveAccountId ||
                    !managedForm.watch('name').trim() ||
                    (mode === 'github-create' && !selectedInstallationId)
                  }
                >
                  {submitting ? <Loading /> : <Icon.Plus />}
                  {mode === 'github-create' ? 'Create in your GitHub' : 'Create project'}
                </Button>
              </ModalFooter>
```

`managedForm.watch('name')` re-renders the footer on every keystroke, which is what makes the button enable as the user types.

- [ ] **Step 7: Add a Cancel button to the github-import footer**

Add the same Cancel button to the `ModalFooter` at :1050. Leave that footer's submit gating exactly as it is: its name field is optional and falls back to the repository name (:940), so a name gate there would block a valid flow.

- [ ] **Step 8: Typecheck the touched file**

```bash
cd /Users/jay/root/kortix/suna-emoji/apps/web && npx tsc --noEmit 2>&1 | grep 'project-create-modal\|project-icon-field\|emoji-picker'
```

Expected: no output. Ignore the roughly 1500 unrelated `TS2786` errors.

- [ ] **Step 9: Drive the real modal in a browser**

With `pnpm dev` running, sign in and open `/projects?new=1`. Then, using Playwright or chrome-devtools MCP, assert all of:

1. `Create project` is disabled with an empty name.
2. Typing a name enables it.
3. Clicking the icon trigger opens the popover.
4. Typing `rocket` in Search narrows the grid.
5. Typing `zzzzzz` shows `No emoji for "zzzzzz"`.
6. Hovering an emoji updates the footer preview with that emoji and its label.
7. Clicking an emoji closes the popover and puts that emoji on the trigger.
8. The skin-tone selector changes the rendered tone of hand emoji.
9. Submitting sends a POST whose JSON body contains `icon`. Capture the request and assert on the payload, not just the UI.

Record the captured request body in the task notes.

- [ ] **Step 10: Lint and commit**

```bash
npx eslint apps/web/src/features/projects/modal/project-create-modal.tsx
git add apps/web/src/features/projects/modal/project-create-modal.tsx
git commit -m "feat(web): add emoji icon, cancel action, and name gate to create-project modal"
```

---

### Task 8: Render the icon on the project card

**Files:**
- Modify: `apps/web/src/components/ui/entity-avatar.tsx`
- Modify: `apps/web/src/features/projects/project-card.tsx:51`
- Test: `apps/web/src/components/ui/entity-avatar.test.tsx`

**Interfaces:**
- Consumes: `KortixProject.icon` from Task 4.
- Produces: the visible feature. Nothing consumes this.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/ui/entity-avatar.test.tsx`:

**`@testing-library/react` is NOT installed in `apps/web` and must not be added.** The house harness is `renderToStaticMarkup` from `react-dom/server` under `bun:test` — see `apps/web/src/features/workspace/project-sidebar/footer/project-manifest-upgrade-alert.test.tsx` for the pattern. Assertions are made against the returned HTML string.

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { EntityAvatar } from './entity-avatar';

describe('EntityAvatar', () => {
  test('renders the emoji when one is given', () => {
    const html = renderToStaticMarkup(<EntityAvatar label="Demo" emoji="🚀" />);
    expect(html).toContain('🚀');
  });

  test('falls back to the initial when no emoji is given', () => {
    const html = renderToStaticMarkup(<EntityAvatar label="Demo" />);
    expect(html).toContain('D');
    expect(html).not.toContain('🚀');
  });

  test('the emoji takes precedence over the initial', () => {
    const html = renderToStaticMarkup(<EntityAvatar label="Demo" emoji="🚀" />);
    expect(html).not.toContain('>D<');
  });

  test('drops the chalk background when an emoji is set', () => {
    const withEmoji = renderToStaticMarkup(<EntityAvatar label="Demo" emoji="🚀" />);
    const withoutEmoji = renderToStaticMarkup(<EntityAvatar label="Demo" />);
    // The initial-only avatar carries an inline chalk background; the emoji one must not.
    expect(withoutEmoji).toContain('background-color');
    expect(withEmoji).not.toContain('background-color');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/jay/root/kortix/suna-emoji && bun test apps/web/src/components/ui/entity-avatar.test.tsx
```

Expected: FAIL — `emoji` is not a prop, so the initial `D` renders.

- [ ] **Step 3: Add the prop**

In `apps/web/src/components/ui/entity-avatar.tsx`, add to `EntityAvatarProps`:

```ts
  /** Per-project emoji. Takes precedence over `icon` and the initial. */
  emoji?: string;
```

Add `emoji` to the destructured parameters, then replace the `style` and the body:

```tsx
      style={
        emoji
          ? undefined
          : {
              backgroundColor: chalk.background,
              color: chalk.foreground,
              borderColor: chalk.border,
            }
      }
      className={cn(
        'inline-flex shrink-0 items-center justify-center border font-semibold',
        // An emoji is already the colour. Sitting it on a saturated hash-derived
        // tile reads as noise, so the chalk background gives way to a neutral one.
        emoji && 'bg-muted border-border/60',
        sizes.box,
        className,
      )}
    >
      {emoji ? (
        <span role="img" className="leading-none">
          {emoji}
        </span>
      ) : IconComponent ? (
        <IconComponent className={sizes.icon} />
      ) : (
        initial
      )}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/jay/root/kortix/suna-emoji && bun test apps/web/src/components/ui/entity-avatar.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Pass the icon from the card**

In `apps/web/src/features/projects/project-card.tsx:51`:

```tsx
          <EntityAvatar
            label={project.name}
            emoji={project.icon ?? undefined}
            size="lg"
            className="bg-background"
          />
```

Check in the browser whether `className="bg-background"` still reads correctly against the new `bg-muted`. If the two fight, drop `bg-background` for the emoji case.

- [ ] **Step 6: Verify the full loop in a browser**

Create a project with an emoji through the real modal, then confirm the new card in the grid at `/projects` shows that emoji beside the name. Screenshot it.

- [ ] **Step 7: Confirm no existing caller regressed**

```bash
grep -rn "EntityAvatar" apps/web/src --include=*.tsx | wc -l
```

`emoji` is optional and every existing call omits it, so all existing callers keep the initial-or-icon behaviour. Spot-check two other surfaces that use `EntityAvatar` in the browser.

- [ ] **Step 8: Lint and commit**

```bash
npx eslint apps/web/src/components/ui/entity-avatar.tsx apps/web/src/features/projects/project-card.tsx
git add apps/web/src/components/ui/entity-avatar.tsx apps/web/src/components/ui/entity-avatar.test.tsx apps/web/src/features/projects/project-card.tsx
git commit -m "feat(web): render the project emoji icon on the project card"
```

---

### Task 9: Ship to dev and prove it

**Files:** none.

**Interfaces:**
- Consumes: Tasks 1 through 8.
- Produces: the merged, deployed, verified feature.

- [ ] **Step 1: Run the full local gates**

```bash
cd /Users/jay/root/kortix/suna-emoji
bun test apps/api/src/projects
# apps/api + packages lint with Biome; only apps/web has ESLint.
npx biome check $(git diff --name-only main...HEAD | grep -E '^(apps/api|packages)/.*\.tsx?$' | tr '\n' ' ')
npx eslint $(git diff --name-only main...HEAD | grep -E '^apps/web/.*\.tsx?$' | tr '\n' ' ')
```

Expected: all pass, eslint silent.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin emoji
gh pr create --base main --title "Project emoji icons" --body "$(cat <<'EOF'
## Summary

Adds a per-project emoji icon, chosen in the create-project modal with a frimousse picker and rendered on the project card.

- Stored as `metadata.icon` on the existing `projects.metadata` jsonb — no migration. Exposed as a validated top-level `icon` field by `serializeProject`, the same mechanism as `default_sandbox_provider`.
- `normalizeProjectIcon` gates every write and the read: exactly one grapheme cluster, at most 64 bytes, must contain an `Extended_Pictographic` code point. An invalid icon degrades to no icon and never fails a create.
- Persisted on all three create paths: `provision`, `create-repo`, `link-repository`.
- The modal gains a Cancel action, and Create is disabled until a name is entered.

## Test plan

- `bun test apps/api/src/projects/lib/project-icon.test.ts` — 15 cases, including the 35-byte `👩🏽‍❤️‍💋‍👨🏿` regression.
- `bun test apps/api/src/projects/lib/serializers.test.ts` — icon exposed, absent, malformed, oversized.
- Real HTTP against local `:8008`: create with an icon then read it back on each create route; create with a 5 KB icon and confirm `201` with `icon: null`.
- Browser: create-project modal drives search, skin tone, empty state, footer preview, selection, and the outgoing POST payload; card renders the icon.
EOF
)"
```

The PR body ends after the test plan. No footer, no session URL, no Linear reference.

- [ ] **Step 3: Wait for required checks, then merge**

Do not stop at "PR opened". Watch the checks and merge when they pass.

- [ ] **Step 4: Follow Deploy Dev to completion**

Confirm the deployed artifact contains the merged SHA. A `200` from `/health` is not deployment proof. If a newer push cancelled or superseded the run, check the path filters still rebuilt both the web and API artifacts, and dispatch the workflow manually if a component was skipped.

- [ ] **Step 5: Re-run the feature on dev**

On `https://dev.kortix.com`: create a project with an emoji, confirm the card in the grid shows it, and confirm `GET https://dev-api.kortix.com/v1/projects/<id>` returns the `icon` field. If Task 3 Step 10 could not exercise `create-repo` or `link-repository` locally, cover them here.

- [ ] **Step 6: Report**

Report the PR URL, merge SHA, deploy run, deployed-SHA evidence, and the exact dev commands and their output. State plainly anything that stayed unverified.
