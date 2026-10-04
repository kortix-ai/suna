---
recorded: 2026-09-30T17:17:38Z
incident_date: 2026-09-30
---
# When a mechanism moves behind a flag, keep the flag-off path's behaviour: most projects stay there

**Rule:** When a new mechanism replaces an old one behind a per-project flag that defaults OFF, the flag-off path must keep doing what the old mechanism did. Removing it from the flag-off path is a silent regression for every project that has not opted in. A reload on a project without `config_releases` must bring the base branch's OpenCode config dir into the session's checkout (`syncConfigDirToBase`, via `POST /kortix/refresh?base_config=1`), because OpenCode reads agent files from that checkout.

**Trigger surface:** Putting a replacement mechanism behind a feature flag (`registry.ts` `platformDefault: () => false`); editing the pre-release path of `reloadSessionConfig` (`apps/api/src/services/sessions/session-reload.ts`) or the daemon's refresh (`harness/open-code/control.ts`, `routes/kortix/refresh.ts`).

**Incident:** PR #7403 (2026-09-25) moved "sessions run the base branch's config" behind `config_releases` (default OFF) and removed the config-dir sync that PR #6083 had added to every reload. On 2026-09-30 an agent `.md` fix merged to a project's `main` never reached its long-lived Slack triage session: two reloads fast-forwarded only the session branch, and on current daemons the governance push returns early, so OpenCode was not even restarted.

**Enforcement:** `apps/api/src/projects/lib/__tests__/session-reload-capability-gate.test.ts` › "reloadSessionConfig with config_releases off" (the refresh carries `base_config=1`; `updated` / `kept-yours` / `already current` outcomes) and `apps/kortix-sandbox-agent-server/src/__tests__/refresh-route.test.ts` › "base_config=1 brings the base branch agent config into the checkout", plus `config-dir-sync.test.ts` (real git: never moves a ref, refuses local edits and commits, pathspec magic cannot widen it).
