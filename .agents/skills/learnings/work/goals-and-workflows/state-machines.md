# State machines considered

Planning record, 2026-10-20. Example goal for every comparison: close a bank
account (parallel prep, request, wait with daily chase, 30-day window, verify,
retry on FAIL).

| Kind | What it is | For goals |
|---|---|---|
| Finite state machine | flat states and arrows | no parallel work without a state per combination |
| Statechart (Harel; XState) | nested states, parallel regions, timers, guards | strong fit; definition is data; loops over lists are clumsy |
| Durable workflow (Temporal, Restate, Inngest, Claude Workflows) | ordinary code, steps recorded and replayed | any logic; position is a line number; editing breaks position-keyed replay |
| Task graph (DAG) | tasks plus dependencies, no cycles | no loops, no "chase again tomorrow" |
| Agent graph (LangGraph) | the model picks the next node | the model decides the flow; failed in our live runs |
| Behavior tree | a tree re-checked every tick | built for fast ticks, hard to read as a process |
| Petri net / BPMN | tokens through places | exact concurrency; heavy for agents to write |

Prior art for "declarative machine on a durable runtime": AWS Step Functions
(Task, Wait, Choice, Parallel, Map, human-approval callbacks).

## How the recommendation moved

1. **First recommendation:** a statechart as data inside a fixed lifecycle,
   with workflow scripts as one kind of step. Reasons: agents edit the plan
   while it runs, the user must see where the goal is, the platform must
   enforce it.
2. **Current recommendation:** durable workflow code (`goal.ts`) with
   **name-keyed replay**, enforcement **on effects in the API**, executed in
   QuickJS. Three findings changed it:
   - name-keyed replay (Inngest, Restate) keeps finished steps when the script
     changes; position-keyed replay (Temporal, Claude Workflows) does not;
   - the rules that matter are about effects (done, messaging a person,
     irreversible actions), and the API can gate effects whatever the code does;
   - named steps give a readable timeline and the current wait.
3. **What is given up:** a full drawn graph of every future path. Accepted.

The drawings lived in owner-only claude.ai artifacts and are not in the repo:
"Goal Machine Design" and "Goal System Map".
