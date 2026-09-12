# Project snapshot (S3 config provider) — local boot benchmark, 2026-09-13

Real session boots through the real API on real Daytona sandboxes, local
MinIO as the object store. **These numbers establish local behaviour, not AWS
or production latency.** AWS/staging measurement is the user's deferred manual
gate (see `project-snapshot-s3.md`).

## Topology (exact)

| Component | Value |
| --- | --- |
| Baseline arm | worktree `suna-baseline-main` at `b3202b8f2305ee38366531959faf1bca06d0aced` (unmodified `main`), API `localhost:13908`, own cloudflared quick tunnel |
| New arms | worktree `suna-project-snapshot-s3` at the branch head, API `localhost:13608`, own cloudflared quick tunnel |
| Database | one shared local Supabase Postgres (`127.0.0.1:54322`); the two APIs are instance-scoped |
| Sandbox provider | Daytona (cloud, `us` target from `apps/api/.env`), `provider: "daytona"` pinned on every create; each round is a NEW sandbox |
| Sandbox image | one shared image per API build (`kortix-default-<hash>`: same Dockerfile, each API bakes its own daemon); no per-project images |
| Git source | GitHub managed repo (Kortix managed org) through the Kortix Git proxy on the arm's API tunnel |
| Object store | MinIO `RELEASE.2025-09-07T16-13-09Z` in Docker on the laptop; the sandbox downloads through a cloudflared quick tunnel (`KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT`) |
| Network | laptop (home network) → Cloudflare quick tunnels → Daytona; sandbox → Cloudflare → laptop |
| Driver | `apps/api/scripts/project-snapshot-bench.ts run` (arms alternate every round, 1 warm-up per arm, 10 s cooldown) |

Fixtures (both provisioned with the starter, then pushed through the Git proxy):

| Fixture | Project | Tip | Archive |
| --- | --- | --- | --- |
| representative (starter + 400 × 4 KiB random files) | `65b9e291-96f1-4979-9d94-230132536be5` | `42c4202699911653cf660e30e53fe603cdbeb2a0` | 3,177,064 B, 651 entries |
| many small files (starter + 5,000 × 512 B) | `e1b69abf-435b-4133-91d0-d743feeb10ff` | `3217623b5c8ff2f266fd49aed59ce5f413a02b98` | 5,170,441 B, 5,297 entries |
| missing archive (same shape as representative; archive object deleted, ledger left `ready`) | `6115ae0e-2e6c-4e5a-ac97-1c135acaffc4` | `4bd88b8947d8a16d675e92a76dbae318fed6480f` | 3,177,052 B, 651 entries (object removed) |

Producer cost (representative, from the worker log): build 1,066 ms, publish
56 ms; many-files: 5.17 MB / 5,297 entries built and published by the leader
worker within the push hook's enqueue → ready cycle (< 10 s observed).

## Endpoint

Primary: `POST /v1/projects/:id/sessions` → `runtimeReady:true` on the box's
`/kortix/health` (polled every 500 ms through the API proxy after `/start`
reports `ready`). Also recorded per round: API create ack, `/start` ready,
the daemon's `config_provider` report (provider, expected vs actual SHA,
attempts, fallback, per-stage timings), boot-timeline marks, the daemon build
fingerprint, and every Git-proxy request the arm's API logged for the project
from create until 5 s after readiness with its offset from readiness.

Raw rounds: `bench-*.jsonl` (kept outside the tracked tree; summaries below
come from `project-snapshot-bench.ts report`).

## Results

_(filled in from the report output — see the sections below)_

## Real-boot smoke (gate 5) — final daemon build

_(filled in)_

## Compatibility gate (gate 6)

`apps/api/scripts/project-snapshot-compat.ts` on the 5,000-file project, S3-booted
session (`config_provider.provider = s3`, sha matches), all 21 checks passed:
upload into the box → file readable → commit + authenticated push from the box
(`committed:true, pushed:true`) → API sees the session branch at the pushed
commit → file content read back at the session branch → session reload (refresh
repo) → change request created → merged into main → merged file on main → merge
enqueued a snapshot for the new base tip → uncommitted edit written → stop →
resume adopts the existing workspace (`provider:"git"`, `s3_attempted:false`,
warm 195 ms) → uncommitted edit survived → resumed session still on its branch
at the pushed commit → another account's PAT gets 403 for the descriptor (no
URL leaked) → an owner JWT is not a Git-proxy credential (401).
