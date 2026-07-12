---
name: create-skill
description: "Author or edit an Agent Skill that follows the agentskills.io spec — the SKILL.md frontmatter and body, plus optional scripts/, references/, and assets/. Use when the user wants to create a new skill, turn a repeatable workflow into reusable know-how, edit an existing skill (its name, description, instructions, or any frontmatter field), restructure or split a skill, validate one, or package one for sharing or for the Kortix marketplace."
defaultProjectInstall: true
---

# Create Skill

A skill is reusable know-how, written down once so every future session can load it on demand instead of rediscovering the workflow from scratch. This skill teaches you to author one to the **agentskills.io specification** and land it in a Kortix project the right way.

## When to use this skill

Reach for it when the user asks you to:

- Capture a workflow they keep re-explaining ("make this a skill", "remember how we do X")
- Create, scaffold, or set up a new skill
- Edit an existing skill — rename it, sharpen its description, rewrite its instructions, or change any frontmatter field
- Restructure a skill that has grown too large, or split detail out into reference files
- Validate a skill or prepare it for sharing / the marketplace

First, though: **search the Kortix marketplace before you build.** A skill that already exists is better than one you write. Run `kortix marketplace search "<topic>" --json`, inspect the close matches with `kortix marketplace show <name> --json`, and only author something new when nothing covers the need. (See the `kortix-system` skill's marketplace reference for the full flow.)

## Anatomy of a skill

A skill is a **directory** with a `SKILL.md` at its root. Everything else is optional and added only when it earns its place:

```
my-skill/
├── SKILL.md       (required) — frontmatter + instructions
├── scripts/       (optional) — executables for repetitive, deterministic work
├── references/    (optional) — deep docs the agent reads only when needed
└── assets/        (optional) — templates, sample files, images the skill emits
```

Most skills are a single `SKILL.md`. Add bundled folders only when there's real repetition to script, reference material too long to inline, or templates the skill reuses verbatim — anything an agent would otherwise rebuild on every run.

## Where skills live in Kortix

In a Kortix project, skills go under the OpenCode config dir:

```
.kortix/opencode/skills/<name>/SKILL.md
```

The directory name **must equal** the `name` in the frontmatter. At runtime, OpenCode also discovers skills from `.opencode/skills/`, `.claude/skills/`, and `.agents/skills/` (project and home directory). For a Kortix project, author under `.kortix/opencode/skills/` — that's the canonical home and what the marketplace installs into.

OpenCode lists every discovered skill in the `skill` tool description and loads the body on demand when the agent calls it. Two consequences worth internalizing:

- **The description is the trigger.** The agent decides whether to load a skill from its `name` + `description` alone. A vague description means the skill never fires.
- **A new skill reaches future sessions only after a change request merges.** Writing the file on a session branch makes it available *to that session*; to make it permanent for the project, commit, push, and open a CR (`kortix cr open`). See the `kortix-system` skill.

## The SKILL.md file

Two parts, in this order, with nothing before them: a YAML frontmatter block fenced by `---`, then the markdown body.

```markdown
---
name: my-skill
description: "What this skill does and the exact situations that should trigger it."
---

# Skill Title

## When to use this skill
The scenarios where this skill applies — be concrete.

## Instructions
Step-by-step guidance another agent can follow without guessing.

## Examples
Representative inputs and the output they should produce.
```

> **Hard rule:** the very first characters of the file are `---`. No title, no comment, no blank line before the frontmatter — the loader rejects it otherwise.

### Frontmatter fields

Only these keys are recognized; anything else is ignored by the runtime and rejected by spec validators:

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Must match the directory name. Rules below. |
| `description` | yes | 1–1024 chars. The discovery trigger — make it earn the load. |
| `license` | no | e.g. `MIT`, `Apache-2.0`. |
| `compatibility` | no | Environment requirements, ≤500 chars. |
| `metadata` | no | A string-to-string map for any extra key-value data. |
| `allowed-tools` | no | Space-delimited pre-approved tool list (experimental). |

**`name` rules** — enforced by the regex `^[a-z0-9]+(-[a-z0-9]+)*$`:

- 1–64 characters, lowercase alphanumeric and single hyphens only
- No leading/trailing hyphen, no consecutive `--`
- Must match the containing directory exactly, and be unique among the project's skills
- Good: `release-notes`, `competitor-teardown`, `invoice-parse` — Bad: `-draft`, `My_Skill`, `pdf--merge`

**`description` craft** — this is where most skills succeed or fail:

- Say *what it does* **and** *when to fire it*. Pack in the trigger phrases a user would actually type.
- "Use when the user shares a contract, MSA, NDA, or asks to review legal terms" beats "Handles legal docs."
- **Always wrap the value in double quotes.** Descriptions routinely contain `:`, `#`, `[`, `{`, a leading `-`, or words like `yes`/`no`/`null` that YAML reads as special. Quoting is always safe — when in doubt, quote.

**Custom data goes under `metadata`, never at the top level:**

```yaml
metadata:
  version: "1.0"
  owner: revops
```

## Authoring workflow

1. **Pin down the job.** What should the skill accomplish, and what user phrasing should summon it? The answers become the body and the description.
2. **Name it.** Pick a descriptive name that obeys the rules and doesn't collide with an existing skill.
3. **Write the description first.** It's the highest-leverage line in the file. Get the triggers in.
4. **Write instructions an agent can follow blind.** Imperative, ordered, specific. Prefer concrete commands and decision rules over prose.
5. **Create the files.** `.kortix/opencode/skills/<name>/SKILL.md`, frontmatter starting on line 1. Add `scripts/`, `references/`, or `assets/` only if the skill genuinely needs them.
6. **Validate** (below).
7. **Land it** via a change request, and/or package it for sharing (below).

## Keep SKILL.md lean

Treat `SKILL.md` as the always-loaded core and push depth outward. Aim to keep it **under ~500 lines**. When it grows, move long procedures, schemas, or background into `references/*.md` and link to them with a one-line note on *when* to read each — for example: "For the full field-by-field schema, read `references/schema.md`." The agent then pulls detail only when the task demands it, keeping context lean. This progressive-disclosure split is also what lets one skill carry a lot of know-how without bloating every invocation.

## Validate

Two complementary checks — do both:

1. **Spec validation.** If the `agentskills` validator is available, point it at the skill **directory** (not a single file, not a zip) once every file is in place:

   ```bash
   agentskills validate .kortix/opencode/skills/<name>/
   ```

   Read any error and fix it before moving on. Don't validate mid-authoring — wait until the files are final.

2. **Runtime check.** In the Kortix/OpenCode runtime, the real test is discovery: confirm `SKILL.md` is spelled in all caps, the frontmatter has both `name` and `description`, the name matches the directory, and the name is unique. When those hold, the skill shows up in the `skill` tool's `<available_skills>` list and can be loaded. If it doesn't appear, re-check those four things and any `permission.skill` deny rules in `opencode.json`.

## Make it land and shareable

- **Persist it in the project.** A skill file on a session branch is gone when the session ends. To make it permanent: commit, `git push origin HEAD`, then `kortix cr open --title "Add <name> skill" --description "..."`. It reaches future sessions only after the CR merges to `main`.
- **Share or publish it.** A skill is shared as a single file or archive, never as a raw directory path:
  - SKILL.md only, no bundled folders → share the `SKILL.md` directly.
  - Any `scripts/`, `references/`, or `assets/` → zip the **whole** directory (`.zip`, not tar). The bundled files are part of the skill; don't strip them.
  - Stay within **100 files** and **70 MB**.
- **For reuse across projects**, move the skill into a marketplace/registry source and index it there, so other projects can `kortix marketplace install` it instead of copy-pasting. (Registry *authoring* commands — `kortix registry build/validate` — are developer tools, distinct from the consumer `kortix marketplace` surface.)

## Worked example: a "release-notes" skill

```markdown
---
name: release-notes
description: "Draft release notes and a changelog entry from merged work. Use when the user asks to write release notes, summarize what shipped, prep a changelog, or announce a version."
license: MIT
---

# Release Notes

## When to use this skill
Use when the user wants release notes, a changelog entry, or a "what shipped" summary for a version or a range of merged work.

## Instructions
1. Gather the merged changes in scope (a tag range, a milestone, or an explicit list).
2. Group them into Added / Changed / Fixed / Removed.
3. Write each line in the imperative, user-facing voice — the benefit, not the diff.
4. Lead the summary with the single most important change.
5. Emit two artifacts: a short announcement paragraph and a structured changelog block.

## Examples
Input: "release notes for v2.4 — we added SSO, fixed the CSV export bug, dropped the legacy API."
Output: an announcement paragraph plus a grouped changelog with those three entries.
```

## Common errors and how to fix them

**"SKILL.md must start with YAML frontmatter (---)"** — Something precedes the opening `---`: a title, a comment, or a blank line. The first byte of the file must be `-`.

**"invalid YAML in frontmatter" (e.g. "mapping values are not allowed here")** — The `description` (or another value) contains a YAML-special character — most often `:`, but also `#`, `[`, `{`, a leading `-`, or `yes`/`no`/`null`. Wrap the value in double quotes.

**Invalid name** — Breaks the `^[a-z0-9]+(-[a-z0-9]+)*$` rule, doesn't match the directory, or duplicates an existing skill. Check the project's existing skill names before settling on one.

**"Unexpected fields in frontmatter"** — A non-allowed key sits at the top level. Only `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools` are permitted there; nest everything else under `metadata`.

**Skill never triggers** — The file is valid but the agent never loads it. The description is too vague or missing the words a user would actually type. Rewrite it around concrete trigger phrases.
