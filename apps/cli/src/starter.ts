/**
 * Kortix project scaffold — what `kortix` writes into a fresh project repo.
 *
 * Layout matches the SPEC §3.3 and OpenCode's native expectations:
 *
 *   kortix.toml                       project manifest (name, env requirements)
 *   CONTEXT.md                        project-wide working context
 *   README.md                         readme for the repo
 *   .opencode/opencode.jsonc          OpenCode runtime config
 *   .opencode/agents/<name>.md        agent personas
 *   .opencode/commands/<name>.md      slash-command templates
 *   .opencode/skills/<name>/SKILL.md  on-demand instructions
 *
 * Everything sits at the repo root — the whole repo IS the Kortix project,
 * so a `.kortix/` namespace would only add nesting. OpenCode reads
 * `.opencode/` natively, no env-var override required.
 */

export interface StarterFile {
  /** Repo-relative path (no leading slash). */
  path: string;
  /** UTF-8 content. */
  content: string;
}

export interface StarterInput {
  /** Project name written into kortix.toml + READMEs. */
  projectName: string;
}

const README = (i: StarterInput) => `# ${i.projectName}

A Kortix project — OpenCode-native, git-versioned.

## What's here

\`\`\`
kortix.toml                         project manifest (name, env requirements)
CONTEXT.md                          project-wide context every agent reads
.opencode/
  opencode.jsonc                    OpenCode runtime config
  agents/
    default.md                      primary agent — hands-on, does work
    reviewer.md                     subagent — read-only code review
  commands/
    plan.md                         /plan <ask> → planning template
    test.md                         /test → run the test suite
  skills/
    git-workflow/
      SKILL.md                      on-demand: branch + commit conventions
\`\`\`

## How sessions work

Every session you start on Kortix is its own isolated sandbox — a fresh VM
with this repo cloned onto its own git branch (named after the session
UUID). OpenCode runs inside, reading \`.opencode/\` for agents, skills,
and commands. The branch is yours to merge back into your default branch
when you're done.

## Editing

- **Agents** → \`.opencode/agents/*.md\` — markdown with YAML frontmatter (\`mode\`, \`description\`, \`permission\`, optional \`model\`).
- **Commands** → \`.opencode/commands/*.md\` — slash-commands. Body is a prompt template; supports \`$ARGUMENTS\`, \`$1\`, \`!\`cmd\`\`, \`@path\`.
- **Skills** → \`.opencode/skills/<name>/SKILL.md\` — on-demand instructions loaded by agents via the \`skill\` tool.
- **Config** → \`.opencode/opencode.jsonc\` — providers, default agent, permissions, MCP, plugins.

Commit your edits — every new session picks them up on clone.
`;

const KORTIX_TOML = (i: StarterInput) => `# Kortix project manifest.
# Source of truth for project-wide config that lives in git. Sessions
# clone this repo at boot and read this file plus .opencode/ to
# bootstrap their runtime.

[project]
name = "${i.projectName}"
description = "A Kortix project."

# Env vars the runtime needs. Required values must be set in the Kortix
# Secrets Manager before a session can start.
[env]
required = []
optional = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
`;

const OPENCODE_JSONC = () => `{
  // OpenCode runtime config — the file OpenCode reads when it boots inside
  // a session sandbox. Docs: https://opencode.ai/docs/
  "$schema": "https://opencode.ai/config.json",
  "theme": "system",
  "default_agent": "default",
  "permission": {
    "edit": "allow",
    "bash": "ask",
    "webfetch": "allow"
  },
  "provider": {
    "anthropic": {
      "npm": "@ai-sdk/anthropic",
      "env": ["ANTHROPIC_API_KEY"],
      "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" }
    },
    "openai": {
      "npm": "@ai-sdk/openai",
      "env": ["OPENAI_API_KEY"],
      "options": { "apiKey": "{env:OPENAI_API_KEY}" }
    }
  }
}
`;

const AGENT_DEFAULT = (i: StarterInput) => `---
description: Default agent for ${i.projectName}. Hands-on, does the work, plans before acting, verifies after.
mode: primary
permission:
  read: allow
  edit: allow
  write: allow
  glob: allow
  grep: allow
  list: allow
  bash: ask
  skill: allow
  webfetch: allow
  websearch: allow
  todowrite: allow
---

You are the default agent for **${i.projectName}**.

## Your shape

- You operate inside an isolated session sandbox. The project repo is
  cloned to your workspace on a branch named after the session UUID.
- Anything you commit + push lands as a real branch on the project repo
  that the user can review and merge.
- \`CONTEXT.md\` is your project-wide working knowledge — read it first
  when starting a non-trivial task.
- Spin up the **reviewer** subagent with \`@reviewer\` when you want a
  read-only second look at a diff.

## How you work

1. **Plan first.** Outline your approach before touching files. For
   anything non-trivial, write the plan to your todo list.
2. **Read before write.** Inspect existing code paths before changing
   them.
3. **Test what you ship.** Verify changes work end-to-end before
   declaring done — \`pnpm test\`, \`pytest\`, \`go test\`, whatever fits.
4. **Commit small, meaningful chunks.** Each commit leaves the repo in a
   working state with a clear "why" in the message. Use the
   \`git-workflow\` skill if you need a refresher on conventions.
5. **Don't half-ship.** If you hit a blocker, surface it with what you
   tried and what's needed — don't paper over it.

## Tone

Direct. Concrete. Cite file paths + line numbers when referencing code.
No filler.
`;

const AGENT_REVIEWER = () => `---
description: Read-only code reviewer subagent. Inspects diffs and flags security, correctness, and maintainability issues. Cannot edit or run bash.
mode: subagent
permission:
  read: allow
  glob: allow
  grep: allow
  edit: deny
  write: deny
  bash: deny
---

You are a **code reviewer**. You are invoked via \`@reviewer\` to give a
second look at changes the primary agent is about to commit.

## What you do

- Read the proposed diff (the primary will paste it or you can run
  \`git diff\` if bash were allowed — it isn't, so rely on the diff
  shared with you).
- Flag: security holes, correctness bugs, broken invariants, missing
  null/error handling, performance regressions, untested edge cases,
  drift from existing conventions in the repo.
- Suggest concrete fixes — not just "this could be better."
- If the diff is fine, say so plainly. Don't invent issues.

## Format

Use this output shape:

\`\`\`
SECURITY
  - <issue> — <file:line> — <suggested fix>

CORRECTNESS
  - …

NITS
  - …

VERDICT: approve | request changes | block
\`\`\`

If there are zero issues in a category, omit the section.
`;

const COMMAND_PLAN = () => `---
description: Planning template — outlines an approach without touching code
agent: default
---
Plan the following task. Do **not** edit files yet — produce a written
plan only.

**Task:** $ARGUMENTS

Output sections:

1. **Goal** — one sentence stating the deliverable.
2. **Files to inspect** — concrete paths you'll read first.
3. **Approach** — numbered steps; flag any irreversible operations.
4. **Risks** — what could go wrong, edge cases, things to verify.
5. **Verification** — how you'll prove it works (test command, manual
   check, etc.).

Be concrete. Cite real file paths from the repo.
`;

const COMMAND_TEST = () => `---
description: Run the project test suite and analyze failures
agent: default
---
Run the test suite for this project. Choose the right command based on
what's in the repo:

- Node/TS  : \`pnpm test\` / \`npm test\` / \`bun test\`
- Python   : \`pytest\` / \`uv run pytest\`
- Go       : \`go test ./...\`
- Rust     : \`cargo test\`

If any tests fail, analyze the output and propose a fix. Do not commit
fixes — return the proposed diff for review.
`;

const SKILL_GIT_WORKFLOW = () => `---
name: git-workflow
description: Branch naming, commit message conventions, and PR creation rules for this project
license: MIT
compatibility: opencode
---

# Git workflow

## Branch naming

- The session you're in is already on its own UUID-named branch — that's
  fine for in-session work.
- If you create additional branches manually, use:
  - \`feat/<short-name>\` — new functionality
  - \`fix/<short-name>\` — bug fixes
  - \`chore/<short-name>\` — tooling, refactors, deps
  - \`docs/<short-name>\` — docs-only changes

## Commit messages

\`<type>: <imperative one-liner>\` where type ∈ \`feat | fix | chore | docs | refactor | test\`.

Examples:
- \`feat: add health-check endpoint\`
- \`fix: handle empty response from /v1/users\`
- \`refactor: extract auth middleware into shared module\`

Body (optional) explains the **why**, not the what. The diff already
shows the what.

## Atomic commits

Each commit should leave the repo in a working state:
- Tests pass at every commit.
- One logical change per commit.
- Don't mix formatting + functional changes.

## Opening a PR

When the session work is ready to land:

\`\`\`sh
gh pr create \\
  --title "<type>: <short summary>" \\
  --body "$(cat <<'EOF'
## What
<one paragraph>

## Why
<one paragraph>

## How
<bulleted list of major changes>

## Test plan
- [ ] <step>
- [ ] <step>
EOF
)"
\`\`\`

The session's UUID branch becomes the PR source; the default branch is
the target.
`;

const CONTEXT_MD = (i: StarterInput) => `# ${i.projectName} — context

Working knowledge every agent should keep in mind for tasks in this
project. Edit freely.

## What this project is

_(One paragraph stating the goal. Replace this with your own.)_

## Stack & key paths

_(List the language(s), framework(s), and the 3–5 directories an agent
should know about before doing real work.)_

## Conventions

- _(Code style, naming, file structure rules.)_
- _(Testing conventions — where tests live, how they run.)_

## Out of scope

_(Optional — things agents should not touch without explicit ask.)_
`;

export function buildStarterFiles(input: StarterInput): StarterFile[] {
  return [
    { path: 'kortix.toml', content: KORTIX_TOML(input) },
    { path: 'CONTEXT.md', content: CONTEXT_MD(input) },
    { path: '.opencode/opencode.jsonc', content: OPENCODE_JSONC() },
    { path: '.opencode/agents/default.md', content: AGENT_DEFAULT(input) },
    { path: '.opencode/agents/reviewer.md', content: AGENT_REVIEWER() },
    { path: '.opencode/commands/plan.md', content: COMMAND_PLAN() },
    { path: '.opencode/commands/test.md', content: COMMAND_TEST() },
    { path: '.opencode/skills/git-workflow/SKILL.md', content: SKILL_GIT_WORKFLOW() },
  ];
}

export function topLevelReadme(input: StarterInput): StarterFile {
  return { path: 'README.md', content: README(input) };
}

export function gitignoreFile(): StarterFile {
  return {
    path: '.gitignore',
    content: `# OpenCode runtime state
.opencode/sessions/
.opencode/log/
.opencode/cache/

# OS / editor
.DS_Store
`,
  };
}
