---
recorded: 2026-09-25T23:28:23Z
incident_date: 2026-09-25
---
# An environment that runs a flag's tests must set the flag's operator switch

**Rule:** When a feature flag's `available()` reads an operator switch, set that
switch in every environment whose suite runs the flag's flows, in the same PR
that adds the flows. A flow that enables a flag per project cannot pass where
the switch is off: the `PATCH /features` call answers 200 and the effective flag
stays false.

**Trigger surface:** adding a flag with `available: () => config.<SWITCH>`,
adding flows that toggle it, or editing `KORTIX_ECS_ENV_OVERRIDES` in any
`deploy-*.yml`.

**Incident:** 2026-09-25, v0.13.32 gate run 36188978457, attempt 1. #7403 added
`config_releases` (switch `CONFIG_RELEASES_ENABLED`, default false) and flows
`CFG-1`..`CFG-11`. `deploy-dev.yml` set the switch; `deploy-staging.yml` set only
the archive bucket. 9 CFG flows failed at step 1 (`config_releases did not turn
on`). Fixed by #7691; attempt 2 passed 8 of 11. Prod keeps the switch off on
purpose. No user impact.

**Enforcement:** none yet: a unit test that every `available()` switch named by a
flag some flow enables is set in `deploy-staging.yml` overrides.
