# Daytona linux-vm (microVM) ⇒ non-declarative build: implications

**Question:** to switch Daytona sandboxes from `container` to `linux-vm` (microVM,
~35% faster create + no 21s create-spikes), we'd have to stop using Daytona's
declarative Dockerfile builder ("not available for linux-vm or us-west-2" — per
Daytona). What does going non-declarative actually cost us?

## What "non-declarative" means here

**Today (declarative).** We never ship a finished image. At snapshot-build time we
*assemble a build context at runtime* — gzip the freshly-built `kortix-agent` +
`kortix` CLI, copy `slack-cli`, `executor-sdk`, the starter `.kortix/opencode`
config, the generated `llm-catalog.json`, and a generated `scaffold.git` — compose
the layered Dockerfile (`dockerfile-layer.ts`), and hand it to the provider via
`Image.fromDockerfile(ctx.composedPath)`. Daytona builds + caches it, content-
addressed (`kortix-default-{hash}` / `kortix-tpl-{hash}`). **Platinum does the same
thing** (uploads the context tar→S3, builds server-side with podman). So *both*
providers are declarative today — **we have zero non-declarative prior art.**

**Non-declarative.** *We* produce a finished container image, push it to a registry
Daytona can pull (configured under Daytona → Registries), and create the snapshot
from `image="<registry>/...:<tag>"`. The "authentication required" build error on a
linux-vm Dockerfile build is Daytona telling us a registry must be configured.

## Blast radius — what we'd have to build/own (none exists today)

1. **A sandbox-image build+push pipeline.** Today there is **no** sandbox-image
   build anywhere — only `kortix/kortix-api` (the API server) is built+pushed in CI.
   The sandbox "build" is runtime context-assembly. Non-declarative needs a real
   `docker build` + push, run somewhere we operate (CI or a builder fleet).
2. **A registry + auth + GC.** Pick ECR/GHCR/Docker Hub, wire creds into Daytona's
   Registries and our pipeline, and own image retention/quota (today the provider's
   `snapshot.delete` handles cleanup for us).
3. **Per-project custom Dockerfiles — the would-be killer.** Projects can declare
   `[[sandbox.templates]]` with a custom Dockerfile; Daytona builds each on-demand,
   content-addressed, shared when identical. Non-declarative means *we* build+push
   an image for every distinct (Dockerfile × spec × runtime-fingerprint) — a
   build-as-a-service. **But measured usage is ~0:** 94/94 recent sandboxes used the
   shared `kortix-default-*` image; zero `kortix-tpl-*`. So in practice this is a
   tail case, not the common path.
4. **Build-context freshness.** The context is assembled fresh each build (always the
   agent binary matching the current runtime fingerprint). Pre-building bakes it, so
   every runtime bump (`RUNTIME_LAYER_VERSION`, opencode/agent version) must
   re-trigger a build+push.
5. **Lose Daytona's on-demand build + caching** (we take ownership), and **lose
   Platinum's agent-swap fast path** (~2–3s patch vs full rebuild) when we later
   move to Platinum — both are declarative-only.

## The upside (why it's still attractive)

- **~35% faster create + eliminates the 21s `create→running` spikes** (the "30s+ on
  2× retry" — Daytona's container create hanging to the 30s timeout then retrying).
  microVM `create→running` was median ~1.1s, max 1.4s over 20 runs vs container max
  21.4s. (See `tests/performance/session-start/`.)
- **The image *build* moves entirely off the session hot path.** Pre-building means
  the 30–400s snapshot build (the rebuild landmine on any runtime change) happens in
  CI ahead of time, never at first-session. Non-declarative *fixes* that as a side
  effect.

## Recommendation: platform-default-only non-declarative

Because **~all sessions use the one shared platform-default image**, we don't need a
per-project build service. The pragmatic path:

1. Build the **platform-default** sandbox image in CI (extend the existing
   `kortix/kortix-api` buildx workflow), tagged by runtime fingerprint, pushed to a
   registry.
2. Configure that registry in Daytona (Registries).
3. Route **default-template** sessions to `linux-vm @ us-west-2` (SDK ≥0.192 for
   `SandboxClass.LINUX_VM`; add a us-west-2 client + class routing in
   `providers/daytona.ts` + `shared/daytona.ts`).
4. Leave the rare custom-`[[sandbox.templates]]` projects on the `container`/
   declarative path (us) — fall back automatically by template kind.

That captures ~all the latency + tail-stability win (and kills the image-build
landmine) for **one CI image + a registry + provider routing** — not a per-project
build-as-a-service. Full non-declarative for custom templates is a later, separate
project (or moot once we move to Platinum).

**Open item to confirm before building:** whether configuring a Daytona Registry
also re-enables Daytona to *build* our Dockerfile for linux-vm (storing the result
in our registry) — if so, even the platform-default stays declarative and this
shrinks to "configure a registry + route to linux-vm." The "authentication
required" error suggests this is plausible; worth one check with Daytona / a registry
config test before committing to owning the build.
