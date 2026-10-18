---
recorded: 2026-10-17T04:31:36Z
incident_date: 2026-10-17
---
# Run a project's own script self-checks on the branch before merging a layout move of a customer repository

**Rule:** Before merging a change request that moves files in a customer project (for example a move to kortix.yaml v3), grep the project's own scripts for every old path and run every self-check the project ships, on the branch, in a canary session. A proven config release and loaded agents do not prove the project's own code still finds its files.

**Trigger surface:** `kortix migrate`, a manual layout restructure, or any CR that moves agent prompts, skills or scripts in a project whose own code reads those files by path.

**Incident:** 2026-10-17. An enterprise customer project moved to kortix.yaml v3 (agent prompts to `abs/agents/`, model settings into YAML). The canary checked the release, 17 agents, commands and one subagent call, and passed. The project's own Python scripts still read `harnesses/opencode/agents`: 4 of 8 self-checks failed (one crashed with FileNotFoundError), its code-sync never copied the new agents folder into long-lived sessions, and subagent fallback instructions pointed at missing files. Found in the follow-up cleanup about 2 hours after the merge and fixed in the next CR; no session reported a failure in between.

**Enforcement:** none yet: `kortix migrate` should list every file in the repository that names a moved path (a grep of old paths outside the manifest) and refuse `--write` until each is handled or acknowledged.
