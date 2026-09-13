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

Reduction = `(baseline − candidate) / baseline × 100`, per percentile;
negative = slower than baseline. Rounds alternate arms; every round is a
brand-new Daytona sandbox; 1 warm-up per arm discarded.

### Fresh sandbox, prepared revision — representative project (400 files, 3.18 MB archive), 30 rounds per arm

| Scenario | Arm/build | Attempts / failures / fallbacks | Acquisition p50 / p95 | Full boot p50 / p95 | Full-boot reduction vs baseline (p50 / p95) |
|---|---|---|---|---|---|
| Fresh sandbox, prepared revision | Baseline Git (`main` `b3202b8f23`, `fast-boot-bundle` path) | 30 / 0 / — (no S3 in this build) | in-guest `repo-materialized` 1,530 / 1,936 ms | 6,326 / 10,382 ms | — |
| Same conditions | New Git provider (branch, `git` mode) | 30 / 0 / 0 | 1,030 / 1,323 ms (`repo-materialized` 1,080 / 1,352) | 5,621 / 11,106 ms | +11.1% / −7.0% |
| Same conditions | New S3 provider (branch, `prefer-s3`, 30/30 served by S3) | 30 S3 attempts / 0 failures / 0 fallbacks | 1,521 / 1,897 ms (`repo-materialized` 1,551 / 1,923) | 6,385 / 16,240 ms | −0.9% / −56.4% |

Git-proxy calls before readiness (sum over 30 rounds): baseline `GET fast-boot-bundle 200` ×30; new Git `GET fast-boot-bundle 200` ×30; new S3 `GET project-snapshot 200` ×30 and nothing else. At/after readiness the S3 arm shows the deferred history backfill pair (`info/refs` ×27, `git-upload-pack` ×19 inside the 5 s post-ready window); the Git arms' backfill happens the same way but starts right after materialization and finished inside the boot in most rounds. Every new-arm round ran the final Supervisor build (`branch-final` fingerprint ×60); every baseline round ran the legacy daemon (`legacy` ×30).

Boot breakdown (p50, ms):

| Arm | API create ack | create → daemon start (VM create + boot + entrypoint) | in-guest `repo-materialized` | in-guest `opencode-ready` | create → `runtimeReady` |
|---|---|---|---|---|---|
| Baseline Git | 658 | 3,807 | 1,530 | 2,455 | 6,326 |
| New Git | 649 | 3,585 | 1,080 | 2,052 | 5,621 |
| New S3 | 646 | 3,597 | 1,551 | 2,639 | 6,385 |

Host-side Daytona `provider-create` alone (from `kortix.provider_events`): p50 1,466 / 1,529 / 1,707 ms, p95 3,530 / 4,743 / 12,947 ms (baseline / new Git / new S3) — 24–29 % of the median boot and the whole of the tail: the two slowest S3 rounds (16.2 s, 11.5 s) spent 12.9 s and 5.9 s in `provider-create` with normal 1.0–1.8 s in-guest acquisition.

**Reading.** On this topology the S3 path is **not faster** than the existing Git path for this project. The reason is structural, not a defect: the Git arm never negotiates with GitHub here either — the API's fast-boot delta bundle (`KORTIX_FAST_GIT_BOOT_ENABLED`, one authenticated GET of a Git bundle served from the API's mirror, then a local unbundle + checkout) is already a single-object download, and it travels through one Cloudflare quick tunnel to the laptop. The S3 path costs one extra round trip (the descriptor, through the same API tunnel) plus the archive download through a second quick tunnel to a laptop-hosted MinIO, then a 651-entry streamed extraction. In-guest that is +470 ms at p50 against the same API's Git path (1,551 vs 1,080 ms), and ~60 ms against `main`'s (1,551 vs 1,530). Runtime/VM initialization dominates: acquisition is 16–24 % of the median boot; a zero-cost acquisition would remove at most ~1–1.5 s of a 6.3 s boot on this provider.

The baseline-vs-new-Git gap (+0.7 s p50 in favour of the new build) is not attributable to the refactor — the Git code path is byte-for-byte the same `acquireProjectViaGit`; the two arms differ by API process, tunnel edge assignment and image, and the p95 goes the other way. Treat it as run-to-run/tunnel variance, not a speedup.

What the local run does establish: the S3 path works end to end on real sandboxes at the exact pinned SHA with zero Git negotiation before readiness, the per-stage numbers above, and that a cross-region object store next to the sandbox is what the AWS measurement must test (deferred to the user's staging gate).

### Fresh sandbox, prepared revision — many small files (5,000 files, 5.17 MB archive, 5,297 entries), 10 rounds per arm

With 10 rounds the p95 is the second-slowest round; read it as "tail of a small sample".

| Scenario | Arm/build | Attempts / failures / fallbacks | Acquisition p50 / p95 | Full boot p50 / p95 | Full-boot reduction vs baseline (p50 / p95) |
|---|---|---|---|---|---|
| Fresh sandbox, prepared revision | Baseline Git (`main` `b3202b8f23`) | 10 / 0 / — | in-guest `repo-materialized` 1,467 / 2,650 ms | 6,013 / 9,626 ms | — |
| Same conditions | New Git provider (`git` mode) | 10 / 0 / 0 | 1,396 / 1,699 ms (`repo-materialized` 1,424 / 1,732) | 5,932 / 7,016 ms | +1.3% / +27.1% |
| Same conditions | New S3 provider (`prefer-s3`, 10/10 served by S3) | 10 S3 attempts / 0 failures / 0 fallbacks | 2,315 / 2,810 ms (`repo-materialized` 2,351 / 2,843) | 6,708 / 7,756 ms | −11.6% / +19.4% |

Git-proxy calls before readiness: baseline and new Git `GET fast-boot-bundle 200` ×10 each; new S3 `GET project-snapshot 200` ×10 and nothing else (deferred backfill at/after readiness: `info/refs` ×8, `git-upload-pack` ×3 inside the 5 s window). Fingerprints: `legacy` ×10, `branch-final` ×20. Host-side `provider-create` p50 1,649 / 1,327 / 1,633 ms, p95 2,229 / 2,229 / 2,391 ms.

Boot breakdown (p50, ms):

| Arm | API create ack | create → daemon start | in-guest `repo-materialized` | in-guest `opencode-ready` | create → `runtimeReady` |
|---|---|---|---|---|---|
| Baseline Git | 661 | 3,544 | 1,467 | 2,334 | 6,013 |
| New Git | 617 | 3,809 | 1,424 | 2,428 | 5,932 |
| New S3 | 640 | 3,335 | 2,351 | 3,373 | 6,708 |

Per-round S3 stages: warm check 2–4 ms, descriptor + download + streamed extraction 1,714–2,697 ms, activation (origin remote, session branch, `read-tree`) 93–109 ms. The extra ~0.9 s over the Git arm is the 5,297-entry streamed `tar.x` through gunzip and the entry guard, versus `git unbundle` + a native `checkout` of the same tree — file count, not bytes, is what the S3 path pays for on this CPU class. Same conclusion as the representative project: not faster locally; the in-guest extraction cost scales with entry count and must be re-measured against a same-region bucket.

### Missing archive → Git fallback (`prefer-s3`, ledger `ready`, object deleted), 10 rounds

The failure the rollout is most likely to meet: the ledger promises an archive
the bucket no longer has (lifecycle rule, manual delete, wrong bucket). The
descriptor route answers 200 with a signed URL; the download answers 404.

| Scenario | Arm/build | Attempts / failures / fallbacks | Acquisition p50 / p95 | Full boot p50 / p95 | vs new Git provider, representative (p50 / p95) |
|---|---|---|---|---|---|
| Fresh sandbox, prepared revision, archive object missing | New S3 provider (`prefer-s3`) | 10 S3 attempts / 10 failures (`download` / `missing`) / 10 fallbacks | 1,518 / 1,949 ms = failed S3 attempt 451–1,120 ms + Git 473–1,213 ms (`repo-materialized` 1,549 / 1,983) | 6,305 / 10,205 ms | −12.2% / +8.1% |

Every round: `s3_attempts: 1` (`missing` is not a transient class, so no retry), `fallback: true`, `provider: git`, exact expected SHA, `branch-final` fingerprint. Git-proxy calls before readiness: `GET project-snapshot 200` ×10 then `GET fast-boot-bundle 200` ×10, nothing else; no post-ready calls (the Git path's backfill ran inside the boot). Host-side `provider-create` p50 1,730 / p95 6,534 ms (round 2's 10.2 s boot is a 6.5 s VM create). In-guest the failed attempt costs ≈ 0.65 s at p50 — the descriptor round trip plus the signed 404 — so a stale ledger row degrades a boot by about the same amount as the S3 path saves on nothing here; the fix is the ops path (`project-snapshot.ts retry <project> <sha>` re-publishes; `status` shows the row).

### Strict mode: `require-s3` + missing archive (gate 3 on a real sandbox)

Same project and stale-`ready` ledger row, project pinned to `require-s3`,
one fresh Daytona session, the daemon's health surface polled concurrently
with `/start`:

| Surface | Observed |
| --- | --- |
| daemon `/kortix/health` | `status: "error"`, `runtimeReady: false`, `boot_error: "archive object not found (HTTP 404)"` |
| daemon `config_provider` | `mode: require-s3`, `provider: null`, `s3_attempted: true`, `s3_attempts: 1`, `s3_stage: download`, `s3_reason: missing`, `fallback: false`, `outcome: error`, `total_ms: 1109` |
| daemon boot timeline | `initial-turn-claimed@483`, `config-provider:s3:failed:missing@1134` — no `config-provider:fallback`, no `git:*` mark |
| API `POST …/start` | `stage: "failed"`, `retriable: true`, sandbox `status: "stopped"` (the API stops the box on a daemon boot error) |
| Git proxy, whole window | exactly one request: `GET …/project-snapshot?sha=4bd88b… 200`; no `fast-boot-bundle`, no `info/refs` |

Denial stays denial and cancellation never falls back are covered by the
coordinator suite (`config-provider.test.ts`: `denied` → no fallback in
`prefer-s3`; aborted signal → `cancelled`, no Git attempt). The descriptor
route's own 403 for a foreign account's PAT (no signed URL in the body) is in
the compatibility gate below. A live box whose own session token is refused the
descriptor cannot be constructed locally (the token that boots the box is the
token that reads the project), so that class on a live box is part of the
deferred staging checklist.

## Real-boot smoke (gate 5) — final daemon build

One fresh Daytona session on the representative project with the project
pinned to `require-s3`, booted from the branch's own image
(`kortix-default-ddd595915ad8`, baked from the final Supervisor build,
runtime-assets manifest sha256 `e9edbdd11d225a4d9dc63d0043bbfd48af252cc4a003f2c90fe4aafb0556e84e`
= `dist/kortix-agent` on disk):

| Measure | Value |
| --- | --- |
| API create ack | 0.73 s |
| create → `/start` ready | 6.7 s |
| create → `runtimeReady` (daemon health) | 6.95 s |
| daemon `config_provider` | `provider:s3`, `sha_matches:true`, `s3_attempts:1`, `fallback:false`, `s3_skipped:false` |
| in-guest acquisition | warm check 3 ms, S3 acquire 1,293 ms (descriptor + 3.18 MB download + streamed extraction + verify), activate 28 ms |
| Git-proxy requests, create → readiness | exactly one: `GET …/project-snapshot 200` (the descriptor exchange, −2.97 s before observed readiness) |
| Git-proxy requests at/after readiness | `GET info/refs` + `POST git-upload-pack` — the history backfill the S3 path defers until runtime readiness (observed at −0.6 s / −0.1 s relative to the bench's 500 ms-granular readiness poll, i.e. at readiness) |

The remaining startup network work observed on this path (all included in the
full-boot number): the descriptor exchange, the initial-turn claim, the managed
model prefetch, the boot-timeline relay, the runtime-projection push, and the
API-side remote session-branch publication (`createRemoteSessionBranch`, which
goes to GitHub directly and is not project acquisition).

## Runtime probes (the image's Bun, not the laptop's)

| Runtime | What ran | Result |
| --- | --- | --- |
| `oven/bun:1.2-slim` = Bun 1.2.23 (`apps/api/Dockerfile` `BUN_VERSION=1.2`, the API image) | `scripts/project-snapshot-s3-probe.ts` with the worktree's resolved `@aws-sdk/client-s3` 3.1131.0 + presigner, against MinIO over the Docker bridge | `{"ok":true,"bun":"1.2.23","buffer_put_ms":15,"conditional_put_duplicate":"PreconditionFailed/412","get_text":"{\"ok\":true}","presigned_status":200,"presigned_bytes":3145728}` |
| same | `PutObject` with a Node `createReadStream` body (the store's ORIGINAL upload shape), bounded at 40 s | never completed; `bun run` at 90 % CPU for > 5 min of CPU time. Imports (49 ms / 15 ms), MinIO reachability (3 ms), HeadBucket (15 ms) all fine → the store now uploads a whole-file Buffer (`readFile`), commit below |
| Bun 1.4.0 (laptop) | same probe against `127.0.0.1:19100` | `{"ok":true,"bun":"1.4.0","buffer_put_ms":35,…}` |
| `oven/bun:1.3.11` = the Bun that compiles `kortix-agent` (`SANDBOX_AGENT_BUN_VERSION=1.3.11`) | the daemon's `config-provider.test.ts` (22 tests, real `node:http` fake API/store, real Git scaffold fallback) after `bun install --frozen-lockfile` in the container | **before the fix: 21 pass / 1 fail** — "an interrupted transfer is retried with backoff": `reason: malformed, stage: extract, attempts: 1` instead of `unavailable ×3`. Root cause (traced with a temporary trace in `fail()`): after the mid-body socket reset Bun 1.3.11 re-issues the GET itself and appends the second response to the same body stream — the fake server saw 6 GETs for 3 attempts, the consumer saw 4,764 of 4,765 bytes (two first halves), tar reported `TAR_ENTRY_INVALID: checksum failure`, and the source emitted `close` without `end`/`error`. Bun 1.4 delivers a clean short EOF. **After the fix: 22 pass / 0 fail on both runtimes** — a decoder error while bytes are still arriving now drains to EOF and classifies there (short → `unavailable`, complete → `malformed`); an overrun past the declared size is `unavailable` (transport garbage), not `limit-exceeded`. |
| Bun 1.4.0 (laptop) | same suite | 22 pass / 0 fail before and after |

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
