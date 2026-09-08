# Blume Phase 0 probe findings

- Date: 2026-09-05
- Blume version: 1.6.0
- Node version: v22.22.3

| Fact | Value |
|---|---|
| PROBE_DIST_LAYOUT | flat |
| PROBE_BUILD_SECONDS | 3 |
| PROBE_ASSET_PREFIX | /docs/_astro/ |

## Decision gate

PROBE_BUILD_SECONDS (3) is not greater than 60. No stop required; the probe
clears the decision gate.

## How the values were produced

- `blume init` command that worked, verbatim, no flags rejected:

  ```
  npx blume init . --yes --template docs --content-dir docs --package-manager npm
  ```

- `deployment.base: "/docs"` in `blume.config.ts` was accepted as-is — it was
  not an unknown key. `npx blume build --base` was never needed.

- The three copied pages (`docs/index.mdx`, `docs/quickstart.mdx`,
  `docs/sdk/index.mdx`) were simplified to plain markdown. Stripping only the
  top-of-file fumadocs `import` lines was not enough: the first build attempt
  failed with `Error: Expected component Cards to be defined: you likely
  forgot to import, pass, or provide it.` because the pages also use
  fumadocs-only JSX components (`<Cards>`, `<Card icon={...}>`, `<Steps>`,
  `<Step>`) that Blume does not ship. Per the task's ambiguity resolution,
  these JSX blocks were removed, leaving frontmatter + prose + headings +
  fenced code blocks only. This measures Blume's output layout and build
  time, not fumadocs-component fidelity — real content migration is a later
  task's problem.

- `time npx blume build` (bash, labeled output), on the simplified 3-page
  project with `deployment.base: "/docs"` set:

  ```
  real	0m2.602s
  user	0m4.284s
  sys	0m1.382s
  ```

  PROBE_BUILD_SECONDS is `real` rounded to the nearest integer: 3.

- Layout check (`dist/` listing + presence of `dist/docs`):

  ```
  ls dist
  404.html  _astro  _headers  agent-readability.json  blume-search.json
  index.html  index.md  index.mdx  llms-full.txt  llms.txt
  quickstart  quickstart.md  quickstart.mdx  robots.txt  sdk  sdk.md  sdk.mdx

  [ -d dist/docs ] -> false -> FLAT
  ```

  Pages land at `dist/index.html`, `dist/quickstart/index.html`,
  `dist/sdk/index.html` — flat, matching the spec's expected layout.

- Asset prefix (`grep` for `href=`/`src=` containing `_astro` in
  `dist/index.html`):

  ```
  src="/docs/_astro/ClientRouter.astro_astro_type_script_index_0_lang.Cdo-SagO.js"
  href="/docs/_astro/fonts/e868cdf4720e9ea5.woff2"
  href="/docs/_astro/fonts/45f5561f938fa232.woff2"
  ```

  Prefix is `/docs/_astro/`, matching the spec's expectation exactly.
