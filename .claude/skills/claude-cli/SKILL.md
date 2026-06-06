---
name: claude-code
description: Drive Anthropic's Claude Code CLI (`claude -p`) as a non-interactive coding sub-agent from inside Codex. Use when you want to delegate a coding/analysis/refactor task to Claude, get a second opinion / adversarial review from another model, hand off long-context planning, or fan out parallel agents. Covers the exact `claude -p` flags, permission modes, output capture, JSON/stream-json modes, session resume, parallel fan-out, and the mandatory "delegate → capture → independently verify, never trust the self-report" supervision loop.
metadata:
  short-description: Delegate tasks to the Claude Code CLI
---

# Claude Code as a Sub-Agent

Claude Code is Anthropic's terminal coding agent. Its **headless** mode,
`claude -p` (a.k.a. `--print`), makes it a disposable sub-agent: you write the
metaprompt, Claude explores/edits/runs commands on its own, and returns a final
message you capture and verify. You stay the planner; Claude is the executor —
it's a strong long-context planner, so this is useful for reviews, big-picture
design, and cross-cutting refactors.

**Golden rule:** Claude's self-report is a claim, not the truth. Capture its
output, then independently verify the artifacts yourself (read the files, re-run
the tests) before treating the task as done.

Verified locally: `claude` 2.1.167. Confirm install with `claude --version`.

## The core command

```bash
claude -p "your metaprompt here" \
  --add-dir <workdir> \
  --permission-mode <default|acceptEdits|plan|bypassPermissions> \
  --output-format json  >/tmp/claude_<rand>.json 2>>/tmp/claude_<rand>.log
```

- `-p, --print` — headless: print the response and exit. Required for scripting.
- Prompt as the arg, OR pipe via stdin: `echo "$PROMPT" | claude -p` (good for
  long/generated prompts).
- `--output-format` — `text` (default), `json` (single object with `result` +
  `session_id` + cost/usage), or `stream-json` (NDJSON events as they arrive).
  Use `json` for clean capture and to grab the `session_id` for resume.
- Redirect stdout to a capture file and stderr to a log so progress noise
  doesn't pollute your context. Generate `<rand>` once per run.
- `--model <alias|id>` — pin the model (e.g. `opus`, `sonnet`, or a full id).
- `--add-dir <dir>...` — extra directories Claude may read/write.
- `--append-system-prompt <text>` — inject extra instructions/persona.

## Permission modes (pick the least privilege)

- `default` — Claude asks before edits/commands. In headless `-p` it cannot
  prompt, so write actions are effectively blocked → good for **read-only**
  review/analysis.
- `plan` — Claude plans but does not edit. Use for "design this / find the bug".
- `acceptEdits` — auto-accepts file edits. Use for real implementation.
- `bypassPermissions` (or `--dangerously-skip-permissions`) — no gating at all.
  Powerful; only use when the user has explicitly authorized autonomous edits AND
  the working dir is scoped, or in a throwaway dir. When unsure, ask which mode
  before granting write access.

## Output & session resume

- Parse `--output-format json`: the `result` field is the final message; the
  `session_id` field lets you continue the same conversation.
- Resume with context intact:
  ```bash
  claude -p --continue "now also update the tests"      # most recent session
  claude -p --resume <session-id> "..."                 # a specific session
  ```
- Use resume for multi-turn delegation (draft → refine → fix) instead of
  re-sending all context.

## Delegation patterns

- **One-shot task** — scope `--add-dir`, `acceptEdits`, capture, verify.
- **Second opinion / adversarial review** — `plan` mode, ask Claude to critique
  your diff or find bugs. Different model, different blind spots.
- **Plan/implement split** — Claude designs; you implement (or vice-versa).
- **Parallel fan-out** — for N independent tasks, launch N `claude -p` runs, each
  with its own capture/log file. For concurrent WRITE runs, give each its own
  `git worktree add` dir and point `--add-dir` there to avoid edit collisions.

## The supervision loop (never skip)

1. **Delegate** — `claude -p ... --output-format json >out 2>>log`.
2. **Capture** — read the `result` from `out` (and `log`/stream-json for detail).
3. **Verify INDEPENDENTLY** — do not trust "tests pass" / "done":
   - `git status` / `git diff` to see what actually changed.
   - Read the changed files yourself.
   - Re-run the build/tests/linter yourself and read the real output.
4. **Iterate** — if wrong, `claude -p --continue "<correction>"` and repeat.
5. **Report** — state what changed, what you verified, and how. Say plainly when
   something failed or was skipped.

Cleanup: remove `/tmp/claude_*` capture/log files (and any throwaway worktrees)
when done.
