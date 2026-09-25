---
recorded: 2026-08-27T16:14:05Z
incident_date: 2026-08-27
commit: 9ed68563dd
---
# An experiment flag that deploy-dev pins to an explicit `false` can never double as a kill switch

**When:** reusing an existing feature/experiment flag to gate a new default-on
behaviour with "unset = on, explicit `false` = off" semantics.
`deploy-dev.yml` injects `KORTIX_FAST_COLD_BOOT_ENABLED=false` into the API
task on EVERY push deploy (`.github/workflows/deploy-dev.yml`, the
`enable_fast_cold_boot` dispatch input), so on dev that flag is always
"explicitly false" even though `apps/api/.env*` leave it unset. PR #6964 gated
the fresh-session git hint (`KORTIX_BASE_SHA` + scaffold delta + OpenCode
config-dir hint) on that reading; dev sessions got `KORTIX_SESSION_FRESH=1`
only and still fetched `main` through the proxy (3.0–3.4 s instead of 0.2 s).
`provision-core.ts` had the same gate on its seed-time hint for weeks.

**The rule: a new default-on path gets its OWN flag** (#6973:
`KORTIX_FAST_GIT_BOOT_ENABLED`, `optBoolTrue`), and before choosing
"explicit false = off" semantics on any flag, grep the deploy workflows and
`infra/scripts/ecs-deploy.sh` for who sets it — `.env` files are not the only
source of the task environment.

**Diagnostic:** the daemon env inside a box (`env | grep KORTIX_` via
`POST <sandbox_url>/kortix/pty`) and `projects.metadata->'git'->'fast_boot'`
staying `null` after a session: the API never even attempted the hint.
*Near-miss:* #6964 → #6973, one wasted deploy cycle.
*Enforcer:* none. A config test that asserts every `optBoolUnset`-style
"configured?" gate is not also set by `deploy-*.yml` would catch it.
