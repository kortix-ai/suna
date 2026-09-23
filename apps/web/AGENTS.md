<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Customer data

Never write customer names, people's names, emails, or real prod IDs into code,
commits, PRs, docs, or comments. The full rule and the commit guard are in the
root `AGENTS.md` → "NEVER write customer data or PII".

## Translation catalogs

`translations/<locale>.json` keep their keys in the order they were added, in
canonical `JSON.stringify(value, null, 2)` form. Add a key next to its
neighbours with a text edit; never rewrite a catalog through a program that
rebuilds its objects. A catalog merge conflict is resolved by the merge driver
(`scripts/i18n-catalogs.mjs`, registered by `pnpm install`): run
`git checkout -m translations/<locale>.json`, not a script. Before pushing,
`node scripts/i18n-catalogs.mjs check --base=origin/main` must pass. Details:
`CONTRIBUTING.md` → "Translation catalogs".
