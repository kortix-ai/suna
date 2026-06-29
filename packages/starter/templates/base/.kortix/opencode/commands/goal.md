---
description: Enter goal mode — pursue one objective end to end, verify it, then stop
---

Enter **goal mode** for this objective:

$ARGUMENTS

First, load the `goal-mode` skill and follow it. Then, without waiting for confirmation:

1. **Lock the goal.** Restate the objective in a sentence or two — sharpen the wording if needed, but never narrow the scope. Write down the explicit stop condition: what must be true for this to count as done, and how that gets verified. If the objective leaves something open, fold in a reasonable assumption, name it, and proceed.
2. **Seed the todos.** Use the native todo tools to lay out the milestones in order, and make the **final todo the stop condition phrased as a verifier pass** (e.g. "Verifier pass: cross-check every claim, then sign off" / "Build, run end to end, QA the flows, then sign off"). Don't word live todos as waiting/blocked/depends-on — that tells the runtime to stop.
3. **Start working now.** Flip todos to in-progress/completed as you go so progress stays visible. The continuation runtime will keep you moving while todos remain — you don't need to ask "should I keep going?".
4. **Verify before finishing.** When only the verifier todo is left, spawn a fresh-context verifier subagent (and a QA subagent to actually run the artifact if the goal is functional), tailored to the goal type. Fix every finding it returns, re-verify, and only check the final todo once it passes clean. For a maximum-effort stop condition, run multiple rounds.

Begin.
