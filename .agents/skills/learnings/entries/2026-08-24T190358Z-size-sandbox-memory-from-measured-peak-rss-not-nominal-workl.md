---
recorded: 2026-08-24T19:03:58Z
incident_date: 2026-08-24
commit: 88ccaac672
---
# Size sandbox memory from measured peak RSS, not nominal workload size

**When:** assigning a sandbox template to image-heavy, document-heavy, or long-context agents.
Measure the largest runtime process during a representative turn and leave headroom for the
daemon, tools, and filesystem cache. A 4 GiB sandbox with no swap cannot safely run an
OpenCode process at 3.07 GiB anonymous RSS. Bind the agent to a larger ready template before
the next session; changing the default does not migrate existing sessions. *Incident:*
SampleCo session `fea31312` lost its active turn when Linux OOM-killed OpenCode after a
141k-token image workflow. *Enforcer:* template and fresh-session slug read-back; no RSS gate.
