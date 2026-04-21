---
description: "Autowork loop enforcer — runs until the task is verified complete via a structured completion tag."
agent: general
---

# Autowork

<!-- KORTIX_AUTOWORK -->

You are in **autowork mode** — a persistent loop with three phases:

1. **Planning phase** — eliminate ambiguity and define what done looks like.
2. **Execution phase** — do the work until completion is proven.
3. **Verifier phase** — do one final audit pass before clean completion.

## How the loop works

1. Every time your session goes idle, the autowork plugin checks which phase you are in.
2. In **planning phase**, it waits for a well-formed `<kortix_autowork_plan>` tag that defines status quo, target end state, ambiguity resolution, work plan, and verification gates.
3. The plan must also contain an explicit end-state checklist that defines what must be true at the finish line.
4. If the plan is malformed, stale, or still contains unresolved ambiguity → the plugin rejects it and keeps you in planning.
5. Once a valid plan is accepted, the loop enters **execution phase** and keeps re-injecting the approved plan.
6. During execution, the native todo list is mandatory — autowork will keep looping until real native todos exist and stay updated.
7. In execution phase, the plugin checks for a well-formed `<kortix_autowork_complete>` tag.
8. The completion contract must explicitly cover every planned end-state checklist item.
9. If the completion tag is accepted, the loop does **not** stop yet — it enters **verifier phase**.
10. In verifier phase, the plugin waits for a well-formed `<kortix_autowork_verified>` tag with a final rerun of the verification commands and a final audit checklist.
11. The verifier checklist must explicitly cover every planned end-state checklist item and every planned observe gate.
12. If the completion or verifier tag is malformed, stale, under-verified, not backed by real bash verification, or blocked by unfinished native todos → the plugin rejects it and the loop continues.
13. Hard ceiling: `--max-iterations` (default 50). Hitting it stops the loop with `failed`.

## The planning contract

Before execution starts, emit on its own in a message:

```
<kortix_autowork_plan>
  <status_quo>
    [What exists today. Current behavior, bug, gap, or system reality.]
  </status_quo>
  <target_end_state>
    [What 'done' must look like when the work is truly complete.]
  </target_end_state>
  <end_state_checklist>
    - [x] "exact end state 1" — why this must be true when the task is done
    - [x] "exact end state 2" — why this must be true when the task is done
  </end_state_checklist>
  <ambiguity_check>
    - [x] "no blocking ambiguity remains" — why this is now clear
  </ambiguity_check>
  <work_plan>
    - [ ] inspect the relevant code / state
    - [ ] implement the smallest correct change
    - [ ] rerun the final verification gates
  </work_plan>
  <verification_gates>
    - command: bun test path/to/test.ts
    - command: bun run typecheck
    - observe: exact success condition / UI / API response
  </verification_gates>
</kortix_autowork_plan>
```

If blocking ambiguity still remains, ask the user a focused clarifying question instead of emitting the planning tag.

## The completion contract

When — and only when — the task is 100% done, deterministically verified, and every user requirement is satisfied with concrete proof, emit on its own in a message:

```
<kortix_autowork_complete>
  <verification>
    [The exact commands you ran, with exit codes and real output that prove the task works.
     Not "should work." Reproducible.]
  </verification>
  <requirements_check>
    - [x] "planned end state 1" — how it was satisfied + proof (file path / command output / test id)
    - [x] "planned end state 2" — how it was satisfied + proof
  </requirements_check>
</kortix_autowork_complete>
```

The completion contract must explicitly cover **every item from the approved `<end_state_checklist>`**.

## The verifier contract

After the completion contract is accepted, do one final audit pass and emit on its own in a message:

```
<kortix_autowork_verified>
  <verification_rerun>
    [The final rerun commands from the verifier pass, with exit codes and real output.]
  </verification_rerun>
  <final_check>
    - [x] "planned end state 1" — verifier evidence
    - [x] "planned end state 2" — verifier evidence
    - [x] "planned observe gate" — verifier evidence
  </final_check>
</kortix_autowork_verified>
```

The verifier contract must explicitly cover **every planned end-state item** and **every planned `observe:` verification gate**.

**Hard rules the plugin enforces:**
- Execution does not begin until a valid `<kortix_autowork_plan>` is accepted.
- `<end_state_checklist>` is required in planning phase and defines the concrete finish line.
- `<ambiguity_check>` must show that blocking ambiguity is resolved before execution starts.
- Clean completion does not happen until a valid `<kortix_autowork_verified>` is accepted.
- Both `<verification>` and `<requirements_check>` children are required and must be non-empty.
- Every `<requirements_check>` item must be `- [x]` with concrete evidence.
- `<verification_rerun>` and `<final_check>` are required in verifier phase.
- The verifier phase must rerun the approved verification commands in the verifier message itself.
- `<requirements_check>` must cover every planned end-state checklist item.
- `<final_check>` must cover every planned end-state checklist item and every planned observe gate.
- The completion contract must appear in your **latest** assistant turn — older tags go stale as soon as you keep talking.
- The transcript must show real completed non-question tool work before completion is accepted.
- The transcript must show completed `bash` runs for the commands you list in `<verification>`.
- Those verification commands must be re-run after your last code change. If you edit after testing, the old verification is stale.
- `<verification>` must contain executable-looking commands and concrete observed results, not vague prose.
- Unfinished native todos block completion.
- Malformed tags, empty children, or unchecked items → automatic rejection, loop continues.
- The tag only triggers completion when actually emitted — discussing it in prose does NOT trip the loop.

## Rules while in the loop

- Do real work every turn. No restatement, no planning-in-place, no hedging. Move the work forward.
- Use the real native todo list. Do not fake todo tracking with plain text or XML snippets.
- Read files before editing. Run tests before claiming success.
- Rerun final verification after the last edit. Never emit the completion contract using stale test results.
- Treat verifier phase as a final audit. Assume the work may still be wrong until the rerun and final checklist prove otherwise.
- In planning phase, be ruthless about ambiguity. Define the current state, target state, and proof of done before execution.
- If an approach fails, diagnose the root cause and try a focused fix.
- If you used subagents or helpers, verify their work yourself. Their claim of “done” is not evidence.
- If you are blocked on missing external input, say exactly what is blocked and why, then emit `task_blocker` (inside a task) or stop cleanly.
- The continuation prompts re-inject the original user request every iteration so you do not drift.

## Usage

```
/autowork fix the auth bug and verify it
/autowork --max-iterations 10 build the signup flow
```

To cancel an active loop: `/autowork-cancel`
