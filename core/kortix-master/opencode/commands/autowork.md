---
description: "Autowork loop enforcer — runs until the task is verified complete via a structured completion tag."
agent: general
---

# Autowork

<!-- KORTIX_AUTOWORK -->

You are in **autowork mode** — a persistent loop that runs until you emit a well-formed `<kortix_autowork_complete>` tag with verification evidence and a requirements check.

## How the loop works

1. Every time your session goes idle, the autowork plugin checks your recent assistant text for a `<kortix_autowork_complete>` tag.
2. If present and valid → the loop stops cleanly.
3. If present but malformed (missing/empty children, unchecked items) → the plugin rejects it and sends a structured continuation explaining exactly what was wrong.
4. If absent → the plugin sends a standard continuation that re-anchors the original user request and tells you to keep working.
5. Hard ceiling: `--max-iterations` (default 50). Hitting it stops the loop with `failed`.

## The completion contract

When — and only when — the task is 100% done, deterministically verified, and every user requirement is satisfied with concrete proof, emit on its own in a message:

```
<kortix_autowork_complete>
  <verification>
    [The exact commands you ran, with exit codes and real output that prove the task works.
     Not "should work." Reproducible.]
  </verification>
  <requirements_check>
    - [x] "exact user requirement 1" — how it was satisfied + proof (file path / command output / test id)
    - [x] "exact user requirement 2" — how it was satisfied + proof
  </requirements_check>
</kortix_autowork_complete>
```

**Hard rules the plugin enforces:**
- Both `<verification>` and `<requirements_check>` children are required and must be non-empty.
- Every `<requirements_check>` item must be `- [x]` with concrete evidence.
- Malformed tags, empty children, or unchecked items → automatic rejection, loop continues.
- The tag only triggers completion when actually emitted — discussing it in prose does NOT trip the loop.

## Rules while in the loop

- Do real work every turn. No restatement, no planning-in-place, no hedging. Move the work forward.
- Read files before editing. Run tests before claiming success.
- If an approach fails, diagnose the root cause and try a focused fix.
- If you are blocked on missing external input, say exactly what is blocked and why, then emit `task_blocker` (inside a task) or stop cleanly.
- The continuation prompts re-inject the original user request every iteration so you do not drift.

## Usage

```
/autowork fix the auth bug and verify it
/autowork --max-iterations 10 build the signup flow
```

To cancel an active loop: `/autowork-cancel`
