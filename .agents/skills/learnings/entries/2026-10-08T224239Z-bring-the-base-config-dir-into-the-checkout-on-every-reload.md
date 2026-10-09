---
recorded: 2026-10-08T22:42:39Z
incident_date: 2026-09-30
supersedes: 2026-09-30T171738Z-when-a-mechanism-moves-behind-a-flag-keep-the-flag-off-path.md
---
# Bring the base config dir into the checkout on every reload a daemon without config releases takes

**Rule:** The pre-release reload path must keep doing what it did before config releases: bring the base branch's OpenCode config dir into the session's checkout (`syncConfigDirToBase`, via `POST /kortix/refresh?base_config=1`), because OpenCode reads agent files from that checkout. Config releases graduated out of the `config_releases` flag, so only a daemon without `config.release.v1` reaches this path now. The superseded entry's rule held while most projects had the flag off. The path stays, and its enforcer moved.

**Trigger surface:** Editing the pre-release path of `reloadSessionConfig` (`apps/api/src/projects/lib/session-reload.ts`) or the daemon's refresh (`harness/open-code/control.ts`, `routes/kortix/refresh.ts`); deleting that path while old daemons still run.

**Incident:** PR #7403 (2026-09-25) removed the config-dir sync from the flag-off reload path. On 2026-09-30 an agent `.md` fix merged to a project's `main` never reached its long-lived Slack triage session through two reloads.

**Enforcement:** `apps/api/src/projects/lib/__tests__/session-reload-capability-gate.test.ts` › "reloadSessionConfig on a daemon without config releases" (the refresh carries `base_config=1`; `updated` / `kept-yours` / `already current` outcomes), `apps/kortix-sandbox-agent-server/src/__tests__/refresh-route.test.ts` › "base_config=1 brings the base branch agent config into the checkout", and `config-dir-sync.test.ts`.
