# Agent setup for `suna`

This is a deepsec scanning workspace. Project `suna` was just registered
(target: `..`). Setup is incomplete — `data/suna/INFO.md`
still has placeholder sections.

## What to do

1. **Read the deepsec skill.** After `pnpm install`, the file is at
   `node_modules/deepsec/SKILL.md`. It maps every doc topic to a file
   under `node_modules/deepsec/dist/docs/`. Read `getting-started.md`,
   `configuration.md`, and `writing-matchers.md` (skim the rest).

2. **Fill in `data/suna/INFO.md`.** It's auto-injected into the AI
   prompt for every batch — keep it short and selective.

   **Length budget: 50–100 lines total.** Verbose context dilutes
   signal in the scanner's prompt window. The goal is "what would a
   reviewer miss if they didn't read this?", not exhaustive enumeration.

   **Per-section rubric**:
   - Pick 3–5 representative items per section. **Don't list every
     file, helper, or callsite** — pick the patterns.
   - Name primitives by their public name (e.g. `withAuthentication`,
     `auth.can()`, `isTeamAdmin`). **No line numbers.** Don't enumerate
     more than 5 paths in any list.
   - Skip generic CWE categories — built-in matchers already cover
     "SSRF", "SQL injection", "XSS". Cover what's *project-specific*:
     internal auth helpers, custom middleware names, fork-specific
     stubs, intended-public endpoints.
   - One short paragraph or 3–5 short bullets per section. Not both.

   Source material (read in this order, stop when you have enough):
   - `../README.md`
   - any `AGENTS.md` / `CLAUDE.md` in `..`
   - `../package.json` (or `go.mod`, `pyproject.toml`, etc.)
   - 5–10 representative code files (entry points, auth helpers) — not
     a full code tour.

3. **(Optional) Add custom matchers** for repo-specific patterns the
   built-in matchers won't catch. Read
   `node_modules/deepsec/dist/docs/writing-matchers.md` first; the
   workflow there starts from a confirmed finding and grows the matcher
   from it. Don't add matchers speculatively — wait for a real TP.

## When you're done

The user will run:

```bash
pnpm deepsec scan    --project-id suna
pnpm deepsec process --project-id suna
```

You can delete this file once setup is complete.
