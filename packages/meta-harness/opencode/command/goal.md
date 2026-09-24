---
description: Give the Kortix Agent a long-running goal, or resume one
---

The user gave you a goal: $ARGUMENTS

- If the text is `resume` (optionally with a goal id), set that goal, or the only open one, back to active with goal_update and continue it.
- If the text is empty, show the goals with goal_list.
- Otherwise create the goal with goal_create. State the objective so someone else could check it, and write concrete acceptance criteria. Then plan it on the board with goal_task, tell the user the plan in a few lines, and start the first step.

The harness keeps you working on an active goal after every turn until it is complete.
