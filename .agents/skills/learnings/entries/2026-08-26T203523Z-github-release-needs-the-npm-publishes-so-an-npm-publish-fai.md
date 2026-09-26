---
recorded: 2026-08-26T20:35:23Z
incident_date: 2026-08-26
commit: 9e9269b255
---
# `github-release` needs the npm publishes, so an npm-publish failure silently strips the tag, Release, changelog, and VERSION sync from a shipped prod deploy

**When:** touching `scripts/publish-npm-package.sh`, the deploy-prod publish
jobs, or diagnosing a deploy-prod run that went `failure` while
`api.kortix.com` correctly serves the new version.
`deploy-prod.yml`'s `github-release` job `needs: […, publish-sdk,
publish-agent-tunnel, …]` with the default `if: success()`. `deploy-ecs` does
NOT depend on the publishes, so the SERVICE rolls fine — but if any npm
publish fails, `github-release` (tag + GitHub Release + release notes) and the
`sync-main-version` / `sync-staging-version` / `announce` / `attach-desktop`
jobs are all SKIPPED. The result: prod serves the release, and there is no
tag, no Release, no changelog, no VERSION bump — an invisibly half-finished
release. v0.13.6 hit this: `publish-npm-package.sh` ran `npm install -g
npm@latest`, which is now `npm@12.0.2` requiring node `>=22.22.2`, while
`actions/setup-node@22` provisions `22.22.0` → `EBADENGINE`, failing
`publish-llm-catalog` + `publish-agent-tunnel` (and skipping `publish-sdk`,
which needs `publish-llm-catalog`). Same node-floor class as the
`pnpm/action-setup@v6` gate breaker the same day.
Rules: (1) after any deploy-prod that reports `failure`, verify BY HAND that
the tag, GitHub Release, and main/staging VERSION advanced — a green
`/health` is not proof the release finished; recover a skipped `github-release`
manually (`gh release create <tag> --target <prod-sha> --title … --notes-file
RELEASE_NOTES.md`, attach the run's `cli-binaries`, then bump VERSION on both
branches). (2) Pin publish tooling to a floor the runner's node satisfies
(`npm@^11.5.1`, not `@latest`). (3) Better structurally: `github-release`
should not hard-depend on the npm publishes — an npm outage should not erase
the release record; make the publish jobs `continue-on-error` or drop them
from `github-release.needs`.
*Incident:* v0.13.6 deploy-prod run 33009428048 — service live on 0.13.6, but
tag/Release/changelog/VERSION-sync skipped; recovered by hand. Script fix in
#6940; the `needs`-decoupling is still a TODO.
*Enforcer:* none — the decoupling and a post-deploy "release artifacts exist"
check are the TODOs.
