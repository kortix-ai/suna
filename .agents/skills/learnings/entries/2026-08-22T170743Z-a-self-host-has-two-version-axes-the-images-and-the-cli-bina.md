---
recorded: 2026-08-22T17:07:43Z
incident_date: 2026-08-22
commit: 6894b448c7
---
# A self-host has TWO version axes — the images and the CLI binary. Updating one never updates the other

**When:** diagnosing a self-host that is "on latest", or shipping any feature
whose config the CLI renders (Caddyfile, `.env` keys, compose services).

SampleCo ran API/gateway/frontend images from `main` while `/usr/local/bin/kortix`
was **1565 commits stale**. The CLI renders the Caddyfile and owns the `.env`
schema, so the box silently lacked every CLI-side feature that had shipped since:
preview origins could not be configured (no such flag existed), and the Caddy
half of the "Bad Gateway" retry fix (PR #6702) had never landed even though its
API half was live in the image. **Check `kortix --version` before believing any
self-host diagnosis.** Upgrade with `curl -fsSL https://kortix.com/install | bash`
(needs `HOME` set under SSM, or it dies on `HOME: unbound variable`).

**Three update-semantics traps found in the same box:**
1. `resolveTag()` reads `KORTIX_CHANNEL`, **never** `KORTIX_VERSION`. A bare
   `kortix self-host update` on a box pinned to `dev-latest` with
   `KORTIX_CHANNEL=stable` rolled it **back 758 commits** to a 3-week-old
   release. Always pass `--version <ref>` explicitly on a pinned box.
2. `KORTIX_IMAGE_PULL=never` (set by a past `--local-images`) makes every update
   a silent no-op against the local Docker cache — `status` still reports
   "no drift", because drift compares config to running images, not to the registry.
3. `status`/`version` say "up to date" while tracking a floating tag. Compare the
   **registry manifest digest** to the local `RepoDigests`, or the `/health`
   `commit` to `origin/main`. A version string is not evidence.

*Incident:* no outage from the staleness itself; it hid a shipped fix for ~1 day
and blocked a customer feature.
