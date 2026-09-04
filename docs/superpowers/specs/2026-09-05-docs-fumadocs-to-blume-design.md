# Design: migrate `/docs` from fumadocs to Blume

- **Date:** 2026-09-05
- **Branch:** `docs` (worktree `suna-docs`)
- **Status:** approved, not implemented
- **Scope:** `apps/web` only. `/use-cases` is out of scope and stays on fumadocs.

## 1. Problem

`kortix.com/docs` renders through fumadocs. The task is to render it through
Blume instead, at the same `/docs` path, with no separate docs domain.

This is not a dependency swap. fumadocs is a Next.js library that renders
inside `apps/web` as React Server Components. Blume is an Astro + Vite static
site generator with its own CLI. The migration introduces a second build whose
output must be mounted inside the Next app.

## 2. Decisions

These were decided before this spec was written. They are fixed.

| # | Decision | Chosen |
|---|---|---|
| D1 | How `/docs` is served | Blume builds to static HTML into `apps/web/public/docs/`. One deployment. |
| D2 | Owner of llms.txt / raw markdown / MCP / sitemap | Next keeps them. Blume's duplicates are disabled. |
| D3 | Theme | Stock Blume. Logo and accent only. A Kortix skin is a later, separate task. |
| D4 | Components in docs MDX | **Blume built-in components only.** See §3. |

### D4 is a hard rule

Docs pages must never import or render a Kortix app component.

Forbidden in `content/docs/**`:

- any `@/components/*` import, including `@/components/markdown/docs-card`
- any `@/lib/icons/ssr` Phosphor icon
- any React island that imports app code
- the `KortixLogo` React component

The docs logo is a static SVG file referenced from `blume.config.ts`. It is not
a React import. `apps/web/public/kortix-symbol.svg` and
`apps/web/public/kortix-logomark-white.svg` already exist and are used as-is.

Every construct a docs page needs already exists as a Blume built-in that
requires no import. A page that appears to need an app component is a signal to
change the page, not to break this rule.

## 3. Current state, measured

| Item | Value |
|---|---|
| Content | 33 `.mdx` under `apps/web/content/docs`, 7 `meta.json` |
| Route | `app/docs/[[...slug]]/page.tsx`, `app/docs/layout.tsx` |
| Files with MDX imports | 25 of 33 |
| `<Callout>` | 26 total: 17 `type="warn"`, 8 `type="info"`, 1 untyped |
| `<Step>` / `<Steps>` | 46 / 13 |
| `<Card>` / `<Cards>` | 37 / 8, across 25 distinct Phosphor icons |
| Prod hosting | Vercel, `prod` branch to kortix.com |
| Dev and self-host | Next standalone in Docker |

### Coupled Next surfaces

These read `content/docs/**/*.mdx` from disk through
`sourceDocuments()` at `src/lib/seo/public-content.ts:549`. That function parses
frontmatter itself and never touches the fumadocs `.source` codegen, so it
survives the migration.

`/sitemap.xml`, `/llms.txt`, `/llms-full.txt`, `/markdown/[...path]`,
`/markdown-negotiation`, `/mcp`, `/api/ai`, `src/lib/seo/coverage-manifest.ts`.

`/api/search` is the exception. It imports `@/lib/source` and is deleted.

## 4. Architecture

```
apps/web/
  content/docs/*.mdx          unchanged path
  blume.config.ts             new
  theme.css                   new, logo and accent only
  scripts/blume-docs.mjs      new, runs `blume build`, copies dist to public/docs
  public/docs/                generated, gitignored
  next.config.ts              + build hook, + 2 rewrites
```

### Runtime resolution

`rewrites()` at `next.config.ts:477` returns a flat array. Next applies a flat
array as `afterFiles`, which runs after the `public/` filesystem check. Two
entries are appended. No restructuring.

| Request | Resolution |
|---|---|
| `/docs/_astro/app.css` | file exists in `public/`, served directly, rewrites do not fire |
| `/docs/quickstart` | no file, rewrite to `/docs/quickstart/index.html` |
| `/docs` | a directory is not a file, rewrite to `/docs/index.html` |
| `/docs/nope` | rewrite, target missing, Next 404 in app chrome |

### Build wiring

Vercel runs the bare `next build` command from `vercel.json:2`. It never invokes
an npm script. This is documented at `scripts/generate-fumadocs-source.mjs:8`.
A Blume build placed only in `package.json` would produce no docs on
kortix.com.

The build therefore runs as a module side effect of `next.config.ts`, following
the existing pattern at `next.config.ts:26-92`: run the generator, verify the
outputs exist in `public/`, throw when they are missing, warn and continue when
regeneration fails but the outputs are already present. The last case is the
slim prod image, which ships a populated `public/` without the source
`node_modules`.

The build is conditional. `blume build` takes 30 to 60 seconds and must not run
on `next dev`.

### Dev mode

`pnpm dev` runs `blume dev --port 13401` beside Next. Port 13401 sits beside the
docs worktree's web port 13400.

The `/docs/:path*` rewrite becomes a proxy to that port. It is env-gated on
`KORTIX_BLUME_DEV_TARGET`, exactly like the Supabase proxy at
`next.config.ts:508`: unset means the rule is not emitted at all, so production
and any developer who does not run `blume dev` are untouched and keep serving
the static `public/docs/` build.

Authors keep hot reload. `blume build` runs only when
`process.env.NEXT_PHASE === 'phase-production-build'`.

## 5. Content migration

33 files. Mechanical, one to one. A codemod does the bulk, then each file is
reviewed by hand.

### Component mapping

| fumadocs | Blume | Count |
|---|---|---|
| `<Callout type="warn">` | `:::warning` | 17 |
| `<Callout type="info">` | `:::info` | 8 |
| `<Callout>` | `:::note` | 1 |
| `<Steps>` / `<Step>### Title` | `<Steps>` / `<Step title="...">` | 13 / 46 |
| `<Cards>` / `<Card icon={<XIcon/>}>` | `<CardGroup>` / `<Card icon="x">` | 8 / 37 |
| top-of-file `import` lines | deleted | 25 files |
| `meta.json` | `meta.ts` with `defineMeta` | 7 |

### Icon mapping

All 25 Phosphor icons become Lucide name strings. No icon import survives.

| Phosphor | Lucide | | Phosphor | Lucide |
|---|---|---|---|---|
| `TerminalIcon` | `terminal` | | `UsersIcon` | `users` |
| `RobotIcon` | `bot` | | `ShareNetworkIcon` | `share-2` |
| `PlugsConnectedIcon` | `cable` | | `ScrollIcon` | `scroll` |
| `PathIcon` | `route` | | `RocketIcon` | `rocket` |
| `KeyIcon` | `key` | | `GitPullRequestIcon` | `git-pull-request` |
| `GitBranchIcon` | `git-branch` | | `FlagIcon` | `flag` |
| `DesktopIcon` | `monitor` | | `FileTextIcon` | `file-text` |
| `CubeIcon` | `box` | | `CpuIcon` | `cpu` |
| `ChatsIcon` | `messages-square` | | `CodeIcon` | `code` |
| `BrainIcon` | `brain` | | `CloudIcon` | `cloud` |
| `AlarmIcon` | `alarm-clock` | | `ClipboardTextIcon` | `clipboard-list` |
| `BrowserIcon` | `app-window` | | `BookOpenIcon` | `book-open` |
| `AtomIcon` | `atom` | | | |

### Codemod safety rule

Fenced code blocks contain lines such as
`import { createKortix } from '@kortix/sdk'`. These are example source, not MDX
imports. The codemod only removes `import` lines that appear above the first
content line and outside any fence. Every file is diffed by hand afterwards.

### Two `meta.json` features with no direct equivalent

1. `"---Develop---"` in `content/docs/meta.json` is a fumadocs sidebar
   separator. Blume has no divider primitive. The candidates are a header tab
   (`navigation.tabs`) or a nested group. This is decided by looking at a
   rendered `blume dev` build during the navigation phase, not on paper. The
   implementation plan must carry it as an explicit, blocking sub-task rather
   than an assumption.
2. `"[API reference](https://api.kortix.com/v1/docs)"` is an external sidebar
   link. Blume supports `{ label, href }` entries in explicit navigation config.

## 6. Deletions and retentions

### 6.1 Deleted

- `src/app/docs/**` — 5 source files, 3 test files
- `src/lib/source.ts`
- `src/app/api/search/route.ts`
- `src/components/markdown/docs-mdx-components.tsx` and its test
- `src/components/markdown/docs-card.tsx` and its test
- `src/components/markdown/docs-mermaid.tsx`
- `content/docs/card-icons.test.ts`
- the `fumadocs-ui` import in `src/app/globals.css`
- the `fumadocs-ui` dependency in `package.json`

`fumadocs-ui` is docs-only. The files above are its only importers.
`src/lib/seo/public-content.test.ts:144` also matches a `fumadocs-ui` grep, but
that line sits inside a template-literal MDX fixture, not a module import. The
fixture is rewritten, not deleted. See §6.3.

### 6.2 Retained

`fumadocs-core` and `fumadocs-mdx` stay. `src/lib/use-cases-source.ts`,
`source.config.ts`, and `createMDX()` in `next.config.ts` still need them.
`source.config.ts` loses only its `docs` export; its `useCases` collection is
untouched. `src/lib/code-theme.ts` stays.

`src/components/markdown/code/*` stays. It is shared with the app's markdown
renderer, not exclusive to docs.

### 6.3 Updated

`renderPlainMarkdownFromMdx()` in `src/lib/seo/public-content.ts` must learn
`:::` container directives and `<CardGroup>`, so `/markdown/docs/*.md` and
`/llms-full.txt` keep emitting clean markdown. `sourceDocuments()` itself needs
no change — it parses frontmatter only.

`src/lib/seo/public-content.test.ts` is updated in two places:

1. The MDX fixture at line 144 moves from
   `import { Callout } ...` plus `<Callout type="warn" title="Keep this warning">`
   to `:::warning[Keep this warning]`. Its existing assertions
   (`> **Keep this warning**`, `> Do not drop this meaningful content.`) must
   still pass, unchanged. They are the contract for the directive transform.
2. No other change. The suite's own guard does the rest.

That guard is `expectCleanAgentMarkdown()`, asserted over **every** public
markdown record by the test named `all public Markdown outputs contain no
unresolved MDX module syntax or JSX`. If the transform fails to learn `:::` or
`<CardGroup>`, raw syntax leaks into agent-facing markdown and this test fails
loudly across all 33 docs pages. It is the migration's strongest existing safety
net and must stay green at every step.

`blume.config.ts` disables Blume's own `llms.txt`, MCP server, and sitemap.
Next remains the single source for those across marketing, blog, and docs.

### 6.4 Replaced

Search moves from `/api/search` plus the fumadocs dialog to Blume's built-in
client-side index. This keeps the property documented at
`src/app/docs/layout.tsx:36`: the index is fetched once and queried in the
browser, with no API key and no per-keystroke round trip.

## 7. Bugs fixed in passing

1. `next.config.ts:413-419` redirects `/docs/self-hosting` and `/docs/self-host`
   to `/docs/guides/self-hosting`. `content/docs/guides/` does not exist. Both
   redirects return 404 today. The self-host content is at `/docs/host`. Both
   redirects are repointed.
2. `blume validate --strict` is added as a CI gate. It checks every internal
   link across the docs tree. fumadocs provided no equivalent.

## 8. Verification

All three tiers are required, per `CLAUDE.md`.

**Local.** Run `blume build`. Assert all 33 docs URLs return 200 with the
expected `<title>`. Assert `/docs/_astro/*` assets serve. Assert `/llms.txt` and
`/markdown/docs/quickstart.md` still contain docs records. Run
`blume validate --strict`. Run `pnpm test` and `tsc --noEmit`.

**Preview.** Open a draft PR against `main` on the first commit and apply the
`preview` label. Drive the real `/docs` on the preview origin with Playwright:
navigate, search, click through the sidebar, assert DOM and network. Run
`blume audit --url <preview-origin>`.

**Dev.** After an explicit merge instruction, follow the Deploy Dev run to
completion, confirm the deployed artifact contains the merged SHA, then verify
`dev.kortix.com/docs` serves the Blume build.

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Astro `base` output layout is unverified: `dist/` or `dist/docs/` | blocks the copy step | Phase 0 probe. The copy step handles either. **This is the one untested assumption in this design.** |
| Web build time grows 30 to 60 seconds | slows every deploy | Measured in Phase 0. If worse than 60s, fall back to a separate Blume deployment behind a proxy rewrite. |
| Stock Blume theme reads as foreign next to kortix.com | cosmetic | Accepted by D3. Tracked as a follow-up, not a blocker. |
| Blume 1.6.0 was published 2026-09-04 | new package, possible churn | Pin the exact version. No caret range. |
| The `---Develop---` separator has no equivalent | sidebar shape changes | Decided against a rendered build, not on paper. |

## 10. Out of scope

- `/use-cases`, which stays on fumadocs
- a Kortix-branded Blume theme
- docs content rewrites beyond the mechanical component conversion
- i18n, versioning, and Blume's Ask AI assistant
