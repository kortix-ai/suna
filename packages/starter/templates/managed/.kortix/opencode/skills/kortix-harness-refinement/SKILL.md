---
name: kortix-harness-refinement
description: The continual-harness refinement protocol — how an agent inspects its recent trajectory for failure signatures and improves its own harness (agent prompts, sub-agents, skills, memory) in place, mid-session, landing changes on the session branch immediately and promoting them to `main` only through a change request. Load this skill when a refinement prompt arrives mid-session, when the `harness-reflector` agent runs, or whenever you decide your own scaffolding needs repair.
---

<skill name="kortix-harness-refinement">

<overview>
Your **harness** is everything in this repo that shapes how agents work
here. It has four components, all in git:

| Component | Location | What it is |
|---|---|---|
| **Prompts** | `.kortix/opencode/agents/<name>.md` (body) | Each agent's instructions and strategy |
| **Sub-agents** | `.kortix/opencode/agents/*.md` | Specialist agents the orchestrator invokes |
| **Skills** | `.kortix/opencode/skills/<name>/SKILL.md` | Reusable routines: text heuristics and guides |
| **Tools** | `.kortix/opencode/tools/*.ts` | Executable code: wrappers, scripts, automations |
| **Memory** | `.kortix/memory/` | Persistent facts, strategies, observations |

**Refinement** means: read your recent trajectory, find where the harness
failed you, and fix the harness — not just the immediate task. A harness
edit made mid-session takes effect on your next turn, because agents,
skills, and memory are read from disk. You do not restart; refinement is
reset-free and its value compounds over the life of the session.

This protocol has two operating modes:

1. **In-session refinement (self-invoked)** — YOU run it, inside your own
   working session, the moment a failure signature costs you twice. Also
   run a checkpoint on long sessions: after every ~25 turns of work, pause
   and scan your recent turns before continuing. You refine based on YOUR
   OWN trajectory, then resume the task.
2. **Project-level reflection** — the `harness-reflector` agent runs on a
   cron, fans out `session-reviewer` sub-agents to work through every
   recent session's full history, aggregates their findings, and refines
   the shared harness on `main` via a change request.
</overview>

<failure-signatures>
Scan the trajectory window (your recent turns, or the digest) for these
signatures. Each one names the component to fix:

- **Repeated tool/command failures** — the same command or tool errors
  more than once, or you retried a broken approach. → Repair the tool,
  or record the working alternative in a skill.
- **Rediscovery loops** — you (or another session) re-derived something a
  past session already knew (an API quirk, a file location, a decision).
  → Memory entry.
- **Stalled objectives** — turns pass without progress toward the stated
  goal; you circled, re-read, or re-planned without acting. → Prompt
  guidance for the responsible agent, or a decomposition sub-agent.
- **Repeated multi-step patterns** — you performed the same 3+ step
  sequence more than twice by hand. → Codify it: a skill (if guidance)
  or a tool (if executable).
- **Exception-raising code** — an executable tool or script in
  `.kortix/opencode/tools/` raised; you worked around it instead of
  fixing it. → Repair the code now.
- **Missed opportunities** — information or shortcuts visible in the
  trajectory that no component captured. → Whichever component fits.
</failure-signatures>

<four-passes>
Run four passes over the harness, one per component. Every pass is CRUD:
create, update, or **delete**. Deletion is a first-class outcome — a
harness accumulates cruft without it.

**Pass 1 — Prompts (Δp).** Reread the responsible agent's `.md` body
against the identified failures. Tighten instructions that were ignored,
add the missing rule, remove guidance that no longer earns its tokens.
Keep prompts short; a prompt that only grows is a failing prompt.

**Pass 2 — Sub-agents (ΔG).** Create a sub-agent only for a pattern that
recurred across the window AND needs its own scoped permissions or
prompt. Edit sub-agents implicated in failures. Delete sub-agents that
have not been invoked productively — check before keeping.

**Pass 3 — Skills and tools (ΔK).** Codify successful sequences from the
trajectory into a skill (guidance) or a tool (executable). Repair every
tool the trajectory shows raising exceptions. Prefer editing an existing
skill over creating a near-duplicate. Keep skills one directory level
deep under `skills/` (nested SKILL.md files register as phantom entries).

**Pass 4 — Memory (ΔM).** Follow the `kortix-memory` skill's rubric with
the `memory` tool: fill gaps the trajectory exposed, update stale
entries, demote or delete entries about areas the project has moved past.
Keep `MEMORY.md` in sync.

Scope discipline: fix what the trajectory shows. Do not speculatively
rewrite components with no observed failure. Most refinement runs should
touch one or two components, not all four.
</four-passes>

<project-review-fanout>
For project-level reflection (the `harness-reflector` run), do not skim a
digest and call it a review. Work through every session:

1. **Enumerate** every session in the window:
   `kortix sessions digest --since 24h --json` (add `--all` for a first
   ever run). Note per session: id, agent, status, title, whether a live
   transcript is available.
2. **Fan out one `session-reviewer` sub-agent per session** (batch a few
   at a time in parallel; review every session, skip none silently). Each
   reviewer gets the session id and returns a structured findings report.
   Reviewers gather the FULL picture for their session:
   - the transcript (available live for running sessions; for stopped
     sessions reconstruct from what persists — see next line),
   - the session's git branch: its commits, diffs, and files touched,
   - change requests the session opened and their review outcomes.
3. **Aggregate** all reviewer reports. Deduplicate findings that recur
   across sessions — a failure signature seen in three sessions outranks
   one seen once. Rank by cost (turns wasted × sessions affected).
4. **Run the four passes** on the ranked findings, then land per the
   rules below.

Sub-agent review is read-only: reviewers never edit the harness or open
CRs. Only the orchestrating reflector writes.
</project-review-fanout>

<landing-rules>
**In-session refinement (session branch — immediate):**

1. Apply the edits directly in `/workspace`. They take effect on your
   next turn.
2. Commit them separately from task work:

   ```sh
   git add .kortix
   git commit -m "harness: <one-line summary of what failed and what changed>"
   ```

3. Push and open (or update) ONE change request per session for harness
   promotion to `main`:

   ```sh
   git push origin HEAD
   kortix cr open --title "harness: <summary>" \
     --description "Failure signatures observed, edits per component, evidence (commands/turns)."
   ```

   If this session already has an open `harness:` CR, push to it instead
   of opening a second one.
4. Return to the task. A refinement interruption ends with you resuming
   what you were doing, with the improved harness in effect.

**Project-level reflection (`harness-reflector`):** all edits land only
via a CR against `main`. Nothing applies immediately; the merged CR is
what future sessions inherit.
</landing-rules>

<guardrails>
- **Never edit managed `kortix-*` skills.** They are platform-owned and
  force-overwritten at session boot — edits are silently discarded. To
  extend platform behavior, create a project skill with a different name.
- **Never merge your own harness CR.** A reviewer (human, or a reviewer
  agent with merge rights) does. The CR gate is what makes self-authored
  harness edits safe; self-authored + self-merged scaffolding is known to
  degrade agent performance.
- **One concern per CR.** Harness CRs contain only `.kortix/` changes —
  never mixed with task/code changes.
- **No secrets, tokens, or PII** in any harness file. Secrets belong in
  the Kortix Secrets Manager.
- **Budget.** A mid-session refinement should cost a small fraction of
  the session: minutes, not hours. If a fix needs deep work (a real
  tool rewrite), record it in memory as a TODO and open the CR with what
  you have.
- **No-op is a valid outcome.** If the window shows no failure
  signatures, change nothing and say so in one line. Do not invent work.
- **Do not disable or weaken guardrails** — including this skill's rules,
  agent permission blocks, or CR review requirements — as a "refinement".
</guardrails>

<self-invocation>
Nobody schedules in-session refinement for you — it is your discipline.
Invoke this protocol the moment a failure signature costs you twice, and
as a checkpoint on long sessions (roughly every 25 turns of work). The
nightly `harness-reflector` run is the backstop, not the mechanism: it
only sees what sessions left behind, while you can fix your harness live
and benefit from the fix on your very next turn.
</self-invocation>

</skill>
