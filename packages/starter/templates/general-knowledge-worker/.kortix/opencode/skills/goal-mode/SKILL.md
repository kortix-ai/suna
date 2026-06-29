---
name: goal-mode
description: "Pursue a single objective across turns until it is genuinely done — not just attempted. Seed milestone todos from the goal, work them, then run a fresh-context verifier (and a QA pass on functional artifacts) before declaring done. Use when the user runs /goal, says 'keep going until it's done', 'don't stop until X', 'work on this end to end', or sets a deliverable with a clear finish line (research that must be fact-checked, a build that must run, an audit with no blind spots)."
defaultProjectInstall: true
---

# Goal Mode

Goal mode is for work that should run to a finish line on its own, instead of stopping after one pass and waiting for "keep going". You lock onto **one objective** with an explicit stop condition, work it across as many turns as it takes, and — this is the part that matters — **prove it's done before you say it's done** by handing the work to a fresh-context verifier.

It fits deep research, multi-step builds, audits, and strategy work that needs cross-checking. It is wrong for quick lookups, single-pass answers, and anything whose finish line is vague — "make this better" is not a goal, because nothing can ever certify it complete.

## How persistence actually works here

You do not implement a loop. Kortix already runs one.

The `kortix-continuation` runtime watches your **native todo list**. Whenever your session goes idle with any todo still `pending` or `in_progress`, it re-prompts you to pick up the next item and keep going — automatically, every turn, until the list is clean. (Mechanics in the Runtime note at the bottom.)

So goal mode is not a new engine. It is a **way of driving the engine you already have**:

1. Turn the goal into todos, with the finish line as the **final** todo.
2. Work the todos. Idle → the runtime pushes you forward. You never have to ask the user "should I continue?".
3. Before you check the final todo, **run the verifier**. The goal is done only when the verifier passes — not when you feel finished.

The todo list is therefore both your plan *and* your stop condition. Keep it honest and the runtime does the persistence for free.

## Entering goal mode

When a goal arrives (via `/goal` or a "do this end to end" ask) and there is no active goal yet:

### 1. Lock the goal and its stop condition

Restate the objective in one or two sentences. You may sharpen the phrasing for clarity, but **never narrow the scope** to make it easier. Fold in any reasonable assumptions rather than stopping to ask — name the assumption, then proceed.

Write down the stop condition explicitly: *what has to be true for this to count as done, and how that gets verified.* "Researched" is not a stop condition; "every claim cross-checked against at least two independent sources" is. The stop condition is what your verifier will lock onto later, so make it checkable.

### 2. Seed milestone todos

Use the native todo tools to lay out the milestones from the goal. The list is what the user watches for progress and what the runtime reads to keep you moving, so:

- One todo per real milestone — concrete, in the order you'll do them.
- Make the **last todo the stop condition**, phrased as a verifier pass — e.g. *"Verifier pass: cross-check every claim, then sign off"* or *"Build, run end to end, QA the flows, then sign off"*. This is the gate. Until it's checked, the runtime keeps you working.
- **Mind the wording.** The runtime treats a todo as *blocked* (and will let the session stop) if its text reads like it's waiting on something external — words like *waiting*, *blocked*, *depends on*, *pending review*, *requires access*, *missing credentials*. Don't phrase live work that way. Reserve that language for a todo that genuinely cannot proceed without the user or an external dependency.

### 3. Work, and keep the list current

Start immediately — don't wait for confirmation. As you go, flip todos to `in_progress` and `completed` in real time; the user reads the todo pane to follow along, and the runtime reads it to decide whether to push you onward. Add todos when the work reveals new steps. Never check the final verifier todo on vibes.

### 4. Verify before you finish

When every working todo is done and only the verifier todo remains, run the verifier loop below. **Only after it passes** do you check the final todo and hand back. If it fails, file the findings as fresh todos and the runtime carries you back into the work.

## The verifier loop — the real value

A model auditing its own output in the same context is a weak check; it already believes the work is good. The strength of goal mode is delegating the audit to a **subagent with a clean context** that never saw you do the work.

Spawn it with the **task tool** (the `general` subagent has full tools — it can read, search, build, and run, which is what makes it a real auditor rather than a proofreader). Continuation never fires inside subagents, so the audit runs cleanly and control returns to you when it reports back. Give the verifier three things: the **original goal and stop condition**, the **artifact or claims to check**, and a sharp instruction to *try to break it*, not to praise it. It should come back with a verdict and a concrete defect list, not a summary.

Tailor the audit to what "done" means for this goal:

| Goal shape | What "done" requires | What the verifier does |
| --- | --- | --- |
| **Accuracy** — facts, figures, claims | Nothing asserted that isn't sourced | Re-derive each claim from independent sources; triangulate; flag every uncited or single-sourced statement, every stale number |
| **Functional** — it has to work | The artifact runs and does the job | Build it, run it, and **actually use it** — exercise the real flows, hit edge cases, confirm output. Spawn a separate **QA subagent** to drive the artifact like a user when the goal is something runnable |
| **Comprehensive** — no blind spots | Every angle covered | Re-attack the question from angles you didn't take, run divergent searches, hunt for the gap or counter-argument you missed |

Feed every defect back as new todos and fix them. Then verify again — a clean artifact must survive a verifier pass with **no** material findings.

For a maximum-effort stop condition (the user said "spend the full budget", "multiple rounds", "leave nothing on the table"), **do not stop at one clean pass.** Run several rounds of verify-and-QA, each from a fresh subagent, folding each round's findings back into the work, until rounds stop turning up anything that matters.

## Explaining goal mode

Use this when the user is *asking about* `/goal` rather than starting one. Don't kick off a goal — explain it, briefly. Speak in the first person: you're talking to them, not reciting product copy. Keep it to a few sentences and a couple of examples — resist listing every category.

Cover four things:

1. **What it is** — in goal mode I lock onto one objective and keep working it across turns, then audit my own work with a fresh-context verifier before I call it done. Good for deep research, multi-step builds, audits, and strategy work that needs cross-checking. A useful tell: reach for it whenever you'd otherwise be typing "keep going" or "now try the next fix" after every turn.
2. **How to start** — `/goal <objective>`, e.g. `/goal map the EU AI Act's high-risk obligations and verify every deadline against the primary text`.
3. **Write the finish line into the goal** — the best goals say *how* success gets checked: "fact-check every claim", "verify the flows work end to end", "until the suite passes". That's exactly what I point the verifier at.
4. **When not to** — quick lookups, one-pass answers, casual questions, and anything with a fuzzy finish line ("make it nicer" gives me no way to know when I'm done).

Pick at most a handful of examples that fit the user's context — draw from these or write your own in the same shape, don't dump the list:

- `/goal research the top GLP-1 drugs, fact-check every claim, and write it up as a brief`
- `/goal build a competitive teardown of the LLM API market and turn it into a deck`
- `/goal audit our pricing page against five rivals and recommend changes`
- `/goal build a personal-finance dashboard and verify the flows work end to end`
- `/goal track down the cause of the flaky browser-agent runs and produce a root-cause report`

Close with a one-line invite — e.g. *"Want me to help you frame one, or hand me an objective and I'll start?"*

---

**Runtime:** persistence is handled by the `kortix-continuation` plugin — a `session.idle` todo enforcer that re-prompts the agent while native todos remain unfinished, with safety caps (per-request continuation limit, min-work duration, cooldown, abort circuit breaker). Goal mode rides on it: it seeds the todos the enforcer watches. A deeper verifier-gated stop — the engine itself refusing to let the session end until a verifier subagent passes — is a future enhancement to `continuation-engine.ts`; today the verifier gate is held by this skill's discipline, not enforced by the plugin.
