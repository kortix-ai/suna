# fumadocs to Blume Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `kortix.com/docs` from Blume instead of fumadocs, at the same `/docs` path, from one deployment.

**Architecture:** Blume (Astro + Vite) builds the 33 docs MDX files to static HTML into `apps/web/public/docs/`. Next serves that output as static files and maps clean URLs onto it with two `afterFiles` rewrites. Content stays at `apps/web/content/docs`, so the existing SEO and agent surfaces (`/llms.txt`, `/markdown/docs/*.md`, `/mcp`, `/sitemap.xml`) keep reading it off disk and keep working.

**Tech Stack:** Blume 1.5.3 (Astro + Vite), Next.js 16.3.3, Bun test, TypeScript, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-05-docs-fumadocs-to-blume-design.md`

## Global Constraints

These apply to every task. Do not restate them per task; they are always in force.

- **Blume built-in components only in `content/docs`.** No `@/components/*` import. No `@/lib/icons/ssr` Phosphor icon. No React island importing app code. No `KortixLogo` component. The docs logo is a static SVG path in `blume.config.ts`. A page that seems to need an app component means the page changes, not the rule.
- **Pin Blume exactly: `"blume": "1.5.3"`.** No caret. It was published 2026-09-04.
- **Node 22.12.0 or newer** is Blume's engine floor. Worktree shells need `nvm use 22`.
- **`fumadocs-core` and `fumadocs-mdx` must stay.** Only `fumadocs-ui` is removed. `/use-cases` still runs on the other two via `source.config.ts` and `src/lib/use-cases-source.ts`.
- **`/use-cases` is out of scope.** No file under `content/use-cases/` changes.
- **Never commit unless the user asks.** Steps below that say "Commit" are the shape of the work; ask before running them.
- **Never merge to `main` without the user's explicit approval of that merge.**
- Run tests from `apps/web` with `bun test <path>`. The package script is `bun test --isolate --parallel=4`.
- Working directory is the worktree `/Users/jay/root/kortix/suna-docs`. Do not `cd` to the primary checkout.

## Task Dependency Order

Tasks 2 and 3 come before any content change on purpose. `src/lib/seo/public-content.test.ts` asserts, over every public markdown record, that no unresolved MDX or JSX leaks into agent-facing markdown. Convert content first and that guard fails across all 33 pages at once. Teach the renderer first and the suite stays green the whole way through.

---

### Task 1: Phase 0 feasibility probe (throwaway)

The spec names one untested assumption: whether `blume build` with `deployment.base: "/docs"` emits pages at `dist/` or at `dist/docs/`. Every later task's copy step depends on the answer. This task produces facts, not shipped code.

**Files:**
- Create: a throwaway project in the session scratchpad, outside the repo
- Create: `docs/superpowers/plans/2026-09-05-blume-probe-findings.md` (kept)

**Interfaces:**
- Consumes: nothing.
- Produces: three recorded facts that Task 9 reads:
  `PROBE_DIST_LAYOUT` (`"flat"` = pages at `dist/index.html`, or `"nested"` = pages at `dist/docs/index.html`),
  `PROBE_BUILD_SECONDS` (integer),
  `PROBE_ASSET_PREFIX` (the actual href prefix Blume writes for CSS and JS, expected `/docs/_astro/`).

- [ ] **Step 1: Scaffold a throwaway Blume project outside the repo**

```bash
SCRATCH="$TMPDIR/blume-probe"
mkdir -p "$SCRATCH" && cd "$SCRATCH"
node --version   # must print v22.12.0 or newer; if not, run `nvm use 22`
npm init -y >/dev/null
npm i blume@1.5.3
npx blume init . --yes --template docs --content-dir docs --package-manager npm
```

- [ ] **Step 2: Copy three real Kortix docs pages in, to build against real content**

```bash
cd "$TMPDIR/blume-probe"
REPO=/Users/jay/root/kortix/suna-docs/apps/web
cp "$REPO/content/docs/index.mdx" docs/index.mdx
cp "$REPO/content/docs/quickstart.mdx" docs/quickstart.mdx
mkdir -p docs/sdk && cp "$REPO/content/docs/sdk/index.mdx" docs/sdk/index.mdx
```

Then strip the fumadocs imports from those three copies by hand. Delete every line starting with `import ` that sits above the first prose line. This makes the probe measure Blume, not the codemod.

- [ ] **Step 3: Set the base path and build, timing it**

Add to `blume.config.ts` in the throwaway project:

```ts
deployment: {
  base: "/docs",
},
```

Then:

```bash
cd "$TMPDIR/blume-probe"
time npx blume build
```

- [ ] **Step 4: Record the three facts**

```bash
cd "$TMPDIR/blume-probe"
echo "--- layout ---"
ls dist
if [ -d dist/docs ]; then echo "NESTED"; else echo "FLAT"; fi
echo "--- asset prefix ---"
grep -ohE '(href|src)="[^"]*_astro[^"]*"' dist/index.html dist/docs/index.html 2>/dev/null | head -3
```

Expected: `FLAT`, with pages at `dist/index.html` and assets referenced as `/docs/_astro/...`. If it prints `NESTED`, that is fine. Task 9's copy step branches on it.

- [ ] **Step 5: Write the findings file**

Create `docs/superpowers/plans/2026-09-05-blume-probe-findings.md` with these fields filled in from Step 4:

```markdown
# Blume Phase 0 probe findings

- Date: 2026-09-05
- Blume version: 1.6.0
- Node version: <output of `node --version`>

| Fact | Value |
|---|---|
| PROBE_DIST_LAYOUT | flat OR nested |
| PROBE_BUILD_SECONDS | <integer, the `real` figure from `time blume build`> |
| PROBE_ASSET_PREFIX | <for example /docs/_astro/> |

## Decision gate

If PROBE_BUILD_SECONDS is greater than 60, stop and report to the user before
continuing. The spec's fallback is a separate Blume deployment behind a proxy
rewrite (spec section 9), which is a different plan.
```

- [ ] **Step 6: Delete the throwaway project**

```bash
rm -rf "$TMPDIR/blume-probe"
```

- [ ] **Step 7: Report the three facts to the user, then stop for the gate**

Do not start Task 2 until the user has seen `PROBE_BUILD_SECONDS`.

---

### Task 2: Teach the markdown renderer container directives

`renderPlainMarkdownFromMdx()` turns docs MDX into the plain markdown served at `/markdown/docs/*.md` and embedded in `/llms-full.txt`. Today it understands `<Callout>`. It must understand `:::warning[Title]` before any content converts.

**Files:**
- Modify: `apps/web/src/lib/seo/public-content.ts`
- Test: `apps/web/src/lib/seo/public-content.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `renderPlainMarkdownFromMdx(mdx: string): string` now renders a `:::<type>[Title]` block as a blockquote. `> **Title**` on the first line, then `> ` before each body line. Task 5 relies on this exact output.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/lib/seo/public-content.test.ts`, inside the same `describe` that holds `renders MDX source documents as clean agent-readable Markdown`:

```ts
test('renders ::: container directives as blockquotes', () => {
  const mdx = `---
title: Sample
---

:::warning[Keep this warning]
Do not drop this meaningful content.
:::

:::info
Untitled body line.
:::
`;
  const markdown = renderPlainMarkdownFromMdx(mdx);
  expect(markdown).toContain('> **Keep this warning**');
  expect(markdown).toContain('> Do not drop this meaningful content.');
  expect(markdown).toContain('> Untitled body line.');
  expect(markdown).not.toContain(':::');
  expectCleanAgentMarkdown(markdown, 'fixture');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bun test src/lib/seo/public-content.test.ts -t "container directives"`

Expected: FAIL. The `:::` literals survive, so `expect(markdown).not.toContain(':::')` fails.

- [ ] **Step 3: Implement the directive transform**

In `apps/web/src/lib/seo/public-content.ts`, in the same line-walking loop that already handles `<Callout>` (it drives `formatMdxContentLine(line, stack)`), add a directive branch. Track open directives on the existing `stack`.

```ts
// `:::warning[Title]` opens a container directive; a bare `:::` closes it.
// Agent-facing markdown has no directive syntax, so both render as a
// blockquote, the same shape <Callout> already produced.
const DIRECTIVE_OPEN = /^:::([a-z]+)(?:\[(.*)\])?\s*$/;
const DIRECTIVE_CLOSE = /^:::\s*$/;
```

On an opening match: push `'directive'` onto `stack`; when a title was captured, emit `> **${title}**` followed by `>`. On a closing match while `'directive'` is on top: pop it and emit a blank line. While `'directive'` is on the stack, prefix every emitted content line with `> `.

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/web && bun test src/lib/seo/public-content.test.ts -t "container directives"`

Expected: PASS.

- [ ] **Step 5: Run the whole SEO suite to prove nothing regressed**

Run: `cd apps/web && bun test src/lib/seo/public-content.test.ts`

Expected: PASS, including `all public Markdown outputs contain no unresolved MDX module syntax or JSX`. Content is still fumadocs-shaped at this point, so that guard proves the `<Callout>` path still works alongside the new one.

- [ ] **Step 6: Commit** (ask first)

```bash
git add apps/web/src/lib/seo/public-content.ts apps/web/src/lib/seo/public-content.test.ts
git commit -m "feat(seo): render ::: container directives as blockquotes in agent markdown"
```

---

### Task 3: Teach the markdown renderer Blume's block components

Same renderer, the other half of the syntax the content is about to move to.

**Files:**
- Modify: `apps/web/src/lib/seo/public-content.ts`
- Test: `apps/web/src/lib/seo/public-content.test.ts`

**Interfaces:**
- Consumes: `renderPlainMarkdownFromMdx` from Task 2.
- Produces: the same function now also strips `<CardGroup>` and `</CardGroup>`, renders `<Card title="X" href="/y">Body</Card>` as `- [X](/y): Body`, and renders `<Step title="X">` as `### X`. Tasks 6 and 7 rely on this.

- [ ] **Step 1: Write the failing test**

```ts
test('renders Blume block components as plain markdown', () => {
  const mdx = `---
title: Sample
---

<CardGroup>
  <Card icon="rocket" title="Quickstart" href="/docs/quickstart">Start here.</Card>
</CardGroup>

<Steps>
<Step title="Install the CLI">
Run the install script.
</Step>
</Steps>
`;
  const markdown = renderPlainMarkdownFromMdx(mdx);
  expect(markdown).toContain('- [Quickstart](/docs/quickstart): Start here.');
  expect(markdown).toContain('### Install the CLI');
  expect(markdown).toContain('Run the install script.');
  expect(markdown).not.toContain('<Card');
  expect(markdown).not.toContain('<Step');
  expectCleanAgentMarkdown(markdown, 'fixture');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bun test src/lib/seo/public-content.test.ts -t "Blume block components"`

Expected: FAIL on `- [Quickstart](/docs/quickstart): Start here.` not being present.

- [ ] **Step 3: Implement**

Extend the same transform table the existing `<Cards>` and `<Card>` handling uses. `<CardGroup>` and `</CardGroup>` are dropped exactly like `<Cards>` already is. `<Card>` keeps its existing title, href and body rendering, but must now read `icon` as a plain string attribute and discard it, where before it parsed `icon={<XIcon />}`. `<Step title="X">` emits `### X`. `</Step>`, `<Steps>` and `</Steps>` are dropped.

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/web && bun test src/lib/seo/public-content.test.ts -t "Blume block components"`

Expected: PASS.

- [ ] **Step 5: Run the full SEO suite**

Run: `cd apps/web && bun test src/lib/seo/public-content.test.ts`

Expected: PASS. The renderer now speaks both dialects, so content can convert file by file without ever breaking the guard.

- [ ] **Step 6: Commit** (ask first)

```bash
git add apps/web/src/lib/seo/public-content.ts apps/web/src/lib/seo/public-content.test.ts
git commit -m "feat(seo): render Blume CardGroup, Card, Steps and Step in agent markdown"
```

---

### Task 4: Blume project skeleton and configuration

**Files:**
- Create: `apps/web/blume.config.ts`
- Create: `apps/web/theme.css`
- Modify: `apps/web/package.json`
- Modify: `apps/web/.gitignore`

**Interfaces:**
- Consumes: `PROBE_ASSET_PREFIX` from Task 1.
- Produces: a `blume.config.ts` whose `content.root` is `content/docs` and whose `deployment.base` is `/docs`. Tasks 8 and 9 modify and build this project.

- [ ] **Step 1: Add the dependency, pinned**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
pnpm add blume@1.5.3
```

Then confirm `package.json` reads `"blume": "1.5.3"` with no caret. Edit it by hand if pnpm added one, and rerun `pnpm install`.

- [ ] **Step 2: Write `apps/web/blume.config.ts`**

```ts
import { defineConfig } from 'blume';

// The docs render through Blume, not through the Next app. Nothing in
// content/docs may import an app component. Blume built-ins only.
export default defineConfig({
  title: 'Kortix',
  description: 'Kortix is the AI command center for your company.',

  // Content stays where it has always been. src/lib/seo/public-content.ts
  // reads these same files off disk for /llms.txt, /markdown/docs/*.md and
  // /mcp, so moving them would break four public surfaces at once.
  content: { root: 'content/docs' },

  // The whole Blume site is served under /docs by the Next app, which maps
  // clean URLs onto public/docs/ with two afterFiles rewrites. `base`
  // rewrites internal links and asset hrefs to match.
  deployment: { base: '/docs' },

  // Stock theme, deliberately. A Kortix skin is a separate follow-up; see
  // decision D3 in the spec. Only the logo and accent are set here.
  theme: {
    accent: 'teal',
    radius: 'md',
    mode: 'system',
  },
  logo: {
    light: '/kortix-symbol.svg',
    dark: '/kortix-logomark-white.svg',
    alt: 'Kortix',
    href: '/docs',
  },

  // Search is the ONE surface Blume takes over, replacing /api/search and the
  // fumadocs dialog (spec section 6.4). The default provider builds a static
  // index at build time and queries it in the browser, with no API key and no
  // per-keystroke round trip — the same property the old dialog had. Left
  // unset deliberately: naming a provider here would opt into a hosted backend.
  //
  // Next owns every OTHER AI and SEO surface for the whole domain: marketing,
  // blog and docs in one index. Blume's duplicates would produce a second
  // llms.txt and a second MCP endpoint on the same host. See decision D2.
  ai: { llmsTxt: false, mcp: false },
  seo: { sitemap: false },
});
```

Verify each key against `blume doctor` output in Step 5. Correct any key Blume reports as unknown, and record the correction in this plan file.

- [ ] **Step 3: Write `apps/web/theme.css`**

```css
/* Stock Blume theme. Only the accent is pinned, so /docs stays visually
   self-consistent while the Kortix skin is deferred (spec decision D3). Do not
   add app tokens here. This file must not couple the docs to the app's design
   system. */
:root {
  --blume-accent: oklch(0.68 0.14 180);
}
```

- [ ] **Step 4: Ignore the generated output**

Append to `apps/web/.gitignore`, beside the existing generated-asset entries at lines 64 to 67:

```
public/docs/
```

- [ ] **Step 5: Prove the config loads**

Run: `cd apps/web && npx blume doctor`

Expected: no unknown-key errors. Fix any key it rejects, then rerun until clean.

- [ ] **Step 6: Commit** (ask first)

```bash
git add apps/web/blume.config.ts apps/web/theme.css apps/web/package.json apps/web/.gitignore pnpm-lock.yaml
git commit -m "feat(docs): add pinned Blume 1.5.3 project config"
```

---

### Task 5: Convert callouts to container directives

26 callouts across the tree: 17 `type="warn"`, 8 `type="info"`, 1 untyped.

**Files:**
- Create: `apps/web/scripts/codemod-docs-mdx.mjs`
- Test: `apps/web/scripts/codemod-docs-mdx.test.ts`
- Modify: 16 files under `apps/web/content/docs/`

**Interfaces:**
- Consumes: the directive renderer from Task 2.
- Produces: `convertCallouts(source: string): string` and the helpers `mapOutsideFences(source, mapLine)` and `collapseDropped(source)`, all exported from `scripts/codemod-docs-mdx.mjs`. Tasks 6 and 7 add `convertSteps` and `convertCards` to the same module and reuse both helpers.

- [ ] **Step 1: Write the failing test**

Create `apps/web/scripts/codemod-docs-mdx.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { convertCallouts } from './codemod-docs-mdx.mjs';

describe('convertCallouts', () => {
  test('maps warn to :::warning with a title', () => {
    const input = `<Callout type="warn" title="Deletion is permanent">\nGone for good.\n</Callout>`;
    expect(convertCallouts(input)).toBe(`:::warning[Deletion is permanent]\nGone for good.\n:::`);
  });

  test('maps info to :::info', () => {
    const input = `<Callout type="info" title="Spend order">\nCredits first.\n</Callout>`;
    expect(convertCallouts(input)).toBe(`:::info[Spend order]\nCredits first.\n:::`);
  });

  test('maps an untyped Callout to :::note', () => {
    const input = `<Callout>\nJust a note.\n</Callout>`;
    expect(convertCallouts(input)).toBe(`:::note\nJust a note.\n:::`);
  });

  test('removes the fumadocs Callout import line', () => {
    const input = `import { Callout } from 'fumadocs-ui/components/callout';\n\nBody.`;
    expect(convertCallouts(input)).toBe(`Body.`);
  });

  test('leaves an import INSIDE a fenced code block untouched', () => {
    const input = '```ts\nimport { Callout } from \'fumadocs-ui/components/callout\';\n```';
    expect(convertCallouts(input)).toBe(input);
  });
});
```

The last test is the one that matters. `content/docs` is full of fenced blocks containing real `import` lines from `@kortix/sdk` examples. A naive line-based strip destroys them.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bun test scripts/codemod-docs-mdx.test.ts`

Expected: FAIL with "Cannot find module './codemod-docs-mdx.mjs'".

- [ ] **Step 3: Implement `convertCallouts`**

Create `apps/web/scripts/codemod-docs-mdx.mjs`:

```js
// One-shot codemod for the fumadocs to Blume migration. Kept in the repo (not
// run in CI) so the conversion is reviewable and repeatable, and so the
// fence-safety rule below has a test that pins it.

const CALLOUT_TYPE_TO_DIRECTIVE = {
  warn: 'warning',
  warning: 'warning',
  info: 'info',
  error: 'danger',
};

// Sentinel a transform emits in place of a deleted line; collapseDropped()
// filters it out. Exported so Tasks 6 and 7 reference the constant rather
// than re-typing the literal, which would silently stop being filtered if
// the two ever drift apart.
export const DROP_MARKER = '__DROP_LINE__';

// Walk lines, tracking whether we are inside a fenced code block. Every
// transform in this module is a no-op while inside one: docs pages carry
// example source with real `import` lines, and rewriting those would corrupt
// the examples.
export function mapOutsideFences(source, mapLine) {
  const lines = source.split('\n');
  let inFence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    out.push(inFence ? line : mapLine(line));
  }
  return out.join('\n');
}

// A dropped import leaves the blank line that followed it. Remove both, then
// squeeze any run of three or more newlines the removals opened up.
export function collapseDropped(source) {
  return source
    .split('\n')
    .filter((line) => line !== DROP_MARKER)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
}

export function convertCallouts(source) {
  let openDepth = 0;
  const mapped = mapOutsideFences(source, (line) => {
    const drop =
      /^import\s*\{[^}]*\bCallout\b[^}]*\}\s*from\s*'fumadocs-ui\/components\/callout';\s*$/;
    if (drop.test(line)) return DROP_MARKER;

    const open = line.match(
      /^\s*<Callout(?:\s+type="([a-z]+)")?(?:\s+title="([^"]*)")?\s*>\s*$/,
    );
    if (open) {
      openDepth += 1;
      const kind = CALLOUT_TYPE_TO_DIRECTIVE[open[1] ?? ''] ?? 'note';
      return open[2] ? `:::${kind}[${open[2]}]` : `:::${kind}`;
    }
    if (/^\s*<\/Callout>\s*$/.test(line) && openDepth > 0) {
      openDepth -= 1;
      return ':::';
    }
    return line;
  });

  return collapseDropped(mapped);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/web && bun test scripts/codemod-docs-mdx.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 5: Apply it to the 16 files that use Callout**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { convertCallouts } from './scripts/codemod-docs-mdx.mjs';
for (const f of globSync('content/docs/**/*.mdx')) {
  const before = readFileSync(f, 'utf8');
  const after = convertCallouts(before);
  if (before !== after) { writeFileSync(f, after); console.log('converted', f); }
}
"
```

- [ ] **Step 6: Prove no callout survived and no example import was harmed**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
echo "Callout tags left (expect 0):"
grep -rhoE '<Callout' --include='*.mdx' content/docs | wc -l
echo "Directives added (expect 26):"
grep -rhoE '^:::[a-z]+' --include='*.mdx' content/docs | wc -l
echo "SDK example imports intact (expect 41 — unchanged from before the codemod):"
grep -rhoE "from '@kortix/sdk" --include='*.mdx' content/docs | wc -l
```

- [ ] **Step 7: Read the full diff by hand**

Run: `git diff -- apps/web/content/docs`

Every changed hunk must be a `<Callout ...>` becoming `:::...` or an import line disappearing. Anything else is a codemod bug. Fix the codemod and rerun; do not hand-patch the content.

- [ ] **Step 8: Prove the agent markdown still renders clean**

Run: `cd apps/web && bun test src/lib/seo/public-content.test.ts`

Expected: PASS. This is Task 2 paying off. The guard now sees `:::` content and accepts it.

- [ ] **Step 9: Commit** (ask first)

```bash
git add apps/web/scripts/codemod-docs-mdx.mjs apps/web/scripts/codemod-docs-mdx.test.ts apps/web/content/docs
git commit -m "refactor(docs): convert Callout components to ::: directives"
```

---

### Task 6: Convert Steps and Step

46 `<Step>` and 13 `<Steps>`. Each `<Step>` carries its title as a `###` heading first child; Blume wants it as a `title` prop.

**Files:**
- Modify: `apps/web/scripts/codemod-docs-mdx.mjs`
- Modify: `apps/web/scripts/codemod-docs-mdx.test.ts`
- Modify: 9 files under `apps/web/content/docs/`

**Interfaces:**
- Consumes: `collapseDropped` and the `DROP_MARKER` convention from Task 5.
- Produces: `convertSteps(source: string): string`, exported from the same module.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/scripts/codemod-docs-mdx.test.ts`:

```ts
import { convertSteps } from './codemod-docs-mdx.mjs';

describe('convertSteps', () => {
  test('lifts the heading into a title prop', () => {
    const input = `<Step>\n### Install the CLI\n\nRun the install script.\n</Step>`;
    expect(convertSteps(input)).toBe(
      `<Step title="Install the CLI">\nRun the install script.\n</Step>`,
    );
  });

  test('leaves <Steps> wrappers in place', () => {
    const input = `<Steps>\n\n<Step>\n### One\n\nBody.\n</Step>\n\n</Steps>`;
    const out = convertSteps(input);
    expect(out).toContain('<Steps>');
    expect(out).toContain('<Step title="One">');
  });

  test('removes the fumadocs Steps import line', () => {
    const input = `import { Steps, Step } from 'fumadocs-ui/components/steps';\n\nBody.`;
    expect(convertSteps(input)).toBe(`Body.`);
  });

  test('does not touch a heading that is not a Step title', () => {
    const input = `### Just a heading\n\nBody.`;
    expect(convertSteps(input)).toBe(input);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bun test scripts/codemod-docs-mdx.test.ts -t convertSteps`

Expected: FAIL with "convertSteps is not a function".

- [ ] **Step 3: Implement `convertSteps`**

Add to `apps/web/scripts/codemod-docs-mdx.mjs`. This one cannot use `mapOutsideFences`, because it consumes a following line, so it tracks the fence itself:

```js
export function convertSteps(source) {
  const lines = source.split('\n');
  let inFence = false;
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    if (
      /^import\s*\{[^}]*\bSteps?\b[^}]*\}\s*from\s*'fumadocs-ui\/components\/steps';\s*$/.test(line)
    ) {
      out.push(DROP_MARKER);
      continue;
    }

    // A bare <Step> takes its title from the first heading that follows,
    // skipping the blank line fumadocs authors put between them.
    if (/^\s*<Step>\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j += 1;
      const heading = lines[j]?.match(/^###\s+(.*)$/);
      if (heading) {
        out.push(`<Step title="${heading[1].trim()}">`);
        i = j; // consume the heading; the blank lines between were skipped
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }

  return collapseDropped(out.join('\n'));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/web && bun test scripts/codemod-docs-mdx.test.ts -t convertSteps`

Expected: PASS, 4 tests.

- [ ] **Step 5: Apply it**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
node --input-type=module -e "
import { readFileSync, writeFileSync, globSync } from 'node:fs';
import { convertSteps } from './scripts/codemod-docs-mdx.mjs';
for (const f of globSync('content/docs/**/*.mdx')) {
  const before = readFileSync(f, 'utf8');
  const after = convertSteps(before);
  if (before !== after) { writeFileSync(f, after); console.log('converted', f); }
}
"
```

- [ ] **Step 6: Prove the conversion is total**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
echo "Bare <Step> left (expect 0):"
grep -rhoE '<Step>' --include='*.mdx' content/docs | wc -l
echo "Titled steps (expect 46):"
grep -rhoE '<Step title="' --include='*.mdx' content/docs | wc -l
echo "Steps imports left (expect 0):"
grep -rhoE "fumadocs-ui/components/steps" --include='*.mdx' content/docs | wc -l
```

- [ ] **Step 7: Read the diff, then run the SEO suite**

Run: `git diff -- apps/web/content/docs` then `cd apps/web && bun test src/lib/seo/public-content.test.ts`

Expected: every hunk is a `<Step>` gaining a title or an import disappearing; the suite passes.

- [ ] **Step 8: Commit** (ask first)

```bash
git add apps/web/scripts/codemod-docs-mdx.mjs apps/web/scripts/codemod-docs-mdx.test.ts apps/web/content/docs
git commit -m "refactor(docs): convert Step headings to Blume title props"
```

---

### Task 7: Convert Cards to CardGroup and icons to Lucide names

37 `<Card>`, 8 `<Cards>`, 25 distinct Phosphor icons. This task retires the last app-component import from `content/docs`, satisfying the plan's hardest global constraint.

**Files:**
- Modify: `apps/web/scripts/codemod-docs-mdx.mjs`
- Modify: `apps/web/scripts/codemod-docs-mdx.test.ts`
- Modify: 7 files under `apps/web/content/docs/`

**Interfaces:**
- Consumes: `collapseDropped` from Task 5.
- Produces: `convertCards(source: string): string` and the exported constant `PHOSPHOR_TO_LUCIDE` (a `Record<string, string>`).

- [ ] **Step 1: Write the failing test**

```ts
import { convertCards, PHOSPHOR_TO_LUCIDE } from './codemod-docs-mdx.mjs';

describe('convertCards', () => {
  test('renames Cards to CardGroup', () => {
    expect(convertCards('<Cards>\n</Cards>')).toBe('<CardGroup>\n</CardGroup>');
  });

  test('converts a JSX icon element to a Lucide name string', () => {
    const input = `<Card icon={<RocketIcon />} title="Quickstart" href="/docs/quickstart">Go.</Card>`;
    expect(convertCards(input)).toBe(
      `<Card icon="rocket" title="Quickstart" href="/docs/quickstart">Go.</Card>`,
    );
  });

  test('drops the docs-card and icons/ssr imports', () => {
    const input =
      `import { Card, Cards } from '@/components/markdown/docs-card';\n` +
      `import { RocketIcon } from '@/lib/icons/ssr';\n\nBody.`;
    expect(convertCards(input)).toBe('Body.');
  });

  test('drops a multi-line icons/ssr import', () => {
    const input = `import {\n  CloudIcon,\n  CodeIcon,\n} from '@/lib/icons/ssr';\n\nBody.`;
    expect(convertCards(input)).toBe('Body.');
  });

  test('maps every icon the docs actually use', () => {
    // All 25 measured in the spec. A missing entry means a silently iconless card.
    for (const phosphor of [
      'TerminalIcon', 'RobotIcon', 'PlugsConnectedIcon', 'PathIcon', 'KeyIcon',
      'GitBranchIcon', 'DesktopIcon', 'CubeIcon', 'ChatsIcon', 'BrainIcon',
      'AlarmIcon', 'UsersIcon', 'ShareNetworkIcon', 'ScrollIcon', 'RocketIcon',
      'GitPullRequestIcon', 'FlagIcon', 'FileTextIcon', 'CpuIcon', 'CodeIcon',
      'CloudIcon', 'ClipboardTextIcon', 'BrowserIcon', 'BookOpenIcon', 'AtomIcon',
    ]) {
      expect(PHOSPHOR_TO_LUCIDE[phosphor]).toBeTruthy();
    }
  });

  test('throws on an unmapped icon rather than dropping it silently', () => {
    expect(() => convertCards('<Card icon={<NotARealIcon />} title="x">y</Card>')).toThrow(
      /Unmapped icon/,
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bun test scripts/codemod-docs-mdx.test.ts -t convertCards`

Expected: FAIL with "convertCards is not a function".

- [ ] **Step 3: Implement**

Add to `apps/web/scripts/codemod-docs-mdx.mjs`:

```js
// Phosphor (app) to Lucide (Blume built-in). Blume ships @iconify-json/lucide,
// so icons are name strings, never React elements. Every one of the 25 icons
// the docs use is listed; an unmapped icon must fail loudly rather than
// silently render no icon.
export const PHOSPHOR_TO_LUCIDE = {
  AlarmIcon: 'alarm-clock',
  AtomIcon: 'atom',
  BookOpenIcon: 'book-open',
  BrainIcon: 'brain',
  BrowserIcon: 'app-window',
  ChatsIcon: 'messages-square',
  ClipboardTextIcon: 'clipboard-list',
  CloudIcon: 'cloud',
  CodeIcon: 'code',
  CpuIcon: 'cpu',
  CubeIcon: 'box',
  DesktopIcon: 'monitor',
  FileTextIcon: 'file-text',
  FlagIcon: 'flag',
  GitBranchIcon: 'git-branch',
  GitPullRequestIcon: 'git-pull-request',
  KeyIcon: 'key',
  PathIcon: 'route',
  PlugsConnectedIcon: 'cable',
  RobotIcon: 'bot',
  RocketIcon: 'rocket',
  ScrollIcon: 'scroll',
  ShareNetworkIcon: 'share-2',
  TerminalIcon: 'terminal',
  UsersIcon: 'users',
};

export function convertCards(source) {
  // Multi-line `import { ... } from '@/lib/icons/ssr';` first, as a block.
  let out = source.replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*'@\/(?:lib\/icons\/ssr|components\/markdown\/docs-card)';\s*$/gm,
    DROP_MARKER,
  );

  out = out
    .replace(/<Cards>/g, '<CardGroup>')
    .replace(/<\/Cards>/g, '</CardGroup>')
    .replace(/icon=\{<([A-Za-z]+)\s*\/>\}/g, (_match, name) => {
      const lucide = PHOSPHOR_TO_LUCIDE[name];
      if (!lucide) throw new Error(`Unmapped icon: ${name}. Add it to PHOSPHOR_TO_LUCIDE.`);
      return `icon="${lucide}"`;
    });

  return collapseDropped(out);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/web && bun test scripts/codemod-docs-mdx.test.ts -t convertCards`

Expected: PASS, 6 tests.

- [ ] **Step 5: Apply it**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
node --input-type=module -e "
import { readFileSync, writeFileSync, globSync } from 'node:fs';
import { convertCards } from './scripts/codemod-docs-mdx.mjs';
for (const f of globSync('content/docs/**/*.mdx')) {
  const before = readFileSync(f, 'utf8');
  const after = convertCards(before);
  if (before !== after) { writeFileSync(f, after); console.log('converted', f); }
}
"
```

An "Unmapped icon" throw here is the expected failure mode for an icon the spec's survey missed. Add it to the table and rerun.

- [ ] **Step 6: Prove the global constraint now holds across all 33 files**

This is the acceptance check for the plan's hardest rule.

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
echo "App-component imports left (MUST be 0):"
grep -rhoE "^import .* from '@/" --include='*.mdx' content/docs | wc -l
echo "JSX icon props left (MUST be 0):"
grep -rhoE 'icon=\{<' --include='*.mdx' content/docs | wc -l
echo "fumadocs imports left (MUST be 0):"
grep -rhoE "fumadocs-ui" --include='*.mdx' content/docs | wc -l
echo "CardGroup blocks (expect 8):"
grep -rhoE '<CardGroup>' --include='*.mdx' content/docs | wc -l
```

All three "MUST be 0" lines must print `0`. If any prints non-zero, that file still violates the Blume-components-only rule. Fix the codemod, revert the content, rerun.

- [ ] **Step 7: Read the diff, then run the SEO suite**

Run: `git diff -- apps/web/content/docs` then `cd apps/web && bun test src/lib/seo/public-content.test.ts`

Expected: PASS. Task 3 is what makes this green.

- [ ] **Step 8: Commit** (ask first)

```bash
git add apps/web/scripts/codemod-docs-mdx.mjs apps/web/scripts/codemod-docs-mdx.test.ts apps/web/content/docs
git commit -m "refactor(docs): convert Cards to CardGroup and Phosphor icons to Lucide names"
```

---

### Task 8: Convert navigation from meta.json to meta.ts

7 `meta.json` files. Two constructs in the root file have no direct Blume equivalent.

**Files:**
- Create: `apps/web/content/docs/meta.ts` and 6 more, in `connect/`, `feature-flags/`, `host/`, `project/`, `sdk/`, `work/`
- Delete: the 7 corresponding `meta.json`
- Modify: `apps/web/blume.config.ts`

**Interfaces:**
- Consumes: `blume.config.ts` from Task 4.
- Produces: a rendered sidebar whose page order matches the current one exactly.

- [ ] **Step 1: Record the current sidebar order as the acceptance target**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
for f in $(find content/docs -name meta.json | sort); do
  echo "--- $f"; cat "$f";
done | tee "$TMPDIR/sidebar-before.txt"
```

The rendered Blume sidebar must reproduce this order. Keep the file for Step 6.

- [ ] **Step 2: Convert the 6 simple nested files**

Each of `connect/`, `feature-flags/`, `host/`, `project/`, `sdk/`, `work/` is a plain `{title, pages}` object. Write each as `meta.ts` and delete the `.json`. For example, `content/docs/work/meta.ts`:

```ts
import { defineMeta } from 'blume';

export default defineMeta({
  title: 'Running work',
  pages: ['index', 'sessions', 'change-requests', 'runtime'],
});
```

Repeat for the other five, copying `title` and `pages` verbatim from `$TMPDIR/sidebar-before.txt`.

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
rm content/docs/connect/meta.json content/docs/feature-flags/meta.json \
   content/docs/host/meta.json content/docs/project/meta.json \
   content/docs/sdk/meta.json content/docs/work/meta.json
```

- [ ] **Step 3: Convert the root file, minus its two special entries**

`content/docs/meta.ts`:

```ts
import { defineMeta } from 'blume';

// The `---Develop---` separator and the external API-reference link from the
// old meta.json are NOT here. Blume has no divider primitive and expresses
// external links through navigation config, so both move to blume.config.ts
// in Steps 4 and 5.
export default defineMeta({
  title: 'Documentation',
  pages: [
    'index',
    'quickstart',
    'accounts',
    'credits',
    'project',
    'work',
    'connect',
    'feature-flags',
    'host',
    'cli',
    'sdk',
    'backend',
  ],
});
```

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web && rm content/docs/meta.json
```

- [ ] **Step 4: Decide the separator against a rendered build**

This is the spec's one deliberately deferred decision. Do not guess on paper.

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web && npx blume dev --port 13401 --open
```

Look at the rendered sidebar. The old `meta.json` split the list into an unnamed top group and a "Develop" group holding `cli`, `sdk`, `backend`, and the external API link. Pick whichever Blume construct reproduces that read:

- **Option A, header tab.** Add to `blume.config.ts`: `navigation: { tabs: [{ label: 'Develop', path: '/cli', icon: 'code' }] }`. Choose this if the docs read as two distinct sections.
- **Option B, nested group.** Move `cli.mdx`, `sdk/`, `backend.mdx` under `content/docs/develop/` with its own `meta.ts`. Choose this if a single scrolling sidebar reads better. This **changes URLs**. If chosen, add `/docs/cli` to `/docs/develop/cli` redirects in `next.config.ts` alongside the Task 12 fixes, and update every in-content link the Task 13 validator flags.

Record the choice and the reason in this plan file before continuing.

- [ ] **Step 5: Add the external API-reference link**

In `blume.config.ts`, add the sidebar entry that replaces `"[API reference](https://api.kortix.com/v1/docs)"`:

```ts
navigation: {
  links: [{ label: 'API reference', href: 'https://api.kortix.com/v1/docs' }],
},
```

Confirm the key name against `npx blume doctor`. Correct it if Blume names it differently, and record the correction here.

- [ ] **Step 6: Prove the order matches**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web && npx blume build
grep -ohE 'href="/docs/[a-z-]*"' dist/index.html dist/docs/index.html 2>/dev/null | head -20
```

Expected order: `quickstart, accounts, credits, project, work, connect, feature-flags, host, cli, sdk, backend`, then the external API link. Diff against `$TMPDIR/sidebar-before.txt` by eye.

- [ ] **Step 7: Commit** (ask first)

```bash
git add apps/web/content/docs apps/web/blume.config.ts
git commit -m "refactor(docs): convert meta.json navigation to Blume meta.ts"
```

---

### Task 9: Wire the Blume build into the Next build

The load-bearing task. Vercel runs the bare `next build` from `vercel.json` line 2 and never invokes an npm script, documented at `scripts/generate-fumadocs-source.mjs` line 8. A build step placed only in `package.json` ships kortix.com with no docs at all.

**Files:**
- Create: `apps/web/scripts/blume-docs.mjs`
- Test: `apps/web/scripts/blume-docs.test.ts`
- Modify: `apps/web/next.config.ts` (imports at lines 1-10; new side-effect block after line 92; `rewrites()` at line 477)

**Interfaces:**
- Consumes: `PROBE_DIST_LAYOUT` from Task 1; `blume.config.ts` from Task 4.
- Produces: `buildBlumeDocs(): void` and `getBlumeDocsOutputPaths(): string[]`, both exported from `scripts/blume-docs.mjs`, matching the signature shape of the existing `copyViewerWasm()` and `getViewerWasmOutputPaths()` pair.

- [ ] **Step 1: Write the failing test**

Create `apps/web/scripts/blume-docs.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { getBlumeDocsOutputPaths } from './blume-docs.mjs';

describe('getBlumeDocsOutputPaths', () => {
  test('names the two files that prove the docs build landed', () => {
    const paths = getBlumeDocsOutputPaths();
    expect(paths.some((p) => p.endsWith('public/docs/index.html'))).toBe(true);
    expect(paths.some((p) => p.endsWith('public/docs/quickstart/index.html'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bun test scripts/blume-docs.test.ts`

Expected: FAIL with "Cannot find module './blume-docs.mjs'".

- [ ] **Step 3: Implement the build script**

Create `apps/web/scripts/blume-docs.mjs`. Set `DIST_PAGES_SUBDIR` from Task 1's `PROBE_DIST_LAYOUT`: `''` for flat, `'docs'` for nested.

```js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WEB_ROOT, 'dist');
// Set from the Phase 0 probe (PROBE_DIST_LAYOUT). '' when `deployment.base`
// leaves pages at the dist root; 'docs' when it nests them.
const DIST_PAGES_SUBDIR = '';
const PUBLIC_DOCS = path.join(WEB_ROOT, 'public', 'docs');

export function getBlumeDocsOutputPaths() {
  return [
    path.join(PUBLIC_DOCS, 'index.html'),
    path.join(PUBLIC_DOCS, 'quickstart', 'index.html'),
  ];
}

export function buildBlumeDocs() {
  execFileSync('npx', ['blume', 'build'], { cwd: WEB_ROOT, stdio: 'inherit' });
  const source = path.join(DIST, DIST_PAGES_SUBDIR);
  fs.rmSync(PUBLIC_DOCS, { recursive: true, force: true });
  fs.cpSync(source, PUBLIC_DOCS, { recursive: true });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/web && bun test scripts/blume-docs.test.ts`

Expected: PASS.

- [ ] **Step 5: Hook it into next.config.ts, gated to production builds**

Add the import beside the existing ones at the top of `apps/web/next.config.ts`:

```ts
import { buildBlumeDocs, getBlumeDocsOutputPaths } from './scripts/blume-docs.mjs';
```

Add this block immediately after the emoji-dataset block that ends at line 92, copying the established shape exactly:

```ts
// --- Blume docs build guarantee -------------------------------------------
// /docs is a Blume (Astro) static build served out of public/. It cannot be an
// npm script: vercel.json's buildCommand is the bare `next build`, which never
// invokes one (see scripts/generate-fumadocs-source.mjs for the same trap).
// So it runs here, as a side effect of loading this config, on the same
// belt-and-suspenders pattern as the viewer wasm and emoji dataset above.
//
// Gated to the production build phase only. `blume build` takes tens of
// seconds; on `next dev` the docs are served by `blume dev` through the
// KORTIX_BLUME_DEV_TARGET rewrite instead, which keeps hot reload.
let blumeDocsError: unknown = null;
if (process.env.NEXT_PHASE === 'phase-production-build') {
  try {
    buildBlumeDocs();
  } catch (err) {
    blumeDocsError = err;
  }
  const missingBlumeDocsOutputs = getBlumeDocsOutputPaths().filter(
    (output) => !fs.existsSync(output),
  );
  if (missingBlumeDocsOutputs.length > 0) {
    throw new Error(
      `[next.config.ts] scripts/blume-docs.mjs failed to produce the docs site: ` +
        `${missingBlumeDocsOutputs.join(', ')}` +
        (blumeDocsError ? ` (${(blumeDocsError as Error).message})` : '') +
        `. Run \`npx blume build\` in apps/web to diagnose.`,
    );
  }
}
```

- [ ] **Step 6: Add the two rewrites**

`rewrites()` at `apps/web/next.config.ts` line 477 returns a flat array, which Next applies as `afterFiles`, after the `public/` filesystem check. That ordering is what makes this work: real files under `public/docs/` (every `_astro` asset) are served directly and never reach these rules. Append both entries to the returned array, after the existing `/ingest/flags` entry:

```ts
// /docs is a Blume static build in public/docs/. Astro writes clean URLs as
// directories, and Next's static handler does not resolve a directory index,
// so map them explicitly. These are afterFiles rules (a flat array is), so an
// existing file such as /docs/_astro/app.css is served before they ever fire.
{
  source: '/docs',
  destination: '/docs/index.html',
},
{
  source: '/docs/:path*',
  destination: '/docs/:path*/index.html',
},
```

- [ ] **Step 7: Prove a production build produces a served /docs**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
pnpm build
ls public/docs/index.html public/docs/quickstart/index.html
pnpm start &
sleep 8
for u in / /docs /docs/quickstart /docs/sdk /llms.txt /markdown/docs/quickstart.md; do
  printf '%s -> %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000$u")"
done
curl -s http://localhost:3000/docs | grep -oE '<title>[^<]*</title>'
kill %1
```

Expected: every URL returns `200`, and the `/docs` title is the Kortix docs homepage title. A `404` on `/docs/quickstart` means the rewrite is wrong. A `404` on a `/docs/_astro/*` asset means `deployment.base` is wrong.

- [ ] **Step 8: Commit** (ask first)

```bash
git add apps/web/scripts/blume-docs.mjs apps/web/scripts/blume-docs.test.ts apps/web/next.config.ts
git commit -m "feat(docs): build Blume docs into public/docs and serve them from /docs"
```

---

### Task 10: Dev-mode proxy to blume dev

Without this, editing a docs page under `pnpm dev` requires a full Astro build. With it, authors keep the hot reload fumadocs gave them.

**Files:**
- Modify: `apps/web/next.config.ts` (`rewrites()`)
- Modify: `apps/web/package.json` (`dev` script)

**Interfaces:**
- Consumes: the rewrites array from Task 9.
- Produces: an env-gated `/docs` proxy, active only when `KORTIX_BLUME_DEV_TARGET` is set.

- [ ] **Step 1: Add the env-gated proxy rewrite**

In `rewrites()`, **before** the two static rules from Task 9, insert:

```ts
// Docs hot reload. When `blume dev` is running (pnpm dev sets this), proxy
// /docs to it instead of serving the static public/docs/ build. Env-gated
// exactly like the Supabase proxy above: unset means the rule is not emitted
// at all, so production and anyone not running `blume dev` are untouched.
...(process.env.KORTIX_BLUME_DEV_TARGET
  ? [
      {
        source: '/docs',
        destination: `${process.env.KORTIX_BLUME_DEV_TARGET}/docs`,
      },
      {
        source: '/docs/:path*',
        destination: `${process.env.KORTIX_BLUME_DEV_TARGET}/docs/:path*`,
      },
    ]
  : []),
```

Order matters. These must precede the static `/docs` rules so the proxy wins when the env var is set.

- [ ] **Step 2: Run blume dev alongside Next**

In `apps/web/package.json`, change the `dev` script so it starts `blume dev` on port 13401 (beside the docs worktree's web port 13400) and sets the target. Keep every existing prefix step in place. `copy-viewer-wasm`, `copy-emojibase-data`, `generate-fumadocs-source` and the dotenvx wrapper are all still required. `generate-fumadocs-source.mjs` stays because `/use-cases` still needs the fumadocs codegen.

```json
"dev": "node scripts/copy-viewer-wasm.mjs && node scripts/copy-emojibase-data.mjs && node scripts/generate-fumadocs-source.mjs && (npx blume dev --port 13401 &) && KORTIX_BLUME_DEV_TARGET=http://localhost:13401 NODE_OPTIONS='--max-http-header-size=32768' dotenvx run --ignore=MISSING_ENV_FILE -f .env.local -f .env -- next dev --port ${WEB_PORT:-3000}"
```

- [ ] **Step 3: Verify hot reload end to end**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
pnpm dev &
sleep 25
curl -s -o /dev/null -w 'before: %{http_code}\n' http://localhost:3000/docs/quickstart
sed -i '' 's/^title: Quickstart/title: Quickstart EDITED/' content/docs/quickstart.mdx
sleep 3
echo "edit visible (expect 1):"
curl -s http://localhost:3000/docs/quickstart | grep -c 'EDITED'
git checkout -- content/docs/quickstart.mdx
kill %1
```

Expected: `before: 200`, and the grep count is `1`. The edit is live with no rebuild. A `0` means the proxy is not winning over the static rule; check rewrite order.

- [ ] **Step 4: Commit** (ask first)

```bash
git add apps/web/next.config.ts apps/web/package.json
git commit -m "feat(docs): proxy /docs to blume dev for hot reload in development"
```

---

### Task 11: Remove the fumadocs docs surface

Only now, with Blume serving `/docs`, is the old renderer dead code.

**Files:**
- Delete: `apps/web/src/app/docs/` (8 files), `apps/web/src/lib/source.ts`, `apps/web/src/app/api/search/route.ts`, `apps/web/src/components/markdown/docs-mdx-components.tsx` and its test, `apps/web/src/components/markdown/docs-card.tsx` and its test, `apps/web/src/components/markdown/docs-mermaid.tsx`, `apps/web/content/docs/card-icons.test.ts`
- Modify: `apps/web/src/app/globals.css`, `apps/web/source.config.ts`, `apps/web/package.json`

**Interfaces:**
- Consumes: a working `/docs` from Task 9.
- Produces: an `apps/web` with no `fumadocs-ui` dependency, and `fumadocs-core` and `fumadocs-mdx` still present for `/use-cases`.

- [ ] **Step 1: Delete the route and its components**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
rm -rf src/app/docs
rm src/lib/source.ts
rm src/app/api/search/route.ts
rm src/components/markdown/docs-mdx-components.tsx src/components/markdown/docs-mdx-components.test.tsx
rm src/components/markdown/docs-card.tsx src/components/markdown/docs-card.test.tsx
rm src/components/markdown/docs-mermaid.tsx
rm content/docs/card-icons.test.ts
```

`src/components/markdown/code/` stays. It is shared with the app's own markdown renderer, not exclusive to docs.

- [ ] **Step 2: Strip fumadocs from globals.css**

Three regions come out of `apps/web/src/app/globals.css` (2279 lines total):

1. Lines 2 and 3: `@import 'fumadocs-ui/css/neutral.css';` and `@import 'fumadocs-ui/css/preset.css';`
2. Line 9: `@source "../node_modules/fumadocs-ui/dist/**/*.js";`
3. The `--color-fd-*` bridge inside `:root` (lines 20 to 36) and the whole "Docs polish layer" block, lines 129 to 223, which ends at the `#nd-page a[class*='bg-fd-card']:hover` rule.

Nothing after line 240 references `fd-` or `#nd-`. Verify:

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
grep -c "fd-\|#nd-\|fumadocs" src/app/globals.css   # expect 0
```

- [ ] **Step 3: Drop the docs collection from source.config.ts**

Remove the `export const docs = defineDocs({ dir: 'content/docs' });` declaration and its comment. **Keep** `contentSchema`, `export const useCases`, and the whole `defineConfig({ mdxOptions: ... })` default export. `/use-cases` still compiles through them.

- [ ] **Step 4: Remove only fumadocs-ui**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
pnpm remove fumadocs-ui
grep -n "fumadocs" package.json   # fumadocs-core and fumadocs-mdx MUST remain
```

- [ ] **Step 5: Prove nothing else imported it**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
echo "fumadocs-ui references left in src (expect 1, the test fixture):"
grep -rn "fumadocs-ui" src --include='*.ts' --include='*.tsx' --include='*.css'
```

`src/lib/seo/public-content.test.ts` line 144 will still match. That line lives inside a template-literal MDX fixture, not an import. Task 12 rewrites it. Confirm by eye that it is the only hit.

- [ ] **Step 6: Typecheck and test**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
npx tsc --noEmit
bun test src/lib/seo/
npx eslint src/components/markdown
```

Expected: `tsc` clean apart from the roughly 15 known `@types/bun` `test.each` errors in the 3 files named in `CLAUDE.md`. Any new error naming a deleted module is a missed importer. Find and fix it.

- [ ] **Step 7: Commit** (ask first)

```bash
git add -u apps/web
git commit -m "refactor(docs): remove the fumadocs docs renderer and fumadocs-ui"
```

---

### Task 12: Rewrite the SEO test fixture and fix the broken redirects

**Files:**
- Modify: `apps/web/src/lib/seo/public-content.test.ts` line 144
- Modify: `apps/web/next.config.ts` lines 413 to 419

**Interfaces:**
- Consumes: the directive renderer from Task 2.
- Produces: a test suite with no fumadocs syntax anywhere, and two redirects that resolve.

- [ ] **Step 1: Rewrite the MDX fixture**

In the test `renders MDX source documents as clean agent-readable Markdown`, replace the fumadocs fixture with the directive form. The assertions below it stay **byte-identical**. They are the contract for Task 2's transform.

```ts
    const mdx = `---
title: Sample
---

:::warning[Keep this warning]
Do not drop this meaningful content.
:::

<Figure caption="A truthful diagram" aspect="16/9" />

<StatGrid>
  <Stat value="3 systems" label="One agent" />
</StatGrid>
`;
    const markdown = renderPlainMarkdownFromMdx(mdx);
    expect(markdown).toContain('> **Keep this warning**');
    expect(markdown).toContain('> Do not drop this meaningful content.');
    expect(markdown).toContain('> Figure: A truthful diagram');
    expect(markdown).toContain('- **3 systems:** One agent');
    expectCleanAgentMarkdown(markdown, 'fixture');
```

- [ ] **Step 2: Run the suite**

Run: `cd apps/web && bun test src/lib/seo/public-content.test.ts`

Expected: PASS. The assertions did not change, so this proves the directive path produces exactly what the `<Callout>` path used to.

- [ ] **Step 3: Fix the two dead redirects**

`apps/web/next.config.ts` lines 413 to 419 send `/docs/self-hosting` and `/docs/self-host` to `/docs/guides/self-hosting`. There is no `content/docs/guides/` directory, so both 404 today. This is a pre-existing bug, not a migration regression. The self-host content is at `content/docs/host/`. Repoint both, and correct the stale comment above them that claims the canonical page is `content/docs/self-hosting.mdx`:

```ts
      // The canonical self-host doc is content/docs/host/index.mdx, served at
      // /docs/host. These two aliases previously pointed at
      // /docs/guides/self-hosting, a path that has never existed, so both
      // 404'd. The CLI, README and external links still use the old spellings.
      {
        source: '/docs/self-hosting',
        destination: '/docs/host',
        permanent: true,
      },
      {
        source: '/docs/self-host',
        destination: '/docs/host',
        permanent: true,
      },
```

- [ ] **Step 4: Prove the redirects now resolve**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
pnpm build && pnpm start &
sleep 8
for u in /docs/self-hosting /docs/self-host; do
  printf '%s -> %s -> %s\n' "$u" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000$u")" \
    "$(curl -s -o /dev/null -w '%{redirect_url}' "http://localhost:3000$u")"
done
curl -s -o /dev/null -w '/docs/host -> %{http_code}\n' http://localhost:3000/docs/host
kill %1
```

Expected: both aliases return `308` to `/docs/host`, and `/docs/host` returns `200`. Before this task, following either alias ended in a 404.

- [ ] **Step 5: Commit** (ask first)

```bash
git add apps/web/src/lib/seo/public-content.test.ts apps/web/next.config.ts
git commit -m "fix(docs): repoint dead self-hosting redirects and drop fumadocs test fixture"
```

---

### Task 13: Add the link-validation CI gate

Blume ships internal link checking. fumadocs had no equivalent, so this is new coverage, not a replacement.

**Files:**
- Modify: `apps/web/package.json`
- Modify: `.github/workflows/tests.yml`

**Interfaces:**
- Consumes: a building Blume site from Task 9.
- Produces: a CI step that fails the `packages` lane on a broken internal docs link.

- [ ] **Step 1: Add the script**

In `apps/web/package.json` scripts:

```json
"docs:validate": "blume validate --strict"
```

- [ ] **Step 2: Run it locally and fix whatever it finds**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web && pnpm docs:validate
```

Expected: exit 0. Broken links here are real bugs in the migrated content. Fix the content, not the gate. Record every link it flags in this plan file.

- [ ] **Step 3: Add it to the packages lane**

In `.github/workflows/tests.yml`, in the `packages` lane after the existing test step, add:

```yaml
      - name: Validate docs links
        working-directory: apps/web
        run: pnpm docs:validate
```

Do not create a new lane. `CLAUDE.md` forbids adding another cross-cutting harness; this rides the existing one.

- [ ] **Step 4: Commit** (ask first)

```bash
git add .github/workflows/tests.yml apps/web/package.json
git commit -m "ci: fail the packages lane on a broken internal docs link"
```

---

### Task 14: Full verification

`CLAUDE.md` requires all three tiers. A local pass does not replace the preview origin.

**Files:** none created. This task produces evidence.

- [ ] **Step 1: Local, every docs URL, with real status codes**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
pnpm build && pnpm start &
sleep 10
FAIL=0
for f in $(find content/docs -name '*.mdx' | sort); do
  slug=$(echo "$f" | sed 's|content/docs/||; s|\.mdx$||; s|/index$||; s|^index$||')
  url=$(echo "/docs/$slug" | sed 's|/$||')
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000$url")
  if [ "$code" != "200" ]; then echo "FAIL $url -> $code"; FAIL=1; fi
done
if [ $FAIL = 0 ]; then echo "docs pages: ALL 200"; else echo "docs pages: FAILURES ABOVE"; fi
```

Expected: all 33 return `200`. Paste the real output into the final report.

- [ ] **Step 2: Local, the surfaces that must have survived**

```bash
echo "llms.txt docs entries:"; curl -s http://localhost:3000/llms.txt | grep -c '/docs/'
echo "quickstart markdown head:"; curl -s http://localhost:3000/markdown/docs/quickstart.md | head -5
echo "sitemap docs entries:"; curl -s http://localhost:3000/sitemap.xml | grep -c '/docs/'
curl -s -o /dev/null -w 'mcp -> %{http_code}\n' http://localhost:3000/mcp
curl -s -o /dev/null -w 'use-cases -> %{http_code}\n' http://localhost:3000/use-cases
kill %1
```

Expected: `/llms.txt` and `/sitemap.xml` each list more than 30 docs URLs. `/markdown/docs/quickstart.md` returns clean markdown with no `:::` and no `<Card` left in it. `/mcp` returns 200. `/use-cases` returns 200, proving the fumadocs half that stayed is untouched.

- [ ] **Step 3: Local, the full gates**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
npx tsc --noEmit
npx eslint src scripts
pnpm docs:validate
cd /Users/jay/root/kortix/suna-docs && pnpm test
```

`pnpm test` on `main` has a known baseline of 38 failures. Compare **sets**, not counts. A different set means this branch broke something.

- [ ] **Step 4: Preview, open the draft PR and label it**

```bash
cd /Users/jay/root/kortix/suna-docs
git push -u origin docs
gh pr create --draft --base main \
  --title "docs: migrate /docs from fumadocs to Blume" \
  --body "Migrates kortix.com/docs from fumadocs to Blume, served at the same path from one deployment. Spec: docs/superpowers/specs/2026-09-05-docs-fumadocs-to-blume-design.md"
gh pr edit --add-label preview
```

`pnpm worktree pr` times out at 5 minutes on the push. Split it as above.

- [ ] **Step 5: Preview, drive the real /docs in a browser**

On the preview origin from the sticky PR comment, using Playwright:

1. Navigate to the preview origin `/docs`. Assert the page title, and that the sidebar lists all 11 top-level entries in the Task 8 order.
2. Click through to `/docs/quickstart`. Assert the steps render as numbered steps and the first step title is "Install the CLI".
3. Open search, type `session`, assert results appear, and assert **no** network request goes to `/api/search`, which no longer exists.
4. Assert a `:::warning` renders as a styled callout, not literal `:::` text.
5. Assert the card group on `/docs` renders cards with visible icons. This is the proof the Lucide mapping landed.
6. Screenshot `/docs` and `/docs/quickstart`.

- [ ] **Step 6: Preview, audit**

```bash
cd /Users/jay/root/kortix/suna-docs/apps/web
npx blume audit --url <preview-origin> --fail-on error
```

- [ ] **Step 7: Report, then stop**

Write the final report per `CLAUDE.md`: what changed, what was verified with the command and its real output, what is unverified, and what the user should test. Then **stop**. Do not merge. Merging to `main` requires the user's explicit word on that merge.

- [ ] **Step 8: After the user approves a merge, dev verification**

Follow the Deploy Dev run to completion, confirm the deployed artifact contains the merged SHA, then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://dev.kortix.com/docs
curl -s https://dev.kortix.com/docs | grep -oE '<title>[^<]*</title>'
curl -s https://dev.kortix.com/llms.txt | grep -c '/docs/'
```

A successful `/health` is not deployment proof. Confirm the SHA.
