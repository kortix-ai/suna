---
recorded: 2026-11-01T15:07:39Z
incident_date: 2026-11-01
---
# Pick a platform binary in a Dockerfile by TARGETARCH; dev builds amd64 only, so an arm64 break first shows at Promote

**Rule:** A Dockerfile step that downloads or installs a native binary picks its package from `TARGETARCH` (or `uname -m` in the stage that runs it), never a hardcoded `linux-x64`. The staging and prod API, gateway and web images are built for amd64 AND arm64; dev builds amd64 only, so dev cannot show an arm64 break.

**Trigger surface:** Adding or changing a `RUN` in `apps/api/Dockerfile` (or any image Build Staging builds per arch) that fetches a platform-specific artifact: an npm `*-linux-x64` package, a release tarball, a prebuilt CLI.

**Incident:** 2026-11-01, v0.14.13. PR #11283 added a `claude-code` stage that installed `@anthropic-ai/claude-agent-sdk-linux-x64` and ran `claude --version`. Dev deployed fine; the first Promote failed at Build Staging, job "Build API image (staging, arm64)", with `Exec format error`, and the release lost ~40 min. Prod runs arm64 tasks, so the Claude sign-in would also have failed there. Fixed by PR #11407 (package chosen from `TARGETARCH`).

**Enforcement:** Build Staging builds each arch natively at every Promote and blocks the release (late). None yet earlier: an arm64 build of `apps/api/Dockerfile` on dev, or a local `docker buildx build --platform linux/arm64 -f apps/api/Dockerfile .` before merging an image change.
