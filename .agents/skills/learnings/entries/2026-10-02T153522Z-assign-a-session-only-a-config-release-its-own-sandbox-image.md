---
recorded: 2026-10-02T15:35:22Z
incident_date: 2026-10-02
---
# Assign a session only a config release its own sandbox image can load, and count a failure toward the project quarantine only when the reporting session shares the image of the sessions it would affect

**Rule:** A session on a runtime image that differs from the standard image (`meta`
today) gets its own release variant. Decide the variant in `releaseVariantFor`
(`apps/api/src/config-releases/session-agent.ts`), never from
`metadata.repository_access` alone: the meta coordinator's metadata reads
`repository_access: true`, but provisioning never gives it a checkout
(`KORTIX_PROJECT_AUTO_CLONE=0`). A failure such a session reports must not count toward
the project quarantine, because the quarantine ledger is keyed by release ID and every
session of the project shares it.

**Trigger surface:** Adding a runtime build profile or a slim sandbox image
(`RuntimeBuildProfile` in `apps/api/src/snapshots/build-context.ts`), adding an agent the
platform injects, or changing `resolveDesiredRelease`, `releaseVariantFor`, or the
quarantine queries in `apps/api/src/config-releases/quarantine.ts`.

**Incident:** 2026-10-02, prod, one internal project with `config_releases` and
`meta_agent` both on. A meta session was assigned the `project` release: the full config
dir, with tool files that import npm packages. The meta image has no `bun` and no baked
`opencode-config-deps`, so the daemon logged `ensureOpencodeConfigDeps failed …
Executable not found in $PATH: "bun"`, OpenCode answered `500 UnknownError` on
`/experimental/tool/ids`, and the proven check declined every release ("tools failed to
load"). The session header showed "Config failed to load". Two meta sessions quarantined
each release ID in turn, so the project walked backwards through its proven releases:
every regular session ran the config of a commit about 21 hours behind the base branch
tip and reported `stale: false`. On the local stack the same state also left a meta
session's boot turn open (318 s, then a timeout). Fix: the `meta` variant (the platform
governance alone, no archive, a release ID that does not move with the base branch) and
`notFromMetaSession` in both quarantine queries. A box that had already failed moved to
its own release 11.4 s after the API had the fix, with no restart.

**Enforcement:** `CFG-5` in `tests/src/flows/config-releases.flow.ts` (the default local
suite): a meta session's descriptor carries no archive, and failures from two meta
sessions leave the tip assigned. It fails with either half of the fix reverted.
`apps/api/src/config-releases/builder.test.ts` ("the meta variant is the platform
governance alone") and `__tests__/session-agent.test.ts` pin the variant. `CFG-13`
(`requires: funded, daytona`) is the real-box gate: a meta coordinator boots, answers,
and reports `proven: true` with no `fallback_reason` while the project's config holds a
tool that imports a dependency. It self-skips on the local profile and runs on a
deployed target.
