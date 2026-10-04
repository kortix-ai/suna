---
recorded: 2026-10-01T04:34:08Z
incident_date: 2026-10-01
---
# Quote any docs frontmatter value that contains a colon; next dev never parses it, only next build does

**Rule:** Quote a docs frontmatter value that contains `: ` (`description: "A: b"`). Before merging a change under `apps/web/content/docs/`, run `pnpm --filter ./apps/web run docs:build` or the unit test below: the local stack (`next dev`) never runs Blume.

**Trigger surface:** editing `title:` or `description:` in any `apps/web/content/docs/**/*.mdx` frontmatter, including copy sweeps that rewrite one-line descriptions.

**Incident:** 2026-10-01, #8567 (brand kit copy sweep) changed the docs index description to `Open-source AI Management System: your agents, …` unquoted. Blume failed inside `next build` ("bad indentation of a mapping entry"), `Build frontend image` failed in Deploy Dev run 36814528587, and dev web stayed on the previous commit for about 25 minutes, blocking 3 other PRs' web changes. Fixed forward by #8572 (9f3a0d75ef).

**Enforcement:** `tests/unit/docs-frontmatter.test.ts` parses every docs page's frontmatter with `Bun.YAML` in the default `pnpm test`. Verified red on the old line, green on the fix.
