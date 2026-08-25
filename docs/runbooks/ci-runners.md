# CI runners: Blacksmith

Every Linux job in `.github/workflows/` runs on [Blacksmith](https://docs.blacksmith.sh)
runners. macOS and Windows jobs (desktop installers) stay on GitHub-hosted
runners: they are free on this public repo, and Blacksmith's Windows pool is in
beta. The GitHub "default setup" CodeQL workflow (`Code Quality: Push on main`)
is not a file in this repo and stays on `ubuntu-latest`.

Migration history: PR #6901 (Blacksmith's Migration Wizard, mechanical label
rewrite), then the follow-up that added tiers, the kill switch, the Docker layer
cache, and `tests/unit/image-build-speed-workflow.test.ts`, which pins the
convention below across all workflows.

## The convention

Every `runs-on` (and every Linux matrix `runner:`) is an expression:

```yaml
runs-on: ${{ vars.CI_RUNNER_M || 'blacksmith-4vcpu-ubuntu-2404' }}
```

The repository variable is unset in normal operation, so the Blacksmith label
applies. The variable exists as a kill switch (next section).

| Tier       | Variable           | Default label                     | Spec         | Use it for                                                                                   |
| ---------- | ------------------ | --------------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| S          | `CI_RUNNER_S`      | `blacksmith-2vcpu-ubuntu-2404`    | 2 vCPU, 8 GB | Jobs that install no dependencies: `aws`/`gh`/`curl`/`terraform` steps, retags, verify probes |
| M          | `CI_RUNNER_M`      | `blacksmith-4vcpu-ubuntu-2404`    | 4 vCPU, 16 GB | Anything that runs `pnpm install`, `bun`, typecheck, unit/e2e lanes, npm publishes           |
| L          | `CI_RUNNER_L`      | `blacksmith-8vcpu-ubuntu-2404`    | 8 vCPU, 32 GB | Container image builds, `apps/web` Next build, CodeQL analyze, the preview stack job          |
| L_ARM      | `CI_RUNNER_L_ARM`  | `blacksmith-8vcpu-ubuntu-2404-arm` | 8 vCPU, 24 GB | The `linux/arm64` legs in `build-staging.yml`                                                |
| M_2204     | `CI_RUNNER_M_2204` | `blacksmith-4vcpu-ubuntu-2204`    | 4 vCPU, 16 GB | Jobs pinned to Ubuntu 22.04: Bun cross-compiled CLI, Electron linux, installer smoke, release attach |

Rule of thumb for a new job: no dependency install → S; installs → M; builds an
image or a Next bundle → L. `tests/unit/image-build-speed-workflow.test.ts`
fails on any bare label, so a new job cannot skip the expression.

## Kill switch: move a tier back to GitHub-hosted

Use this when Blacksmith is down or jobs sit in `queued` for more than ~10 min.
A PR cannot fix a runner outage (its checks need runners), so the lever is a
repository variable, no code change:

```bash
# All Linux tiers back to GitHub-hosted (x64 = ubuntu-latest, arm = ubuntu-24.04-arm)
gh variable set CI_RUNNER_S      --repo kortix-ai/suna --body ubuntu-latest
gh variable set CI_RUNNER_M      --repo kortix-ai/suna --body ubuntu-latest
gh variable set CI_RUNNER_L      --repo kortix-ai/suna --body ubuntu-latest
gh variable set CI_RUNNER_L_ARM  --repo kortix-ai/suna --body ubuntu-24.04-arm
gh variable set CI_RUNNER_M_2204 --repo kortix-ai/suna --body ubuntu-22.04
```

Effects while the switch is on:

- Queued jobs do not move. Re-run the workflow (`gh run rerun <id>`) so the new
  label is evaluated.
- Image builds still work: `useblacksmith/setup-docker-builder` falls back to a
  plain local buildx builder, and `useblacksmith/build-push-action` builds with a
  warning instead of failing. Builds are cold (no registry cache is kept), so
  expect +2–5 min per image.
- `actions/cache`, `setup-node cache:` and `setup-bun` fall back to GitHub's
  cache backend automatically.

Back to Blacksmith:

```bash
for v in CI_RUNNER_S CI_RUNNER_M CI_RUNNER_L CI_RUNNER_L_ARM CI_RUNNER_M_2204; do
  gh variable delete "$v" --repo kortix-ai/suna
done
```

## Docker layer cache

Image builds (`deploy-dev.yml`, `build-staging.yml`, `deploy-preview.yml`, the
`self-host-schema` smoke build in `ci.yml`) use:

```yaml
- uses: useblacksmith/setup-docker-builder@v2
  with:
    cache-key: apps/api/Dockerfile:linux/amd64   # <Dockerfile>:<platform>
- uses: useblacksmith/build-push-action@v2       # same inputs as docker/build-push-action
```

- Layers live on a Blacksmith sticky disk mounted at `/var/lib/buildkit`, keyed
  by `cache-key`, shared by every workflow in the repo. Dev, staging (amd64 leg),
  preview and the CI smoke build of `apps/api/Dockerfile` therefore warm each
  other. The arm64 leg has its own key (`:linux/arm64`).
- The registry cache (`cache-from`/`cache-to: type=registry,ref=kortix/kortix-*:…-buildcache,mode=max`)
  stays on every build, on purpose. Measured 2026-08-25: five consecutive
  sticky-disk builds of `apps/api/Dockerfile:linux/amd64` (runs 32906337717,
  32907212034, 32908668613, …) reused **0** layers — even `WORKDIR /app`
  re-executed — although the disk was obtained from the previous commit and
  `/var/lib/buildkit/cache.db` changed between mounts; the registry cache on
  the same Dockerfile reused 34–45 steps (`pnpm install`, `apt-get` skipped).
  Raise with Blacksmith support before removing the registry cache again; the
  proof is `grep -c ' CACHED'` on the build job log.
- The Blacksmith builder is a separate buildkitd: a raw `docker build` that the
  job then runs locally needs `--load` (see `ci.yml` `self-host-schema`).
- Sticky disks are billed at $0.50/GB/month and evicted after 7 idle days.
- Do not script against `docker buildx imagetools inspect --format '{{.Manifest.Digest}}'`:
  buildx v0.23/v0.25 (Blacksmith image, and `setup-buildx-action`'s pin) print
  the default listing for it. Use `--format '{{json .Manifest}}' | jq -r .digest`
  (deploy-prod, deploy-dev `supply-chain`, promote-self-host-stable).
  Retag/`imagetools` jobs keep `docker/setup-buildx-action`; they build nothing.

## Checking queue time

Blacksmith pickup latency is the failure mode to watch. On 2026-08-25 (first
hour after #6901) individual jobs waited 14 s to 6 min for a runner while only
3 were running. Measure it from the job records, not from the run page:

```bash
RUN=<run id>
gh api "repos/kortix-ai/suna/actions/runs/$RUN/jobs" \
  -q '.jobs[] | "\(.status)/\(.conclusion // "-") \(.name) | runner=\(.runner_name // "-") | queued_at=\(.started_at)"'
```

`started_at` on a `queued` job is when it entered the queue. `runner_name`
starting with `blacksmith-` proves which pool ran it. If several jobs show
`queued` for > 10 min with few `in_progress`, check
<https://status.blacksmith.sh> and the org dashboard at
<https://app.blacksmith.sh/kortix-ai>, then flip the kill switch.

## Cost

GitHub-hosted minutes are free on this public repo. Blacksmith bills per
vCPU-minute after 3,000 free 2-vCPU minutes per month, plus sticky-disk
storage. The tiering above is what keeps the bill proportional: 71 of 130 job
slots are S (2 vCPU) and only 15 are L.
