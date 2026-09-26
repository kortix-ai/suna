---
recorded: 2026-09-15T16:48:58Z
incident_date: 2026-09-15
commit: 1941510b5e
---
# Renaming or replacing the default agent is TWO writes — the manifest AND `project.metadata.default_agent`, which wins

**When:** a CR renames, removes, or replaces the agent named by `default_agent`
in `kortix.yaml`. `resolveGovernedAgentGrant` (`apps/api/src/projects/agents.ts`)
resolves the `default` sentinel from `opts.projectDefaultAgent` (the DB mirror)
BEFORE `loaded.defaultAgent` (the manifest). A CR merge does not refresh the DB
mirror, so the old name keeps winning and every default-agent launch (web
composer, triggers without `agent`, Slack) fails `AGENT_NOT_DECLARED`. After the
merge, run `kortix agents default <new>` (writes both), then assert
`kortix projects info --json` → `metadata.default_agent`. *Near-miss:* prod
customer project, `kortix` → `galileo-admin` rename, ~7 min window, caught before
any member launched. *Automation:* none — candidate: CR-merge manifest sync
updates `metadata.default_agent` when the merged manifest no longer declares it.
