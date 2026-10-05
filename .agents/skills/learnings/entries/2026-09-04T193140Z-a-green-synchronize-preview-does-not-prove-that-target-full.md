---
recorded: 2026-09-04T19:31:40Z
incident_date: 2026-09-04
commit: 8beb6c100c
---
# A green synchronize preview does not prove that target-full ran

**When:** using a persistent branch preview as deployed-test evidence. Push-triggered
preview runs set `PREVIEW_RUN_TESTS=0`; inspect the log for the executed test command,
not the green job name or sticky comment. Trigger `deploy-preview.yml` with
`workflow_dispatch` for the final SHA, then require an actual `[test] PASS target-full`
line. *Near-miss:* PR #7109 published “target-full passed” while its bootstrap printed
“suite skipped”; caught before merge. *Enforcer TODO:* make the workflow result and
sticky comment distinguish a skipped suite from a passed suite.
