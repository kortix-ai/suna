---
name: codex-cli
description: Drive OpenAI's Codex CLI (`codex exec`) as a non-interactive coding sub-agent from inside Claude Code. Load WHENEVER you want to delegate a coding/analysis/refactor task to Codex, get a second opinion / adversarial review from another model, fan out parallel agents across files or worktrees, or run a long mechanical job while you stay the planner. Covers the exact `codex exec` flags, sandbox tiers, output capture, JSON/schema modes, session resume, parallel fan-out, and the mandatory "delegate → capture → independently verify, never trust the self-report" supervision loop.
---

<skill name="codex-cli">

<overview>
Codex CLI is OpenAI's terminal coding agent (Rust). Its **non-interactive** mode,
`codex exec`, makes it a perfect disposable sub-agent: you write the metaprompt,
Codex explores/edits/runs commands on its own, and returns a final message you
capture and verify. You stay the long-context planner; Codex is the executor.

The golden rule: **Codex's self-report is a claim, not the truth.** Always
capture its output, then independently verify the artifacts yourself (read the
files, re-run the tests) before treating the task as done.

Verified available on this machine: `codex-cli 0.137.0`, logged in via ChatGPT
(no API key needed). Confirm with `codex login status`.
</overview>

<the-core-command>
The one shape you'll use most:

```bash
codex exec \
  --cd <workdir> \
  --sandbox <read-only|workspace-write|danger-full-access> \
  -o /tmp/codex_<rand>.txt \
  "your metaprompt here"  2>>/tmp/codex_<rand>.log
```

- Prompt as the final arg, OR pipe via stdin: `echo "$PROMPT" | codex exec -`
  (good for long/generated prompts). If both are given, stdin is appended.
- `-o, --output-last-message <file>` — writes ONLY Codex's final message to a
  file. This is your clean capture; read it back, don't scrape the TUI stream.
- `2>>/tmp/...log` — Codex streams progress/reasoning to **stderr**; the final
  message goes to **stdout**. Redirect stderr to a log so it doesn't bloat your
  context. Generate the suffix with `openssl rand -hex 4`.
- `--cd <dir>` — Codex's working root. Scope it to the relevant subdir
  (e.g. `apps/api`), not the whole monorepo, so it stays focused.
- `--skip-git-repo-check` — only needed when running outside a git repo.
</the-core-command>

<sandbox-tiers>
Pick the **least** privilege that lets the task succeed:

- `read-only` (default) — Codex can read/grep/run read-only commands but cannot
  edit files or hit the network. Use for review, analysis, planning, "find the
  bug", second opinions.
- `workspace-write` — can edit files in `--cd` (and `--add-dir` paths) and run
  commands, but no network by default. Use for real implementation/refactors.
- `danger-full-access` — no sandbox at all. Avoid; only for throwaway/ephemeral
  dirs you fully control.

Approvals: in `exec` mode Codex does not prompt for approvals. For a fully
autonomous run with no gating at all, add
`--dangerously-bypass-approvals-and-sandbox`. This is powerful — only use it when
the user has explicitly authorized autonomous edits AND the `--cd` is scoped, or
when running in an already-sandboxed/throwaway dir. When unsure, ask the user
which sandbox tier before running with write access.
</sandbox-tiers>

<output-modes>
- Default: human-readable, final message on stdout (+ capture with `-o`).
- `--json` — newline-delimited JSON events on stdout (tool calls, file changes,
  messages). Use when you want to parse what Codex actually did, not just its
  prose summary.
- `--output-schema <file.json>` — force Codex's final response to conform to a
  JSON Schema. Use for reliable structured hand-back (e.g. a list of findings).
- `-m, --model <model>` — pin the model. `-i, --image <file>` — attach images.
  `--add-dir <dir>` — extra writable roots. `--ephemeral` — don't persist the
  session to disk.
</output-modes>

<session-resume>
Codex sessions are stateful. To continue a prior run with its context intact:

```bash
codex exec resume --last "now also update the tests"   # most recent session
codex exec resume <session-id> "..."                   # a specific one
```

The session id is printed at the start of each `exec` run. Use resume for
multi-turn delegation (draft → refine → fix) instead of re-sending all context.
</session-resume>

<delegation-patterns>
- **One-shot task** — scope `--cd`, `workspace-write`, `-o` capture, verify.
- **Second opinion / adversarial review** — `read-only`, ask Codex to find bugs
  or critique your diff. Different model, different blind spots.
- **Plan/implement split** — you write the spec, Codex implements it, you review.
- **Refactor + test split** — Codex does the mechanical edit; you write/verify
  the tests (or vice-versa). Cross-checking catches more.
- **Parallel fan-out** — for N independent files/tasks, launch N `codex exec`
  runs, each with its own `-o`/log file. To avoid edit collisions when multiple
  WRITE runs touch the repo at once, give each its own git worktree
  (`git worktree add`) and point `--cd` there.
- **Cost routing** — small mechanical fixes → Codex (ChatGPT quota); deep
  long-context work → keep it yourself.
</delegation-patterns>

<the-supervision-loop>
Never skip this. After every delegated run:

1. **Delegate** — `codex exec ... -o <out> 2>><log>`.
2. **Capture** — read `<out>` (and `<log>`/`--json` if you need detail).
3. **Verify INDEPENDENTLY** — do not trust Codex's "tests pass" / "done":
   - `git status` / `git diff` to see what actually changed.
   - Read the changed files yourself.
   - Re-run the build/tests/linter yourself and read the real output.
4. **Iterate** — if wrong, `codex exec resume --last "<correction>"` and repeat.
5. **Report** — tell the user what changed, what you verified, and how. State
   plainly when something failed or was skipped.

Cleanup: remove `/tmp/codex_*` capture/log files (and any throwaway worktrees)
when done.
</the-supervision-loop>

<repo-specifics>
In this repo, respect the existing skills: prefer the `worktree` skill
(`pnpm worktree`) for isolated parallel Codex runs, and the `ke2e-tests` /
`migration` skills' rules still apply to anything Codex produces — verify against
them. A Codex run is not a license to bypass repo conventions; you own the result.
</repo-specifics>

</skill>
