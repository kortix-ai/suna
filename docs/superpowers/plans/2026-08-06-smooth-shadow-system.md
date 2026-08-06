# Smooth Shadow System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `shadow-sm`, `shadow-md`, and `shadow-lg` render the Smooth Shadow Plugin's matching shadow-ring stacks across `apps/web`, then remove duplicate decorative edges from all affected frontend surfaces.

**Architecture:** `apps/web/src/app/globals.css` imports `shadow-plugin@2.1.0` and owns the three public aliases. Shared primitives own repeated elevation behavior, feature code uses those primitives or the three aliases, and explicit `smooth-shadow-*` utilities handle structural, semantic, and media exceptions. Compile-contract tests guard the CSS adapter, a source-policy test prevents decorative border/ring regressions, and headless Playwright verifies light and dark themes.

**Tech Stack:** Next.js 16.3.0, React 19.2.0, Tailwind CSS 4.3.2, PostCSS 8.5.16, `shadow-plugin` 2.1.0, Bun test, ESLint 9, Playwright 1.57.0, Linear.

## Global Constraints

- Limit code changes to `apps/web`, workspace dependency metadata, focused tests, design-system documentation, and the shadow audit report.
- Pin `shadow-plugin` to exact version `2.1.0` in `apps/web/package.json` and `pnpm-lock.yaml`.
- Keep `shadow-sm`, `shadow-md`, and `shadow-lg` as the standard Kortix elevation API.
- Map each standard class to the matching `smooth-shadow-ring-*` size plus `smooth-ring-neutral-300/30`.
- Keep shadow and smooth-ring colors independently customizable.
- Do not copy plugin formulas into component files or Kortix-owned CSS.
- Do not map Tailwind `--shadow-*` variables to `--smooth-shadow-*` variables.
- Use `smooth-shadow-*` for ringless structural or media shadows.
- Preserve directional structural borders, semantic state indicators, and keyboard focus indicators.
- Remove full borders and `ring-1` only when they duplicate the standard smooth ring.
- Keep in-flow panels flat unless elevation communicates an actual stacking change.
- Preserve `drop-shadow-*`; it follows image alpha and is outside this migration.
- Do not add a custom `tailwind-merge` configuration. Never stack a native shadow size with an explicit plugin shadow size.
- Do not open a visible browser. Run all Playwright checks headlessly.
- Keep commits scoped. Use `feat(web):`, `fix(web):`, `test(web):`, or `chore(web):` commit subjects.
- Work on branch `shadow-plugin` in `/Users/jay/root/kortix/suna-shadow-plugin`.
- The approved design is `docs/superpowers/specs/2026-08-06-smooth-shadow-system-design.md`.

---

## File Map

### Foundation and contracts

- Modify `apps/web/package.json`: declare the exact plugin dependency.
- Modify `pnpm-lock.yaml`: lock `shadow-plugin@2.1.0` and its peer resolution.
- Modify `apps/web/src/app/globals.css`: import the plugin and define the three public aliases.
- Create `apps/web/src/app/shadow-system.test.ts`: compile the real global stylesheet and assert the public CSS contract.
- Create `apps/web/src/lib/utils.test.ts`: assert native shadow merging and document the explicit-utility boundary.
- Create `apps/web/src/lib/shadow-edge-contract.test.ts`: reject standard aliases paired with decorative full borders or rings.
- Create `docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md`: record the complete source inventory and each migration decision.

### Shared elevation owners

- Modify `apps/web/src/components/ui/alert-dialog.tsx`.
- Modify `apps/web/src/components/ui/command.tsx`.
- Modify `apps/web/src/components/ui/date-range-picker.tsx`.
- Modify `apps/web/src/components/ui/dialog.tsx`.
- Modify `apps/web/src/components/ui/hover-card.tsx`.
- Modify `apps/web/src/components/ui/menu-recipe.ts`.
- Modify `apps/web/src/components/ui/modal.tsx`.
- Modify `apps/web/src/components/ui/preview-image.tsx`.
- Modify `apps/web/src/components/ui/sheet.tsx`.
- Modify `apps/web/src/components/ui/sidebar.tsx`.
- Modify `apps/web/src/components/ui/switch.tsx`.
- Modify `apps/web/src/components/ui/tabs.tsx`.
- Modify `apps/web/src/components/ui/toast.tsx`.

### Product, public, media, and marketing surfaces

- Modify the runtime files listed in Tasks 5 and 6.
- Update comments only in `apps/web/src/components/markdown/docs-mdx-components.tsx`, `apps/web/src/features/marketing/download/card-images.tsx`, and `apps/web/src/features/session/action-panel/easy/panel-card.tsx` when they describe the old border-plus-shadow rule.
- Leave `apps/web/src/features/session/tool/tools/get-mem-tool.test.tsx` and `apps/web/src/features/session/tool/tools/memory-search-tool.test.tsx` unchanged. Their negative assertions remain valid.

### Documentation and black-box verification

- Modify `apps/web/src/app/(public)/(marketing)/design-system/page.tsx`: show the three-step standard ladder, the explicit escape hatch, and stable QA locators.
- Modify `.claude/skills/kortix-design-system/SKILL.md`: replace the stale seven-step ladder and border-plus-shadow rule.
- Create `tests/visual/shadows.visual.spec.ts`: assert computed shadows and capture light/dark desktop and narrow screenshots.
- Create four baselines under `tests/visual/__screenshots__/shadows.visual.spec.ts/` on the current Darwin Playwright environment.
- Re-verify `tests/visual/landing.visual.spec.ts` and review its two existing Darwin baselines because the public marketing shadows change intentionally.

---

### Task 1: Create the Linear project and execution graph

**Files:**

- Read: `docs/superpowers/specs/2026-08-06-smooth-shadow-system-design.md`
- Read: `docs/superpowers/plans/2026-08-06-smooth-shadow-system.md`
- External create: Linear project `Smooth Shadow System — Web` in team `Jay`
- External create: Linear documents, milestones, issues, and dependency links

**Interfaces:**

- Consumes: the approved specification and this complete implementation plan.
- Produces: one Linear project with two source documents, three milestones, seven executable issues, and explicit blocker links.

- [ ] **Step 1: Load the Linear setup workflow**

Read `/Users/jay/.agents/skills/linear-setup/SKILL.md` completely. Follow its authentication probe, duplicate search, project creation, and issue creation rules. `linear-sync` routes a new project to `linear-setup`; do not use the sync workflow as a bootstrap substitute.

- [ ] **Step 2: Probe Linear authentication and resolve the Jay team**

Run the setup skill's cheapest read-only Linear probe. Confirm the returned team identifier has the exact display name `Jay`. Stop before writes if the probe fails or the team does not exist.

- [ ] **Step 3: Search before project creation**

Search the Jay team for these exact terms:

```text
Smooth Shadow System — Web
Smooth Shadow System
shadow-plugin
smooth shadow
```

If an existing active project matches the same `apps/web` scope, show its name, URL, state, and issue count before any write. Otherwise create `Smooth Shadow System — Web` with this summary:

```text
Adopt shadow-plugin@2.1.0 across apps/web. Keep shadow-sm, shadow-md, and shadow-lg as the standard API. Remove duplicate decorative edges. Verify light and dark themes locally and on dev.
```

- [ ] **Step 4: Create the project milestones**

Create these milestones in order:

1. `Foundation` — dependency, compile contract, global aliases, and source policy.
2. `Component migration` — shared primitives plus product, public, media, and marketing surfaces.
3. `Documentation and release` — design-system docs, headless visual QA, merge, deploy, and dev verification.

- [ ] **Step 5: Publish the source documents**

Create these project documents. Copy each local Markdown file verbatim, including code blocks and acceptance criteria.

1. `Smooth Shadow System — Specification` from `docs/superpowers/specs/2026-08-06-smooth-shadow-system-design.md`.
2. `Smooth Shadow System — Implementation Plan` from `docs/superpowers/plans/2026-08-06-smooth-shadow-system.md`.

- [ ] **Step 6: Create the implementation issues**

Search by exact title before each create. Create only missing issues.

| Issue title                                               | Milestone                 | Plan task  | Blocked by                                                                                                     |
| --------------------------------------------------------- | ------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `[Shadow] Install plugin and lock the global adapter`     | Foundation                | Task 2     | —                                                                                                              |
| `[Shadow] Add shadow merge and edge policy contracts`     | Foundation                | Task 3     | Install plugin and lock the global adapter                                                                     |
| `[Shadow] Migrate shared elevation primitives`            | Component migration       | Task 4     | Add shadow merge and edge policy contracts                                                                     |
| `[Shadow] Migrate product and media surfaces`             | Component migration       | Task 5     | Add shadow merge and edge policy contracts                                                                     |
| `[Shadow] Migrate public and marketing surfaces`          | Component migration       | Task 6     | Add shadow merge and edge policy contracts                                                                     |
| `[Shadow] Document and visually verify the shadow system` | Documentation and release | Tasks 7–8  | Migrate shared elevation primitives; Migrate product and media surfaces; Migrate public and marketing surfaces |
| `[Shadow] Merge, deploy, and verify dev`                  | Documentation and release | Tasks 9–10 | Document and visually verify the shadow system                                                                 |

Each issue description must include its exact files, checkbox steps, commands, expected results, and acceptance criteria copied from the corresponding plan task.

- [ ] **Step 7: Verify the Linear graph**

Re-read the project. Confirm:

- two documents exist;
- three milestones exist;
- seven issues exist;
- all blocker links match the table;
- no issue is `Done` before its code, review, deploy, and verification evidence exist.

Record the project URL and all issue identifiers in the local audit report created in Task 3.

---

### Task 2: Install the plugin and lock the global CSS adapter

**Files:**

- Create: `apps/web/src/app/shadow-system.test.ts`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/src/app/globals.css:1-6`

**Interfaces:**

- Consumes: Tailwind CSS `4.3.2`, PostCSS `8.5.16`, and the plugin's prefixed entry point.
- Produces: `.shadow-sm`, `.shadow-md`, and `.shadow-lg` with the matching plugin stacks and `smooth-ring-neutral-300/30`.

- [ ] **Step 1: Move the foundation issue to In Progress**

Set `[Shadow] Install plugin and lock the global adapter` to `In Progress`. Add a comment with branch `shadow-plugin` and worktree `/Users/jay/root/kortix/suna-shadow-plugin`.

- [ ] **Step 2: Write the failing compile-contract test**

Create `apps/web/src/app/shadow-system.test.ts` with this content:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import tailwindcss from "@tailwindcss/postcss";
import postcss, { type Rule } from "postcss";
import { describe, expect, test } from "bun:test";

const WEB_ROOT = join(import.meta.dir, "../..");
const PACKAGE_JSON = join(WEB_ROOT, "package.json");

const fixture = `
@import './globals.css';
@source inline("shadow-sm shadow-md shadow-lg shadow-none shadow-black/20 smooth-ring-neutral-400/40 sm:shadow-sm hover:shadow-md group-hover:shadow-md data-[state=open]:shadow-lg");

@utility test-independent-shadow-colors {
  @apply shadow-sm shadow-black/20 smooth-ring-neutral-400/40;
}
`;

async function compileFixture(): Promise<string> {
  const result = await postcss([tailwindcss()]).process(fixture, {
    from: join(import.meta.dir, "shadow-system.fixture.css"),
  });
  return result.css;
}

function lastRule(css: string, selector: string): string {
  let found: Rule | undefined;
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector === selector) found = rule;
  });
  if (!found) throw new Error(`Missing compiled selector: ${selector}`);
  return found.toString();
}

describe("Kortix smooth shadow system", () => {
  test("pins shadow-plugin to the reviewed release", () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies["shadow-plugin"]).toBe("2.1.0");
  });

  test("compiles the three native aliases to matching smooth ring stacks", async () => {
    const css = await compileFixture();
    const sm = lastRule(css, ".shadow-sm");
    const md = lastRule(css, ".shadow-md");
    const lg = lastRule(css, ".shadow-lg");

    expect(sm).toContain("0 18px 47px");
    expect(md).toContain("0 17.54px 23.39px");
    expect(lg).toContain("0 25px 50px");

    for (const rule of [sm, md, lg]) {
      expect(rule).toContain("var(--smooth-ring-color)");
      expect(rule).toContain("0 0 0 1px");
      expect(rule).toContain("--smooth-ring-color:");
    }
  });

  test("keeps shadow and ring colors independent", async () => {
    const css = await compileFixture();
    const rule = lastRule(css, ".test-independent-shadow-colors");

    expect(rule).toContain("--tw-shadow-color:");
    expect(rule).toContain("--smooth-ring-color:");
    expect(rule).toContain("var(--smooth-ring-color)");
  });

  test("emits native variants and shadow-none", async () => {
    const css = await compileFixture();

    expect(css).toContain(".hover\\:shadow-md");
    expect(css).toContain(".sm\\:shadow-sm");
    expect(css).toContain(".group-hover\\:shadow-md");
    expect(css).toContain(".data-\\[state\\=open\\]\\:shadow-lg");
    expect(lastRule(css, ".shadow-none")).toContain("box-shadow: none");
  });
});
```

- [ ] **Step 3: Run the contract test and verify the red state**

Run:

```bash
pnpm --filter Kortix-Computer-Frontend exec bun test src/app/shadow-system.test.ts
```

Expected: FAIL because `dependencies['shadow-plugin']` is undefined and `globals.css` does not import the plugin.

- [ ] **Step 4: Install the exact dependency**

Run:

```bash
pnpm --filter Kortix-Computer-Frontend add --save-exact shadow-plugin@2.1.0
```

Expected: `apps/web/package.json` contains `"shadow-plugin": "2.1.0"`. `pnpm-lock.yaml` resolves version `2.1.0`.

- [ ] **Step 5: Add the global adapter**

Insert the plugin import immediately after Tailwind. Place the aliases after all imports and plugin directives in `apps/web/src/app/globals.css`:

```css
@import "tailwindcss";
@import "shadow-plugin";
@import "fumadocs-ui/css/neutral.css";
@import "fumadocs-ui/css/preset.css";
@import "tw-animate-css";
@plugin 'tailwind-scrollbar';
@plugin 'tailwind-scrollbar-hide';

@utility shadow-sm {
  @apply smooth-shadow-ring-sm smooth-ring-neutral-300/30;
}

@utility shadow-md {
  @apply smooth-shadow-ring-md smooth-ring-neutral-300/30;
}

@utility shadow-lg {
  @apply smooth-shadow-ring-lg smooth-ring-neutral-300/30;
}
```

Do not add `@import 'shadow-plugin/unprefixed'`. The prefixed import keeps explicit utilities available and lets Kortix own only the three aliases.

- [ ] **Step 6: Run the contract test and verify the green state**

Run:

```bash
pnpm --filter Kortix-Computer-Frontend exec bun test src/app/shadow-system.test.ts
```

Expected: `4 pass`, `0 fail`.

- [ ] **Step 7: Commit the foundation**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/app/globals.css apps/web/src/app/shadow-system.test.ts
git commit -m "feat(web): add smooth shadow adapter"
```

Add the commit SHA and test output to the Linear issue. Keep the issue `In Progress` until Task 3 proves the policy contract.

---

### Task 3: Add merge behavior, source policy, and the audit report

**Files:**

- Create: `apps/web/src/lib/utils.test.ts`
- Create: `apps/web/src/lib/shadow-edge-contract.test.ts`
- Create: `docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md`

**Interfaces:**

- Consumes: the aliases from Task 2 and `cn(...inputs: ClassValue[]): string` from `apps/web/src/lib/utils.ts`.
- Produces: a zero-violation source rule for decorative edges and a complete review record for all `apps/web/src` shadow usage.

- [ ] **Step 1: Move the policy issue to In Progress**

Set `[Shadow] Add shadow merge and edge policy contracts` to `In Progress`.

- [ ] **Step 2: Write the class-merging contract**

Create `apps/web/src/lib/utils.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { cn } from "./utils";

describe("cn shadow composition", () => {
  test("keeps the last native shadow size", () => {
    expect(cn("shadow-sm", "shadow-md", "shadow-lg")).toBe("shadow-lg");
  });

  test("lets shadow-none remove a native elevation class", () => {
    expect(cn("shadow-lg", "shadow-none")).toBe("shadow-none");
  });

  test("preserves independent shadow and smooth-ring colors", () => {
    expect(
      cn("shadow-md", "shadow-black/20", "smooth-ring-neutral-400/40"),
    ).toBe("shadow-md shadow-black/20 smooth-ring-neutral-400/40");
  });

  test("does not pretend native and explicit plugin sizes conflict", () => {
    expect(cn("shadow-md", "smooth-shadow-ring-xl")).toBe(
      "shadow-md smooth-shadow-ring-xl",
    );
  });
});
```

The fourth assertion documents why component code must replace the native size instead of stacking both sizes.

- [ ] **Step 3: Run the merge test**

Run:

```bash
pnpm --filter Kortix-Computer-Frontend exec bun test src/lib/utils.test.ts
```

Expected: `4 pass`, `0 fail`. If `tailwind-merge` changes the exact independent-color ordering, assert the verified output and keep all three classes present.

- [ ] **Step 4: Write the failing source-policy test**

Create `apps/web/src/lib/shadow-edge-contract.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { expect, test } from "bun:test";
import ts from "typescript";

const SOURCE_ROOT = join(import.meta.dir, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name))
      return [];
    return [path];
  });
}

function baseUtility(token: string): string {
  return token.slice(token.lastIndexOf(":") + 1).replace(/^!/, "");
}

test("standard smooth shadow aliases do not carry a duplicate decorative edge", () => {
  const violations: string[] = [];

  for (const file of sourceFiles(SOURCE_ROOT)) {
    const sourceText = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        const utilities = node.text.split(/\s+/).map(baseUtility);
        const hasStandardShadow = utilities.some((value) =>
          /^shadow-(sm|md|lg)$/.test(value),
        );
        const hasDecorativeEdge = utilities.some(
          (value) =>
            value === "border" || value === "ring-1" || value === "ring-[1px]",
        );

        if (hasStandardShadow && hasDecorativeEdge) {
          const line =
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(
            `${relative(SOURCE_ROOT, file)}:${line} ${node.text.trim()}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  expect(violations).toEqual([]);
});
```

- [ ] **Step 5: Run the source-policy test and verify the red state**

Run:

```bash
pnpm --filter Kortix-Computer-Frontend exec bun test src/lib/shadow-edge-contract.test.ts
```

Expected: FAIL. The output includes current double-edge sites such as `components/ui/dialog.tsx`, `components/ui/toast.tsx`, `features/file-viewer/file-preview-modal.tsx`, and `features/marketing/hero-surfaces.tsx`.

- [ ] **Step 6: Create the complete audit report**

Create `docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md` with these fixed sections:

```markdown
# Smooth shadow source audit

**Date:** 2026-08-06
**Scope:** `apps/web/src`
**Inventory command:** `rg -n --glob '*.{ts,tsx,css}' 'shadow(-|\[|\b)|box-shadow|boxShadow' apps/web/src`

## Policy

- Standard elevated surface: `shadow-sm`, `shadow-md`, or `shadow-lg`; no decorative full border or `ring-1`.
- Structural edge: directional border plus explicit ringless `smooth-shadow-*`.
- Semantic state: explicit smooth color or CSS outline; never sacrifice focus or status.
- In-flow surface: flat unless elevation communicates stacking.
- Media: preserve `drop-shadow-*`; use ringless smooth depth for opaque media.

## Inventory summary

Record the total matching files, total matching lines, native `shadow-sm|md|lg` files, and native `shadow-sm|md|lg` lines from the commands below.

## Standard alias migration

Record every runtime file from the migration tables in Tasks 4–6 with its category, old class fragment, new class fragment, and reason.

## Explicit utilities retained

Record every remaining `shadow-xs`, `shadow-xl`, `shadow-2xl`, arbitrary `shadow-[…]`, `drop-shadow-*`, and `boxShadow` use by file. Classify it as structural, semantic, media, third-party normalization, or independently reviewed existing behavior.

## Verification evidence

Record focused tests, lint, typecheck, build, local Playwright, PR, merge SHA, Deploy Dev run, deployed version, and dev Playwright results.

## Linear

Record the Linear project URL and all seven issue identifiers.
```

Populate the report now. Do not leave template instructions in the committed report.

- [ ] **Step 7: Capture the source inventory**

Run:

```bash
rg -n --glob '*.{ts,tsx,css}' 'shadow(-|\[|\b)|box-shadow|boxShadow' apps/web/src
rg --pcre2 -n --glob '*.{ts,tsx,css}' '(?<!drop-)shadow-(sm|md|lg)\b' apps/web/src
```

Record exact counts and classifications in the audit report. Do not change a component until its row has a category and target class fragment.

- [ ] **Step 8: Commit the contracts and audit baseline**

```bash
git add apps/web/src/lib/utils.test.ts apps/web/src/lib/shadow-edge-contract.test.ts docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md
git commit -m "test(web): define smooth shadow policy"
```

Expected: `utils.test.ts` passes. `shadow-edge-contract.test.ts` remains intentionally red until Tasks 4–6 remove the known violations. Add both results to Linear.

---

### Task 4: Migrate shared elevation primitives

**Files:**

- Modify: `apps/web/src/components/ui/alert-dialog.tsx:72`
- Modify: `apps/web/src/components/ui/command.tsx:209`
- Modify: `apps/web/src/components/ui/date-range-picker.tsx:271`
- Modify: `apps/web/src/components/ui/dialog.tsx:63`
- Modify: `apps/web/src/components/ui/hover-card.tsx:35`
- Modify: `apps/web/src/components/ui/menu-recipe.ts:67-102`
- Modify: `apps/web/src/components/ui/modal.tsx:124-147`
- Modify: `apps/web/src/components/ui/preview-image.tsx:120`
- Modify: `apps/web/src/components/ui/sheet.tsx:64-78`
- Modify: `apps/web/src/components/ui/sidebar.tsx:339-438`
- Modify: `apps/web/src/components/ui/switch.tsx:167`
- Modify: `apps/web/src/components/ui/tabs.tsx:411`
- Modify: `apps/web/src/components/ui/toast.tsx:84-275`
- Update: `docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md`

**Interfaces:**

- Consumes: standard aliases, explicit ringless utilities, and the source-policy test from Tasks 2–3.
- Produces: one consistent elevation owner for dialogs, menus, popovers, sheets, sidebars, tabs, switches, and toasts.

- [ ] **Step 1: Move the shared-primitives issue to In Progress**

Set `[Shadow] Migrate shared elevation primitives` to `In Progress`.

- [ ] **Step 2: Apply the shared primitive migration table**

Make these exact class decisions:

| File                    | Replace                                                    | With                                                                                                                                                                                | Reason                                                                                              |
| ----------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `alert-dialog.tsx`      | `border-muted/60 ... border ... shadow-lg`                 | remove `border-muted/60` and `border`; keep `shadow-lg`                                                                                                                             | Standard modal ring owns the edge.                                                                  |
| `command.tsx`           | `rounded-md border p-3 shadow-md`                          | `rounded-md p-3 shadow-md`                                                                                                                                                          | Hover-card override needs depth, not a second edge.                                                 |
| `date-range-picker.tsx` | caller `shadow-md`                                         | remove caller `shadow-md`                                                                                                                                                           | `PopoverContent` owns `FLOATING_PANEL`.                                                             |
| `dialog.tsx`            | `... border p-5 shadow-lg`                                 | `... p-5 shadow-lg`                                                                                                                                                                 | Standard dialog ring owns the edge.                                                                 |
| `hover-card.tsx`        | `rounded-md border ... shadow-sm`                          | remove `border`; keep `shadow-sm`                                                                                                                                                   | Standard hover-card ring owns the edge.                                                             |
| `menu-recipe.ts`        | `border-border ... border shadow-md`                       | remove both border utilities; keep `shadow-md`                                                                                                                                      | One shared menu recipe owns all menu edges.                                                         |
| `modal.tsx`             | base `border ... shadow-lg`                                | base `smooth-shadow-lg`; keep directional `border-b`, `border-t`, `border-r`, and `border-l` side seams                                                                             | Side-aware modal seams are structural, so the shadow is ringless.                                   |
| `preview-image.tsx`     | full-screen root `shadow-lg`                               | remove `shadow-lg`                                                                                                                                                                  | A full-screen root does not float over itself.                                                      |
| `sheet.tsx`             | base `shadow-lg`                                           | base `smooth-shadow-lg`; keep directional side borders                                                                                                                              | Sheet seams are structural.                                                                         |
| `sidebar.tsx` floating  | `... border ... shadow-sm`                                 | remove the full border; keep `shadow-sm`                                                                                                                                            | The baked ring owns the detached sidebar edge.                                                      |
| `sidebar.tsx` peekable  | `border-border ... border shadow-xl`                       | `smooth-shadow-ring-xl smooth-ring-neutral-300/30`                                                                                                                                  | Explicit non-standard elevated size.                                                                |
| `sidebar.tsx` inset     | responsive `shadow-sm`                                     | remove the shadow                                                                                                                                                                   | Inset page content is in-flow.                                                                      |
| `switch.tsx`            | thumb `shadow-sm`                                          | thumb `smooth-shadow-sm`                                                                                                                                                            | The small thumb needs ringless depth inside its track.                                              |
| `tabs.tsx`              | active `shadow-sm ring-1 ring-foreground/6`                | active `shadow-sm`                                                                                                                                                                  | The baked ring replaces the decorative ring.                                                        |
| `toast.tsx`             | six copies of `border-primary/10 ... border ... shadow-lg` | shared `TOAST_SURFACE = 'bg-background text-foreground w-full rounded-[0.64rem] px-4 py-3 shadow-lg sm:w-[var(--width)]'` plus `data-slot="toast-surface"` on each rendered surface | Standard toast ring owns the edge, the constant prevents drift, and the slot supports black-box QA. |

Update `menu-recipe.ts` comments to say that the standard alias already includes its hairline ring. Remove any instruction to pair a standard shadow with a decorative border.

- [ ] **Step 3: Run shared component tests and the still-red policy test**

Run:

```bash
pnpm --filter Kortix-Computer-Frontend exec bun test \
  src/components/ui \
  src/lib/shadow-edge-contract.test.ts
```

Expected: shared component tests pass. The policy test can still fail only for product or public files assigned to Tasks 5–6. No shared primitive may remain in its violation list.

- [ ] **Step 4: Run focused lint**

Run:

```bash
pnpm --dir apps/web exec eslint \
  src/components/ui/alert-dialog.tsx \
  src/components/ui/command.tsx \
  src/components/ui/date-range-picker.tsx \
  src/components/ui/dialog.tsx \
  src/components/ui/hover-card.tsx \
  src/components/ui/menu-recipe.ts \
  src/components/ui/modal.tsx \
  src/components/ui/preview-image.tsx \
  src/components/ui/sheet.tsx \
  src/components/ui/sidebar.tsx \
  src/components/ui/switch.tsx \
  src/components/ui/tabs.tsx \
  src/components/ui/toast.tsx
```

Expected: `0 errors`.

- [ ] **Step 5: Update the audit and commit**

Record every changed shared primitive and its final class fragment in the audit report.

```bash
git add apps/web/src/components/ui docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md
git commit -m "feat(web): migrate shared shadow primitives"
```

Add the commit SHA and focused test output to the Linear issue.

---

### Task 5: Migrate product and media surfaces

**Files:**

- Modify: `apps/web/src/app/presentation/deck.tsx:200`
- Modify: `apps/web/src/components/announcements/maintenance-banner.tsx:25-60,178`
- Modify: `apps/web/src/components/dashboard/connecting-screen.tsx:605,636`
- Modify: `apps/web/src/components/home/interactive-demo/cli/draggable-cli-panel.tsx:181`
- Modify: `apps/web/src/components/instances/instance-members-panel.tsx:543,664`
- Modify: `apps/web/src/components/projects/personal-onboarding-welcome.tsx:77`
- Modify: `apps/web/src/features/file-renderers/docx/docx-annotation-card.tsx:84`
- Modify: `apps/web/src/features/file-renderers/docx/docx-viewer.tsx:670`
- Modify: `apps/web/src/features/file-renderers/image-renderer.tsx:371,551`
- Modify: `apps/web/src/features/file-renderers/shared/document-viewer-sidebar.tsx:82`
- Modify: `apps/web/src/features/file-renderers/sqlite-renderer.tsx:937`
- Modify: `apps/web/src/features/file-renderers/video-renderer.tsx:265`
- Modify: `apps/web/src/features/file-viewer/file-preview-modal.tsx:392,406`
- Modify: `apps/web/src/features/marketplace/marketplace-detail.tsx:441`
- Modify: `apps/web/src/features/review-center/review-center.tsx:1074`
- Modify: `apps/web/src/features/session/scope/session-scope-control.tsx:466`
- Modify: `apps/web/src/features/workspace/customize/migrate-to-v2/upgrade-view.tsx:85`
- Modify: `apps/web/src/features/workspace/project-sidebar/project-switcher.tsx:261`
- Update: `docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md`

**Interfaces:**

- Consumes: shared primitive ownership from Task 4 and the explicit utility rules from the approved design.
- Produces: product and file-viewer surfaces with one visible edge and preserved semantic or structural states.

- [ ] **Step 1: Move the product issue to In Progress**

Set `[Shadow] Migrate product and media surfaces` to `In Progress`.

- [ ] **Step 2: Apply the product migration table**

| File                                    | Final decision                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presentation/deck.tsx`                 | Remove the toolbar's full `border`; keep `shadow-sm`.                                                                                                                                                                                         |
| `maintenance-banner.tsx`                | Rename `levelConfig.border` to `levelConfig.ring`. Replace each `border-kortix-*/25` value with `smooth-ring-kortix-*/25`. Remove the full border from the card and keep `shadow-lg`; the semantic tint now overrides the baked neutral ring. |
| `connecting-screen.tsx`                 | Remove `border` and `border-border/50` from both detached status pills. Keep `shadow-lg shadow-black/5`.                                                                                                                                      |
| `draggable-cli-panel.tsx`               | Keep resting `shadow-md`. Replace dragging `shadow-2xl ring-1 ring-border/40` with `smooth-shadow-ring-2xl smooth-ring-border/40`. Never leave `shadow-md` and the explicit 2xl size active together.                                         |
| `instance-members-panel.tsx` avatar     | Replace `ring-background shadow-sm ring-4` with `smooth-shadow-sm outline-4 outline-background`. The outline preserves the avatar separator without competing for `box-shadow`.                                                               |
| `instance-members-panel.tsx` role cards | Remove selected `shadow-sm`; keep substrate and border state. Role cards are in-flow selection controls.                                                                                                                                      |
| `personal-onboarding-welcome.tsx`       | Replace `shadow-sm` with `smooth-shadow-sm`; the fixed sidebar uses a viewport seam, not a surrounding elevated ring.                                                                                                                         |
| `docx-annotation-card.tsx`              | Keep `shadow-sm`; it is a detached annotation card and has no duplicate full border.                                                                                                                                                          |
| `docx-viewer.tsx`                       | Keep the active thumbnail's `shadow-sm`; its `border-0 ring-0` base leaves the smooth ring as the only edge.                                                                                                                                  |
| `image-renderer.tsx` controls           | Remove the `ButtonGroup` full border; keep `shadow-sm`.                                                                                                                                                                                       |
| `image-renderer.tsx` media              | Replace opaque image `shadow-md` with `smooth-shadow-md`; media depth is ringless. Preserve the SVG exclusion.                                                                                                                                |
| `document-viewer-sidebar.tsx`           | Replace overlay `shadow-lg` with `smooth-shadow-lg`; preserve `border-r`. Keep inline `shadow-none`.                                                                                                                                          |
| `sqlite-renderer.tsx`                   | Keep active segmented-control `shadow-sm`; it communicates the raised selected state.                                                                                                                                                         |
| `video-renderer.tsx`                    | Keep the detached play control's `shadow-lg`; it has no duplicate border.                                                                                                                                                                     |
| `file-preview-modal.tsx`                | Remove both arrow-button full borders and border colors; keep `shadow-sm`.                                                                                                                                                                    |
| `marketplace-detail.tsx`                | Remove the fixed toolbar's full border; keep `shadow-lg`.                                                                                                                                                                                     |
| `review-center.tsx`                     | Remove the fixed toolbar's full border; keep `shadow-lg`.                                                                                                                                                                                     |
| `session-scope-control.tsx`             | Remove caller `shadow-md`; `PopoverContent` owns the shared floating panel.                                                                                                                                                                   |
| `upgrade-view.tsx`                      | Replace the tinted border classes with `smooth-ring-kortix-base/30 hover:smooth-ring-kortix-base/45`; keep `shadow-md shadow-kortix-base/20`.                                                                                                 |
| `project-switcher.tsx`                  | Remove the sidebar-only caller `shadow-md`; `DropdownMenuContent` owns the shared menu shadow in all variants.                                                                                                                                |

- [ ] **Step 3: Run the affected product tests**

Run:

```bash
pnpm --filter Kortix-Computer-Frontend exec bun test \
  src/components/instances \
  src/features/file-renderers \
  src/features/file-viewer \
  src/features/session/scope \
  src/features/workspace/project-sidebar \
  src/lib/shadow-edge-contract.test.ts
```

Expected: affected tests pass. Any remaining source-policy failures belong only to Task 6.

- [ ] **Step 4: Run focused lint**

From the repository root, run ESLint on the 18 modified `.tsx` files listed in this task:

```bash
git diff --name-only HEAD -- apps/web/src \
  | sed 's#^apps/web/##' \
  | (cd apps/web && xargs pnpm exec eslint)
```

Expected: `0 errors`.

- [ ] **Step 5: Update the audit and commit**

```bash
git add apps/web/src/app/presentation apps/web/src/components apps/web/src/features docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md
git commit -m "feat(web): migrate product shadow surfaces"
```

Inspect `git diff --cached --stat` before committing. Unstage any public or marketing files assigned to Task 6. Add the commit SHA and test output to Linear.

---

### Task 6: Migrate public, voice, and marketing surfaces

**Files:**

- Modify: `apps/web/src/app/(public)/voice/[token]/_components/connection-states.tsx:85`
- Modify: `apps/web/src/app/(public)/voice/[token]/_components/presence-rail.tsx:36`
- Modify: `apps/web/src/components/use-cases/covers.tsx:84,168,183,186`
- Modify: `apps/web/src/features/marketing/hero-surfaces.tsx:325,489`
- Modify: `apps/web/src/features/marketing/landing/scroll-cta-pill.tsx:99`
- Review comment: `apps/web/src/components/markdown/docs-mdx-components.tsx:38,140`
- Review comment: `apps/web/src/features/marketing/download/card-images.tsx:62`
- Review comment: `apps/web/src/features/session/action-panel/easy/panel-card.tsx:146`
- Update: `docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md`

**Interfaces:**

- Consumes: standard aliases and explicit semantic/media utilities.
- Produces: public and marketing surfaces that use smooth depth without changing brand color, layout, radius, or motion.

- [ ] **Step 1: Move the public-surfaces issue to In Progress**

Set `[Shadow] Migrate public and marketing surfaces` to `In Progress`.

- [ ] **Step 2: Apply the public migration table**

| File                      | Final decision                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connection-states.tsx`   | Remove `border-border` and the full `border` from `AudioGestureOverlay`; keep `shadow-lg`.                                                                                                                                                             |
| `presence-rail.tsx`       | Replace speaking `ring-2 ring-kortix-green shadow-md shadow-kortix-green/20` with `smooth-shadow-md shadow-kortix-green/20 outline-2 outline-offset-2 outline-kortix-green`. The outline preserves the speaking state independently from `box-shadow`. |
| `covers.tsx` shared tile  | Replace `shadow-md ring-1 ring-black/5 dark:ring-white/10` with `smooth-shadow-ring-md smooth-ring-black/5 dark:smooth-ring-white/10`; keep `shadow-black/10`.                                                                                         |
| `covers.tsx` large tiles  | Replace each `shadow-lg ring-1 ring-black/5 dark:ring-white/10` with `smooth-shadow-ring-lg smooth-ring-black/5 dark:smooth-ring-white/10`; keep `shadow-black/10`.                                                                                    |
| `covers.tsx` avatar badge | Replace `shadow-md ring-[3px] ring-white` with `smooth-shadow-md outline-[3px] outline-white`.                                                                                                                                                         |
| `hero-surfaces.tsx`       | Remove the full border and border color from the elevated hero frame and top-right chip. Keep `shadow-md` and `shadow-sm`.                                                                                                                             |
| `scroll-cta-pill.tsx`     | Remove the full border; keep `shadow-sm`.                                                                                                                                                                                                              |
| three comment-only files  | Replace stale border-plus-shadow guidance with the three-alias contract. Do not add runtime shadows to flat docs or panel surfaces.                                                                                                                    |

- [ ] **Step 3: Run public tests and close the source policy**

Run:

```bash
pnpm --filter Kortix-Computer-Frontend exec bun test \
  'src/app/(public)/voice' \
  src/components/use-cases \
  src/features/marketing \
  src/lib/shadow-edge-contract.test.ts
```

Expected: all selected tests pass. `shadow-edge-contract.test.ts` reports `1 pass`, `0 fail`, with an empty violation array.

- [ ] **Step 4: Re-run the complete inventory and finish the audit classifications**

Run:

```bash
rg -n --glob '*.{ts,tsx,css}' 'shadow(-|\[|\b)|box-shadow|boxShadow' apps/web/src
rg --pcre2 -n --glob '*.{ts,tsx,css}' '(?<!drop-)shadow-(sm|md|lg)\b' apps/web/src
```

For every remaining non-standard shadow, add one final classification to the report. Confirm no runtime string pairs a standard alias with `border`, `ring-1`, or `ring-[1px]`.

- [ ] **Step 5: Run focused lint and commit**

```bash
pnpm --dir apps/web exec eslint \
  'src/app/(public)/voice/[token]/_components/connection-states.tsx' \
  'src/app/(public)/voice/[token]/_components/presence-rail.tsx' \
  src/components/use-cases/covers.tsx \
  src/components/markdown/docs-mdx-components.tsx \
  src/features/marketing/hero-surfaces.tsx \
  src/features/marketing/landing/scroll-cta-pill.tsx \
  src/features/marketing/download/card-images.tsx \
  src/features/session/action-panel/easy/panel-card.tsx

git add 'apps/web/src/app/(public)' apps/web/src/components apps/web/src/features docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md
git commit -m "feat(web): migrate public shadow surfaces"
```

Expected: ESLint reports `0 errors`. Add the commit SHA and source-policy output to Linear.

---

### Task 7: Update the living design system and agent guidance

**Files:**

- Modify: `apps/web/src/app/(public)/(marketing)/design-system/page.tsx:506-552,696,733,820,1720-1765,2430-2640`
- Modify: `.claude/skills/kortix-design-system/SKILL.md:353-372`
- Update: `docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md`

**Interfaces:**

- Consumes: the production aliases and migrated shared primitives.
- Produces: a discoverable three-step elevation reference plus stable `data-testid` hooks for headless QA.

- [ ] **Step 1: Move the documentation issue to In Progress**

Set `[Shadow] Document and visually verify the shadow system` to `In Progress`.

- [ ] **Step 2: Replace the stale seven-step scale**

Replace `SHADOW_SCALE` with:

```ts
const SHADOW_SCALE = [
  {
    label: "shadow-sm",
    twClass: "shadow-sm",
    use: "Compact floating controls and raised active states",
  },
  {
    label: "shadow-md",
    twClass: "shadow-md",
    use: "Popovers, menus, dropdowns, and compact floating panels",
  },
  {
    label: "shadow-lg",
    twClass: "shadow-lg",
    use: "Modals, sheets, toasts, and substantial overlays",
  },
] as const;
```

Remove the unused `cssVar` type and inline `style`. The plugin owns formulas, so the page must not claim Kortix `--shadow-*` variables exist.

- [ ] **Step 3: Rewrite the Shadows section**

The section must state these rules in visible copy:

```text
Use shadow-sm, shadow-md, or shadow-lg for standard elevation. Each class already includes a neutral smooth hairline ring. Do not add a decorative border to the same elevated surface. Use smooth-shadow-* for ringless depth and smooth-shadow-ring-* plus smooth-ring-* for custom size or tint. Keep in-flow panels flat.
```

Render the standard cards without `border`:

```tsx
<div
  data-testid={`shadow-demo-${s.label.slice("shadow-".length)}`}
  className={cn(
    "bg-card flex h-28 items-center justify-center rounded-lg",
    s.twClass,
  )}
>
  <span className="text-muted-foreground font-mono text-xs">{s.label}</span>
</div>
```

Add one explicit example using the user's requested form:

```tsx
<div
  data-testid="shadow-demo-explicit"
  className="smooth-shadow-ring shadow-black smooth-ring-neutral-300/30"
/>
```

Show this exact code beside the example. Explain that explicit utilities are the escape hatch, not the standard API.

- [ ] **Step 4: Remove local double edges elsewhere on the design-system page**

Change the three existing `shadow-sm ring-1` demonstration fragments at lines 696, 733, and 820 to `shadow-sm` only. Preserve focus-visible outlines and semantic state classes.

- [ ] **Step 5: Add stable overlay QA locators**

Add these props to the existing component demos:

```tsx
<Button data-testid="shadow-trigger-dialog" variant="outline">
<DialogContent data-testid="shadow-demo-dialog">
<Button data-testid="shadow-trigger-modal" variant="outline">
<ModalContent data-testid="shadow-demo-modal">
<Button data-testid="shadow-trigger-sheet" variant="outline">
<SheetContent data-testid="shadow-demo-sheet">
<Button data-testid="shadow-trigger-menu" variant="outline">
<DropdownMenuContent data-testid="shadow-demo-menu">
<Button data-testid="shadow-trigger-popover" variant="outline">
<PopoverContent data-testid="shadow-demo-popover" className="w-64">
<Button data-testid="shadow-trigger-toast" onClick={() => successToast('Saved')}>Success</Button>
```

Do not add separate demo components. The visual test must exercise the same shared primitives shipped to users.

- [ ] **Step 6: Replace the stale design skill guidance**

Replace the Elevation section in `.claude/skills/kortix-design-system/SKILL.md` with:

```markdown
### Elevation (shadows)

`apps/web/src/app/globals.css` maps the standard Kortix API to `shadow-plugin@2.1.0`.

| Step                                | Use                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------- |
| _(none — border or substrate only)_ | Panels, rows, tables, and other in-flow surfaces                       |
| `shadow-sm`                         | Compact floating controls and raised active states                     |
| `shadow-md`                         | Dropdowns, selects, popovers, hover cards, and compact floating panels |
| `shadow-lg`                         | Modals, sheets, toasts, and substantial overlays                       |

- Standard elevation already includes `smooth-ring-neutral-300/30`. Do not add a decorative full border or `ring-1`.
- Preserve directional structural borders. Pair them with ringless `smooth-shadow-*` depth.
- Preserve focus, selection, validation, and status states with outlines or explicit smooth-ring colors.
- Use `smooth-shadow-ring-*`, `smooth-shadow-*`, `shadow-*` colors, and `smooth-ring-*` colors only for explicit exceptions.
- Never stack a native shadow size and an explicit plugin shadow size on one element.
- Never hand-roll `shadow-[…]` when a standard or explicit plugin step fits.
```

- [ ] **Step 7: Run focused tests and lint**

```bash
pnpm --filter Kortix-Computer-Frontend exec bun test \
  src/app/shadow-system.test.ts \
  src/lib/utils.test.ts \
  src/lib/shadow-edge-contract.test.ts

pnpm --dir apps/web exec eslint 'src/app/(public)/(marketing)/design-system/page.tsx'
```

Expected: all shadow tests pass. ESLint reports `0 errors`.

- [ ] **Step 8: Commit the documentation**

```bash
git add 'apps/web/src/app/(public)/(marketing)/design-system/page.tsx' .claude/skills/kortix-design-system/SKILL.md docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md
git commit -m "docs(web): document smooth shadow system"
```

Add the commit SHA and test output to the Linear documentation issue.

---

### Task 8: Add headless visual and computed-style coverage

**Files:**

- Create: `tests/visual/shadows.visual.spec.ts`
- Create: `tests/visual/__screenshots__/shadows.visual.spec.ts/shadows-light-desktop-chromium-darwin.png`
- Create: `tests/visual/__screenshots__/shadows.visual.spec.ts/shadows-dark-desktop-chromium-darwin.png`
- Create: `tests/visual/__screenshots__/shadows.visual.spec.ts/shadows-light-narrow-chromium-darwin.png`
- Create: `tests/visual/__screenshots__/shadows.visual.spec.ts/shadows-dark-narrow-chromium-darwin.png`
- Update: `docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md`

**Interfaces:**

- Consumes: `/design-system#shadows`, stable QA locators from Task 7, and worktree web port `13400`.
- Produces: computed `box-shadow` assertions, shared-overlay assertions, and four reviewed image baselines.

- [ ] **Step 1: Write the headless visual specification**

Create `tests/visual/shadows.visual.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

type Theme = "light" | "dark";

async function loadDesignSystem(
  page: Page,
  theme: Theme,
  hash: string,
): Promise<void> {
  await page.addInitScript(
    (value) => localStorage.setItem("theme", value),
    theme,
  );
  await page.goto(`/design-system#${hash}`, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveClass(new RegExp(theme));
}

test.describe("Smooth shadow system", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await page.addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }`,
    });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme} aliases expose depth and a one-pixel smooth ring`, async ({
      page,
    }) => {
      await loadDesignSystem(page, theme, "shadows");

      for (const size of ["sm", "md", "lg"] as const) {
        const boxShadow = await page
          .getByTestId(`shadow-demo-${size}`)
          .evaluate((element) => getComputedStyle(element).boxShadow);
        expect(boxShadow).not.toBe("none");
        expect(boxShadow).toContain("0px 0px 0px 1px");
      }
    });

    test(`${theme} shared overlays keep one visible edge`, async ({ page }) => {
      await loadDesignSystem(page, theme, "components");

      await page.getByTestId("shadow-trigger-menu").click();
      const menu = page.getByTestId("shadow-demo-menu");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveCSS("border-top-width", "0px");
      await expect(menu).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Escape");

      await page.getByTestId("shadow-trigger-dialog").click();
      const dialog = page.getByTestId("shadow-demo-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveCSS("border-top-width", "0px");
      await expect(dialog).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Escape");

      await page.getByTestId("shadow-trigger-popover").click();
      const popover = page.getByTestId("shadow-demo-popover");
      await expect(popover).toBeVisible();
      await expect(popover).toHaveCSS("border-top-width", "0px");
      await expect(popover).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Escape");

      await page.getByTestId("shadow-trigger-modal").click();
      const modal = page.getByTestId("shadow-demo-modal");
      await expect(modal).toBeVisible();
      await expect(modal).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Escape");

      await page.getByTestId("shadow-trigger-sheet").click();
      const sheet = page.getByTestId("shadow-demo-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Escape");

      await page.getByTestId("shadow-trigger-toast").click();
      const toast = page.locator('[data-slot="toast-surface"]');
      await expect(toast).toBeVisible();
      await expect(toast).toHaveCSS("border-top-width", "0px");
      await expect(toast).not.toHaveCSS("box-shadow", "none");
    });

    for (const viewport of [
      { name: "desktop", width: 1280, height: 720 },
      { name: "narrow", width: 390, height: 844 },
    ] as const) {
      test(`${theme} ${viewport.name} shadow reference`, async ({ page }) => {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await loadDesignSystem(page, theme, "shadows");
        await expect(page.locator("#shadows")).toHaveScreenshot(
          `shadows-${theme}-${viewport.name}.png`,
        );
      });
    }
  }
});
```

If translated button text differs in the configured locale, add `data-testid` to the triggers in Task 7 and use those locators. Do not weaken the computed-style assertions.

- [ ] **Step 2: Start the isolated worktree stack**

From `/Users/jay/root/kortix/suna-shadow-plugin`, run:

```bash
pnpm dev
```

Expected: web listens on `http://localhost:13400` and API listens on `http://localhost:13408`. Keep this terminal session running.

- [ ] **Step 3: Generate the four Darwin baselines headlessly**

Run in a second terminal:

```bash
E2E_BASE_URL=http://localhost:13400 \
  pnpm --dir apps/web exec playwright test \
  --config ../../tests/visual/playwright.config.ts \
  shadows.visual.spec.ts \
  --project=chromium \
  --update-snapshots
```

Expected: `8 passed`. The command runs headlessly. It creates four new PNG baselines and passes four computed/overlay tests.

- [ ] **Step 4: Inspect every baseline image**

Use the local image viewer, not a browser. Confirm:

- all three steps remain distinct;
- each card has one soft perimeter edge;
- light theme has no muddy gray slab;
- dark theme has no bright halo;
- narrow layout does not clip any shadow;
- the explicit example matches the standard visual language.

Record the image dimensions and review result in the audit report.

- [ ] **Step 5: Re-run without updating snapshots**

```bash
E2E_BASE_URL=http://localhost:13400 \
  pnpm --dir apps/web exec playwright test \
  --config ../../tests/visual/playwright.config.ts \
  shadows.visual.spec.ts \
  --project=chromium
```

Expected: `8 passed`, `0 failed`.

- [ ] **Step 6: Re-verify the public marketing page**

Run the existing landing suite against the same server:

```bash
E2E_BASE_URL=http://localhost:13400 \
  pnpm --dir apps/web exec playwright test \
  --config ../../tests/visual/playwright.config.ts \
  landing.visual.spec.ts \
  --project=chromium
```

Expected: `2 passed`. If the intentional hero shadow changes produce a diff, regenerate only the two landing baselines with `--update-snapshots`, inspect both PNGs with the local image viewer, and re-run without that flag.

- [ ] **Step 7: Commit visual coverage**

```bash
git add tests/visual/shadows.visual.spec.ts tests/visual/__screenshots__ docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md
git commit -m "test(web): cover smooth shadow visuals"
```

Add the commit SHA, Playwright output, and screenshot review to the Linear documentation issue.

---

### Task 9: Run release gates, review the diff, and merge the PR

**Files:**

- Verify: all files changed since `897f7acf6d`
- Update: `docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md`
- External create: GitHub pull request against `main`

**Interfaces:**

- Consumes: all implementation commits and local evidence.
- Produces: a reviewed and merged PR with no uncommitted changes.

- [ ] **Step 1: Run all focused shadow tests together**

```bash
pnpm --filter Kortix-Computer-Frontend exec bun test \
  src/app/shadow-system.test.ts \
  src/lib/utils.test.ts \
  src/lib/shadow-edge-contract.test.ts
```

Expected: `9 pass`, `0 fail`.

- [ ] **Step 2: Run all affected web tests**

```bash
pnpm --filter Kortix-Computer-Frontend test
```

Expected: all web tests pass. Any pre-existing failure must include the exact test name, baseline evidence from `main`, and a Linear comment before proceeding.

- [ ] **Step 3: Run ESLint on every changed TypeScript file**

```bash
git diff --name-only 897f7acf6d...HEAD -- apps/web/src \
  | rg '\.(ts|tsx)$' \
  | sed 's#^apps/web/##' \
  | (cd apps/web && xargs pnpm exec eslint)
```

Expected: `0 errors`.

- [ ] **Step 4: Run the web typecheck**

```bash
pnpm --filter Kortix-Computer-Frontend exec tsc --noEmit 2>&1 | tee /tmp/kortix-shadow-web-tsc.log
```

Expected: exit `0`, or only the documented `@types/bun` `test.each` errors in these files:

```text
app/(system)/api/og/template/template-url.test.ts
features/file-viewer/preview-fit.test.tsx
features/session/action-panel/easy/easy-panel-logic.test.ts
```

Run this guard after a nonzero result:

```bash
rg '^.*error TS' /tmp/kortix-shadow-web-tsc.log \
  | rg -v 'template-url\.test\.ts|preview-fit\.test\.tsx|easy-panel-logic\.test\.ts'
```

Expected: no output. Any other TypeScript error blocks the PR.

- [ ] **Step 5: Run the production build**

```bash
pnpm --filter Kortix-Computer-Frontend build
```

Expected: Next.js exits `0` and reports a successful production build.

- [ ] **Step 6: Re-run headless visual verification**

```bash
E2E_BASE_URL=http://localhost:13400 \
  pnpm --dir apps/web exec playwright test \
  --config ../../tests/visual/playwright.config.ts \
  shadows.visual.spec.ts \
  --project=chromium
```

Expected: `8 passed`. Then run `landing.visual.spec.ts` with the same base URL and expect `2 passed`.

- [ ] **Step 7: Review the complete diff**

```bash
git diff --check 897f7acf6d...HEAD
git diff --stat 897f7acf6d...HEAD
git status --short
```

Expected: `git diff --check` has no output. The status is clean. The diff contains no changes outside the file map except generated lockfile metadata and reviewed screenshot baselines.

Confirm the audit report contains all local command outputs. Commit its final local evidence if it changed:

```bash
git add docs/superpowers/reports/2026-08-06-smooth-shadow-audit.md
git commit -m "chore(web): record shadow verification"
```

- [ ] **Step 8: Push and open the PR**

```bash
git push -u origin shadow-plugin

gh pr create \
  --base main \
  --head shadow-plugin \
  --title "feat(web): adopt smooth shadow system" \
  --body "Adopts shadow-plugin@2.1.0 for shadow-sm, shadow-md, and shadow-lg. Removes duplicate decorative edges across apps/web. Updates the living design system and adds compile, source-policy, and headless visual coverage."
```

Expected: GitHub returns one PR URL.

- [ ] **Step 9: Wait for required checks and merge**

```bash
gh pr checks --watch
gh pr merge --squash
gh pr view --json number,url,state,mergeCommit
```

Expected: all required checks pass, PR state is `MERGED`, and `mergeCommit.oid` is present.

Record the PR URL and merge SHA in the audit report and Linear. Keep every issue `In Progress` until Task 10 proves the deployed merge SHA and dev behavior.

---

### Task 10: Prove the merged SHA on dev and close the project

**Files:**

- External verify: GitHub Actions workflow `.github/workflows/deploy-dev.yml`
- External verify: `https://dev.kortix.com/api/runtime-config`
- External verify: `https://dev.kortix.com/design-system`
- External update: Linear project and issues

**Interfaces:**

- Consumes: the merged SHA from Task 9.
- Produces: immutable deployment evidence and black-box dev verification for light and dark themes.

- [ ] **Step 1: Resolve the merge SHA and expected version suffix**

```bash
merge_sha=$(gh pr view --json mergeCommit --jq '.mergeCommit.oid')
merge_sha8=$(printf '%s' "$merge_sha" | cut -c1-8)
echo "$merge_sha"
echo "$merge_sha8"
```

Expected: a 40-character SHA and its first eight characters.

- [ ] **Step 2: Find and follow Deploy Dev**

```bash
gh run list --workflow deploy-dev.yml --branch main --limit 10
```

Select the run whose head SHA equals `merge_sha`. Then run:

```bash
deploy_run_id=$(gh run list --workflow deploy-dev.yml --branch main --limit 20 --json databaseId,headSha --jq ".[] | select(.headSha == \"$merge_sha\") | .databaseId" | head -n 1)
test -n "$deploy_run_id"
gh run watch "$deploy_run_id" --exit-status
gh run view "$deploy_run_id" --json databaseId,headSha,status,conclusion,url,jobs
gh run view "$deploy_run_id" --log | rg "kortix/kortix-frontend:dev-${merge_sha8}"
```

Expected:

- `headSha` equals `merge_sha`;
- `conclusion` equals `success`;
- change detection reports frontend `true` because `apps/web/**` and `pnpm-lock.yaml` changed;
- `Build frontend image (multi-arch)` succeeds;
- the log contains `kortix/kortix-frontend:dev-${merge_sha8}`.

If path detection skips frontend, manually dispatch `Deploy Dev` for the merged SHA and repeat this step. Do not accept an API health check as frontend deployment proof.

- [ ] **Step 3: Verify the deployed web version contains the merge SHA**

Run:

```bash
curl -fsS https://dev.kortix.com/api/runtime-config | tee /tmp/kortix-shadow-dev-runtime.js
rg "$merge_sha8" /tmp/kortix-shadow-dev-runtime.js
```

Expected: the runtime config contains `VERSION` with suffix `-dev.${merge_sha8}`. If Vercel is still deploying, repeat this two-command check after the current request completes. Do not run one blocking sleep loop longer than 60 seconds.

- [ ] **Step 4: Run black-box computed-style checks against dev**

```bash
E2E_BASE_URL=https://dev.kortix.com \
  pnpm --dir apps/web exec playwright test \
  --config ../../tests/visual/playwright.config.ts \
  shadows.visual.spec.ts \
  --project=chromium \
  --grep 'aliases expose depth|shared overlays keep one visible edge'
```

Expected: `4 passed`. This command is headless and checks light and dark themes.

- [ ] **Step 5: Capture dev screenshots without changing baselines**

```bash
E2E_BASE_URL=https://dev.kortix.com \
  pnpm --dir apps/web exec playwright test \
  --config ../../tests/visual/playwright.config.ts \
  shadows.visual.spec.ts \
  --project=chromium \
  --grep 'shadow reference'
```

Expected: `4 passed`. Do not use `--update-snapshots` against dev.

- [ ] **Step 6: Close Linear with evidence**

Add one final comment to `[Shadow] Merge, deploy, and verify dev` containing:

- PR URL;
- merge SHA;
- Deploy Dev run URL;
- immutable frontend image tag;
- deployed runtime `VERSION`;
- local focused test counts;
- local Playwright result;
- dev Playwright result;
- remaining risks, or the exact text `Remaining risks: none found`.

Set all seven issues to `Done`. Confirm the final evidence comment is present, then mark the project complete according to the Jay team's project workflow.

- [ ] **Step 7: Report completion**

Return exactly these evidence groups to the user:

1. Changed files and public shadow contract.
2. Test, lint, typecheck, build, and headless Playwright commands with real outputs.
3. Linear project URL and issue identifiers.
4. PR URL and merge SHA.
5. Deploy Dev run URL, immutable image tag, deployed runtime version, and dev Playwright result.
6. Remaining unverified behavior or risk. State `None` only when every step above passed.
