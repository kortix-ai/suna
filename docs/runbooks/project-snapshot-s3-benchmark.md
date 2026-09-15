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

| Fixture | Project | Tip | v1 archive (tree + full pack) | v2 boot object (tree + blob-less pack) | v2 blob pack (hydration) | Git delta bundle |
| --- | --- | --- | --- | --- | --- | --- |
| representative (starter + 400 × 4 KiB random files) | `65b9e291-96f1-4979-9d94-230132536be5` | `42c4202699911653cf660e30e53fe603cdbeb2a0` | 3,177,064 B, 651 entries | 1,576,450 B, 652 entries | 1,600,272 B | 1,262,707 B |
| many small files (starter + 5,000 × 512 B) | `e1b69abf-435b-4133-91d0-d743feeb10ff` | v1 `3217623b5c8ff2f266fd49aed59ce5f413a02b98`, v2 `81bbe87e54c3415a501b01076647bb3c8ff6df00` (tip moved by the compat gate's merge) | 5,170,441 B, 5,297 entries | 2,600,219 B, 5,301 entries | 2,604,190 B | 2,267,086 B |
| missing archive (same shape as representative; object deleted, ledger left `ready`) | `6115ae0e-2e6c-4e5a-ac97-1c135acaffc4` | `4bd88b8947d8a16d675e92a76dbae318fed6480f` | 3,177,052 B | 1,576,308 B | 1,600,266 B | 1,262,708 B |

The v2 boot object is 50 % of the v1 archive for both fixtures; the remaining
gap to the Git delta bundle (+25 % / +15 %) is the starter's files, which the
bundle never transfers because the image bakes the scaffold.

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

## v2 results (blob-less boot object, native extraction, blob pack hydrated off the boot path)

Same topology, same fixtures re-prepared under `project-snapshot-v2`, Supervisor
sha256 `33345f23…`, image `kortix-default-14a4dd64f7aa`, run 2026-09-13
13:59–14:38 UTC, arms alternating every round, 1 warm-up per arm discarded.
Baseline = unmodified `main` (`b3202b8f23`) on its own API and tunnel.

### Fresh sandbox, prepared revision — representative project (400 files; boot object 1.58 MB / 652 entries, blob pack 1.60 MB), 30 rounds per arm

| Scenario | Arm/build | Attempts / failures / fallbacks | Acquisition p50 / p95 | Full boot p50 / p95 | Reduction vs baseline (p50 / p95) |
|---|---|---|---|---|---|
| Fresh sandbox, prepared revision | Baseline Git (`main`) | 30 / 0 / — | in-guest `repo-materialized` 1,055 / 1,398 ms | 6,556 / 8,863 ms | — |
| Same conditions | New Git provider (`git` mode) | 30 / 0 / 0 | 1,181 / 1,726 ms (`repo-materialized` 1,212 / 1,760) | 6,374 / 13,179 ms | +2.8 % / −48.7 % |
| Same conditions | **New S3 provider v2** (`prefer-s3`) | 30 S3 attempts / 1 failed acquisition / 1 fallback (29 served by S3) | 1,383 / 3,140 ms (`repo-materialized` 1,412 / 3,174) | 6,785 / 9,551 ms | −3.5 % / −7.8 % |

Hydration (S3 arm, 29 rounds): `ok` 29/29, blob-pack import p50 617 / p95 944 ms,
in-guest `config-provider:hydrate:ok` at 2,024 / 3,485 ms versus `opencode-ready`
at 2,578 / 4,696 ms — the repository was fully hydrated **before the harness
was ready** at both percentiles; the settled state was observed 6,977 ms
(p50) after create, ~190 ms after `runtimeReady`. Extractor `tar` ×29. Git
proxy before readiness: `GET project-snapshot 200` ×38 (30 rounds + 8 retried
attempts), `GET fast-boot-bundle` ×1 (the fallback round); at/after readiness
the deferred blob-less backfill (`info/refs` ×27, `git-upload-pack` ×29). In 2
rounds an `info/refs` + `git-upload-pack` pair completed 1.1–1.2 s before the
bench observed readiness: within the readiness-poll lag of the deferred
backfill (which starts at real readiness), though a lazy blob fetch during the
blob-less window would look identical on the proxy — the in-guest daemon log,
not collected by the bench, is what disambiguates.

Retries: rounds 10, 11, 21, 27, 30 needed 2–3 attempts and round 13 fell back
to Git after 3 (3,145 ms of S3 time + 627 ms Git), every failure classified
`unavailable` at `download`. The API answered every descriptor request 200 in
under 500 ms, so the transient failures sat on the laptop-MinIO quick-tunnel
leg; the Git arms' bundle travels the other quick tunnel and saw none. The
retry/fallback design absorbed all of them (0 boot failures); their cost is
the S3 arm's p95.

Boot breakdown (p50, ms): create ack 759 / 756 / 753; create → daemon start
4,183 / 4,037 / 3,938; in-guest `repo-materialized` 1,055 / 1,212 / 1,412;
in-guest `opencode-ready` 2,235 / 2,374 / 2,578 (baseline / new Git / new S3).
Host-side Daytona `provider-create` p50 1,634 / 1,677 / 1,860 ms, p95 4,895 /
8,162 / 4,731 ms — 26–30 % of the median boot and, again, the tail.

### Fresh sandbox, prepared revision — many small files (5,000 files; boot object 2.60 MB / 5,301 entries, blob pack 2.60 MB), 10 rounds per arm

| Scenario | Arm/build | Attempts / failures / fallbacks | Acquisition p50 / p95 | Full boot p50 / p95 | Reduction vs baseline (p50 / p95) |
|---|---|---|---|---|---|
| Fresh sandbox, prepared revision | Baseline Git (`main`) | 10 / 0 / — | in-guest `repo-materialized` 1,602 / 2,075 ms | 6,580 / 7,325 ms | — |
| Same conditions | New Git provider (`git` mode) | 10 / 0 / 0 | 1,524 / 13,058 ms (`repo-materialized` 1,553 / 13,087) | 6,260 / 24,218 ms | +4.9 % / −230.6 % |
| Same conditions | **New S3 provider v2** (`prefer-s3`) | 10 / 0 / 0 (1 retried attempt) | 1,648 / 2,307 ms (`repo-materialized` 1,679 / 2,340) | 6,777 / 14,679 ms | −3.0 % / −100.4 % |

With 10 rounds the p95 is the second-slowest round: the new Git arm's 24.2 s
boot is one round whose bundle fetch took 13 s in-guest (the Git path has its
own tail), and both new arms' tails include a 9.5 s `provider-create`.
Hydration: `ok` 10/10, import p50 565 / p95 987 ms, in-guest hydrated at 2,310 /
3,411 ms versus ready at 2,942 / 3,407 ms. Extractor `tar` ×10. Git proxy
before readiness: `GET project-snapshot 200` ×11 only.

### Missing boot object → Git fallback (`prefer-s3`, ledger `ready`, tree object deleted), 10 rounds

| Scenario | Arm/build | Attempts / failures / fallbacks | Acquisition p50 / p95 | Full boot p50 / p95 |
|---|---|---|---|---|
| Fresh sandbox, prepared revision, boot object missing | New S3 provider v2 (`prefer-s3`) | 10 / 10 (`download` / `missing`) / 10 | 1,722 / 2,175 ms = failed attempt 501–1,272 ms + Git 716–1,168 ms | 6,557 / 9,023 ms |

Every round: one attempt (`missing` is not transient), `fallback: true`,
`provider: git`, exact SHA, `hydration: null`; proxy: `GET project-snapshot 200`
×10 then `GET fast-boot-bundle 200` ×10, nothing else. The strict-mode
behaviour (`require-s3` + missing → boot error, no fallback) is unchanged from
the v1 run below and is covered by the suite on both runtimes.

### v1 → v2, and the reading

| In-guest, p50 | v1 S3 | v2 S3 | New Git (same runs) |
|---|---|---|---|
| Representative: acquisition | 1,521 ms | **1,383 ms** (−9 %) | 1,181 ms |
| Representative: `repo-materialized` | 1,551 ms | **1,412 ms** | 1,212 ms |
| 5,000 files: acquisition | 2,315 ms | **1,648 ms** (−29 %) | 1,524 ms |
| 5,000 files: `repo-materialized` | 2,351 ms | **1,679 ms** | 1,553 ms |
| Bytes on the boot path | 3.18 MB / 5.17 MB | 1.58 MB / 2.60 MB | 1.26 MB / 2.27 MB |
| Extraction | node-tar (JS) | system `tar` | native `checkout` |
| Git on the boot path | `rev-parse`, `checkout -B`, `read-tree` | `rev-parse` only (verify) | `unbundle`, `checkout` |

v2 removed the byte duplication and the JS extraction, and the 5,000-file
project shows it: the S3 arm went from +920 ms over the Git path in-guest to
+124 ms. What remains on this topology is round trips, not bytes: the
descriptor and the object's time-to-first-byte are each a transatlantic hop
through a Cloudflare quick tunnel to a laptop (≈ 250–400 ms apiece), and the
Git path pays only one of them. Full boot is at parity with both Git arms
(−3.5 % / −3.0 % at p50, inside the round-to-round noise), with the working
tree ready at `repo-materialized` and the blobs in place before the harness
listens. In the same AWS region those two hops collapse to ~30 ms each, which
puts the v2 acquisition at roughly 100–250 ms (descriptor, one small GET,
native extraction of a few thousand entries, `rev-parse`, activation) against
the bundle path's native unbundle + checkout; that measurement is the deferred
staging gate. Either way, VM creation stays 26–30 % of the median boot and all
of the tail; acquisition is now 20 % of it.

## v2 — smoke and compatibility

Supervisor build sha256 `33345f23472c24e3523fe64c6c667307a0bd49a4da908ed7ffbcf5b8a9c879b0`
(runtime-assets manifest = `dist/kortix-agent`), image `kortix-default-14a4dd64f7aa`.

First `prefer-s3` boot of the representative project on that image (one round):

| Measure | Value |
| --- | --- |
| create → `runtimeReady` | 7,254 ms (`/start` ready 7,065 ms) |
| daemon `config_provider` | `provider: s3`, `sha_matches: true`, `s3_extractor: "tar"`, `timings: {warm: 2, s3_acquire: 1383, s3_activate: 26, s3_hydrate: 554}` |
| in-guest marks | `config-provider:s3:ok` = `repo-materialized` @ 1,441 ms; `config-provider:hydrate:ok` @ 2,009 ms; `opencode-listening` @ 2,659 ms; `opencode-ready` @ 2,680 ms |
| hydration | `{status: ok, attempts: 1, bytes: 1,600,272, ms: 554}` — settled 650 ms before the harness listened, i.e. the workspace was fully hydrated before readiness on this topology |
| Git proxy before readiness | `GET project-snapshot 200` at −3,104 ms, nothing else |
| Git proxy at/after readiness | `info/refs` −495 ms, `git-upload-pack` −27 ms: the deferred blob-less history backfill (offsets are relative to the bench's 500 ms-granular readiness poll) |

Compatibility gate on the 5,000-file project, v2 S3-booted session, **23/23**
(the 21 checks of gate 6 plus): `boot object was extracted by the system tar`
(`extractor=tar`) and `blob-pack hydration settled ok after readiness`
(`{status: ok, attempts: 1, bytes: 2,604,190, ms: 639}`), followed by upload →
commit + push from the box → read-back → reload → change request → merge →
stop / resume (adopts the workspace, `provider: git`, `s3_attempted: false`) →
foreign PAT 403 on the descriptor → owner JWT 401 on the proxy.

## Platinum run (same topology, provider pinned to `platinum`), 2026-09-14

Same local topology (API and MinIO each behind a cloudflared quick tunnel),
same fixtures and the same v2 objects as the run above, provider pinned per
session (`POST /sessions {"provider":"platinum"}`), daemon fingerprint
`branch-v2` on every round, 1 warm-up per arm discarded, arms alternating.
Run 11:58–12:28 UTC. No baseline arm: `main` has no Platinum-specific boot
path, and the question is Git versus S3 on the same provider. `PLATINUM_TEMPLATE`
is unset locally, so every session boots from the per-project template the
snapshot builder materialises.

### Representative project (400 files), 30 rounds per arm

| Arm/build | Attempts / failures / fallbacks | Acquisition p50 / p95 | `repo-materialized` p50 / p95 | Full boot p50 / p95 (min / max) |
|---|---|---|---|---|
| New Git provider (`git` mode) | 30 / 0 / 0 | 620 / 1,480 ms | 706 / 1,569 ms | 11,867 / 12,954 ms (11,467 / 13,524) |
| **New S3 provider v2** (`prefer-s3`) | 30 S3 attempts / 3 failed acquisitions / 3 fallbacks (27 served by S3) | 1,318 / 2,508 ms on the 27 S3 rounds (arm-wide 1,413 / 2,902) | 1,493 / 2,977 ms | 11,743 / 12,564 ms (8,186 / 12,619) |

Hydration (27 S3 rounds): `ok` 27/27, blob-pack import p50 418 / p95 1,135 ms,
in-guest `config-provider:hydrate:ok` at 1,937 / 3,080 ms versus
`opencode-ready` at 7,396 / 7,524 ms on the same rounds — the repository was
fully hydrated 5.4 s before the harness was ready at p50. Extractor `tar` ×27.
The settled hydration state was observed 11,950 ms (p50) after create, ~200 ms
after `runtimeReady`.

Retries: 21 of 30 S3 rounds needed 2–3 download attempts (Daytona: 6 of 30),
and rounds 15, 29 and 30 fell back to Git after 3 (2,313–2,410 ms of S3 time +
452–542 ms Git); every failure `unavailable` at `download`. 60 descriptor
requests for 30 rounds, because every attempt re-presigns. The Git arm's bundle
crosses the other quick tunnel and saw none of it. The laptop–MinIO tunnel leg
was flakier from Platinum's network than from Daytona's during this half hour
(the many-files phase 20 minutes later had 0 retries in 10 rounds); the
retry/fallback design absorbed all of it — 0 boot failures — at the cost of the
S3 arm's acquisition p95.

Git proxy before readiness: Git arm `GET fast-boot-bundle 200` ×30 (plus one
`info/refs` + `git-upload-pack` pair); S3 arm `GET project-snapshot 200` ×60
and `GET fast-boot-bundle 200` ×3 (the fallback rounds). At/after readiness the
S3 arm's deferred backfill: `info/refs` ×24, `git-upload-pack` ×14.

### Many small files (5,000 files), 10 rounds per arm

| Arm/build | Attempts / failures / fallbacks | Acquisition p50 / p95 | `repo-materialized` p50 / p95 | Full boot p50 / p95 |
|---|---|---|---|---|
| New Git provider (`git` mode) | 10 / 0 / 0 | 1,003 / 1,166 ms | 1,087 / 1,281 ms | 11,934 / 12,471 ms |
| **New S3 provider v2** (`prefer-s3`) | 10 / 0 / 0 (0 retried attempts) | 942 / 1,337 ms | 1,072 / 1,473 ms | 12,009 / 13,015 ms |

Hydration: `ok` 10/10, import p50 418 / p95 568 ms, hydrated at 1,618 / 2,015 ms
versus ready at 7,503 / 7,613 ms. Extractor `tar` ×10. Proxy before readiness:
S3 arm `GET project-snapshot 200` ×10 only; Git arm `GET fast-boot-bundle` ×10
(plus two `git-upload-pack`). At/after readiness: `info/refs` ×8,
`git-upload-pack` ×8.

### Daytona versus Platinum (same fixtures, same objects; in-guest marks p50 / p95, ms)

| Measure | Daytona Git | Daytona S3 | Platinum Git | Platinum S3 |
|---|---|---|---|---|
| `repo-materialized`, 400 files | 1,212 / 1,760 | 1,412 / 3,174 | 706 / 1,569 | 1,493 / 2,977 |
| `repo-materialized`, 5,000 files | 1,553 / 13,087 | 1,679 / 2,340 | 1,087 / 1,281 | 1,072 / 1,473 |
| `opencode-listening`, 400 files | 2,334 / 4,330 | 2,549 / 4,682 | 7,271 / 7,501 | 7,356 / 7,504 |
| `opencode-ready`, 400 files | 2,374 / 4,582 | 2,578 / 4,696 | 7,288 / 7,520 | 7,385 / 7,524 |
| create ack (host), 400 files | 756 | 753 | 781 | 813 |
| full boot, 400 files | 6,374 / 13,179 | 6,785 / 9,551 | 11,867 / 12,954 | 11,743 / 12,564 |

Reading: the config path costs the same on both providers — S3 is at parity
with Git inside the tunnel noise on both, and 60 ms faster at p50 on the
5,000-file project on Platinum. Platinum's ~5 s longer full boot is entirely
in-guest harness start: OpenCode listens at ~7.3 s on Platinum versus
~2.3–2.5 s on Daytona, while the Git arm materialises the repository *earlier*
on Platinum than on Daytona. Platinum's tail is tighter — p95 within 1.1 s of
p50 in every arm, where Daytona's Git arm had a 13 s bundle fetch and a 24 s
boot. As on Daytona, the numbers compare the two paths against each other
under two transatlantic tunnel hops; absolute in-region speed needs the
preview or dev deployment.

### Compatibility gate on Platinum — 23/23

`project-snapshot-compat.ts --provider platinum` on the 5,000-file project,
S3-booted session (`provider: s3`, `sha_matches: true`, extractor `tar`,
hydration `{status: ok, attempts: 1, bytes: 2,604,298, ms: 420}`): upload →
commit + push from the box → read-back → reload → change request → merge
(enqueues the new tip) → stop / resume → uncommitted edit survived → still on
the session branch at the pushed commit → foreign PAT 403 on the descriptor
(no `X-Amz-` in the body) → owner JWT 401 on the proxy.

The first pass stopped at the stop/resume check with `provider: s3,
s3_attempted: true`, which on Daytona would mean a re-acquisition. It is not
one: Daytona restarts the container on resume, so the daemon re-runs and must
adopt the workspace warm (`provider: git`, `timings: {warm: 235}`, no S3
attempt — re-verified the same hour). Platinum wakes the **same** VM with the
**same** daemon process — `opencode_pid` unchanged, `uptime_s` 8 → 50, the
boot-1 `config_provider` summary reported verbatim — and the uncommitted file
is still there (`file/raw` 200 with its content). A re-acquisition on resume
would show `provider: s3` with *new* timings. The check now accepts either
"restarted and adopted warm" or "same daemon continued" and prints which one
it saw (`adoptedWarm` / `daemonContinued`); the two provider behaviours are
both "never re-acquired", which is the contract.

## Local, no sandbox: the two paths at loopback (config-provider bench), 2026-09-14

Every sandbox run above pays two transatlantic tunnel hops, so it cannot say
what the two acquisitions cost by themselves. This run removes the network:
`apps/kortix-sandbox-agent-server/scripts/config-provider-bench.ts` runs the
daemon's own config-provider coordinator (`materializeProject`) on the laptop,
in a fresh workspace per round, with the exact environment the API hands a
fresh session — scaffold + remote delta bundle for Git (the production route,
verified per round from the daemon log), pinned descriptor + presigned objects
for S3 — against the local API on `13608` and MinIO on `19100`
(`KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT=http://127.0.0.1:19100` so the
presigned URLs stay on loopback). Same fixtures and objects as the sandbox
runs; arms alternate every round, 1 warm-up discarded, macOS `bsdtar`.

| Project | Git (scaffold + bundle) p50 / p95 | S3 (`prefer-s3`) p50 / p95 | S3 stages p50 | Hydration |
|---|---|---|---|---|
| 400 files (boot object 1.58 MB) | 227 / 247 ms | **216 / 224 ms** | descriptor + download + extract + verify 90, activate 116, hydrate 21 (off the boot path) | ok 30/30 |
| 5,000 files (boot object 2.60 MB) | **534 / 603 ms** | 542 / 599 ms | 417 / 116 / 40 | ok 30/30 |

30 rounds per arm and project, 0 failures, 0 fallbacks, `extractor: tar`
×60, Git route `repo materialized via scaffold (one request: remote API
delta bundle)` ×60.

The same Git arm for a repository that shares **no** scaffold ancestor (an
imported repo, another starter — the daemon's clone route, `cloning repo`
×20), 10 rounds:

| Project | Git (clone through the proxy) p50 / p95 | S3 from above |
|---|---|---|
| 400 files | 896 / 995 ms | 216 / 224 ms |
| 5,000 files | 1,210 / 2,434 ms | 542 / 599 ms |

Reading:

- **With the network removed, the fast-boot Git path and the S3 path cost
  the same.** Both are one GET plus local work; S3's 116 ms activation
  (session branch, `symbolic-ref`, partial-clone config) is what the bundle
  route spends applying the bundle. Everything the sandbox runs saw on top of
  this was network: two tunnel hops for S3 (descriptor, object) against one
  for Git (bundle).
- **What S3 actually buys.** (1) In production the bundle GET goes sandbox →
  API (a different region) while the S3 object GET stays in-region; the
  descriptor call still crosses, so the expected in-region gain is the
  object's transfer, a few hundred ms for these sizes — the dev deployment
  measures it. (2) For a project **without** the scaffold root — imported
  repositories, other starters — Git is a proxied clone: 4× slower on the
  small project and 2.2× on the large one already at loopback, and 9 s
  through the dev tunnel in the 2026-06-13 measurement. S3 does not care how
  the project was born. (3) The boot no longer depends on the Git proxy's
  upstream being reachable or on the mirror's refresh; that predictability
  was the motivation for the blob-less v2 format.
- **What it does not buy:** a faster boot for a scaffold-rooted project in
  the same region as its API. Do not expect the dev numbers to show one.

Re-run: the usage block at the top of `config-provider-bench.ts`. Inputs: the
pin is `<sha>:<tree_sha256>:<tree_bytes>` from `project-snapshot.ts status`;
the scaffold root and the parent commit payload are the project's cached hint
(`metadata.git.fast_boot.parent_sha` / `.parent_commit_base64`, populated by
any earlier session create); the local API must presign for an endpoint the
laptop reaches (`KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT`). `--scaffold
/nonexistent` measures the clone route.

## Presign at create + no HEAD on the boot path (PR #7242), 2026-09-15

Same local topology and fixtures as the v2 run (Daytona, laptop API and MinIO
behind two quick tunnels), 20 rounds per arm on the representative project,
daemon rebuilt from the branch (fresh image), arms alternating, 1 warm-up
discarded. The change under test: the session env carries the presigned
descriptor (`KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR`), so an S3 boot's first
attempt is one GET from the store; the object `HEAD` checks left the create
and descriptor paths.

| Arm/build | Attempts / failures / fallbacks | Acquisition p50 / p95 | `repo-materialized` p50 / p95 | Full boot p50 / p95 | Descriptor source |
|---|---|---|---|---|---|
| New Git provider (`git` mode) | 20 / 0 / 0 | 1,111 / 1,273 ms | 1,151 / 1,309 ms | 6,393 / 7,903 ms | — |
| **New S3 provider v2 + presign** (`prefer-s3`) | 20 S3 attempts / 1 failed acquisition / 1 fallback (19 served by S3) | **971 / 3,340 ms** (927 / 2,731 in-guest `s3_acquire`) | 1,036 / 3,374 ms | 6,529 / 10,080 ms | env 16, proxy 3 |

Against the v2 run on the same topology (30 rounds, 2026-09-13): S3
acquisition 1,383 → **971 ms** at p50 (−30 %), Git 1,181 → 1,111 ms (noise).
S3 is now 13 % under Git at the median on this topology; `repo-materialized`
1,036 vs 1,151 ms. The removed leg — descriptor round trip through the tunnel
plus the API's object checks — was worth ~400 ms here.

Git proxy before readiness, S3 arm: `GET project-snapshot 200` ×7, all on the
four retry rounds (2, 5, 8, 18 — the design: a retry asks the proxy for fresh
URLs), `GET fast-boot-bundle` ×1 (the fallback round). The 16 clean rounds made
**no proxy request at all** before readiness. Retries and the fallback are the
MinIO quick-tunnel leg (`unavailable` at `download`) as in every run on this
topology; they are the S3 arm's p95. Hydration `ok` 19/19 (import p50 534 ms,
in-guest `hydrate:ok` at 1,617 ms vs `opencode-ready` at 2,296 ms).

Compat gate on the branch (Daytona, 5,000-file project): **23/23**, the S3
boot with `s3_acquire: 1186 ms`, stop/resume `adoptedWarm`.

### Where the sandboxes are: S3 first byte from a Daytona box

A plain Daytona box in the `us` target (New York, Latitude.sh) timing the
regional S3 endpoints with `curl` (4 samples each, all within a few ms):

| Region | TCP connect | TLS done | First byte |
|---|---|---|---|
| us-east-1 | 9 ms | 23 ms | **32 ms** |
| us-east-2 | 21 ms | 43 ms | 65 ms |
| us-west-2 (the dev bucket, and the API) | 62 ms | 127 ms | 189 ms |
| us-west-1 | 66 ms | 130 ms | 193 ms |
| eu-west-2 | 73 ms | 148 ms | 220 ms |
| eu-central-1 | 89 ms | 178 ms | 264 ms |

A bucket in us-east-1 would cut ~160 ms per request from the box — one
request on the boot path, one for hydration — on top of the presign gain. The
Git bundle GET crosses the same distance to the us-west-2 API behind
Cloudflare, so moving only the bucket is a gain Git cannot match without moving
the API. Not done in #7242 (decision pending); the shape is a second bucket via
a provider alias plus `KORTIX_PROJECT_SNAPSHOT_S3_BUCKET/REGION` in the deploy
workflow — see the main runbook's AWS section.

### Real S3 (a throwaway account, bucket in eu-north-1), 2026-09-15

The same run with the local API pointed at a **real** bucket built from the
repo's module in a throwaway AWS account (`tmp` Terraform root, destroyed
afterwards). The account's organization policy allows eu-north-1 only, so the
objects sat in Stockholm while the Daytona boxes sat in the US (`us` target =
New York or Los Angeles; first byte to Stockholm 510 ms from LA). The Git
bundle still came from the laptop through the quick tunnel. Presign branch,
20 rounds per arm, 400-file project.

| Arm/build | Attempts / failures / fallbacks | Acquisition p50 / p95 | `repo-materialized` p50 / p95 | Full boot p50 / p95 | Descriptor source |
|---|---|---|---|---|---|
| New Git provider (`git` mode) | 20 / 0 / 0 | 1,052 / 1,374 ms | 1,084 / 1,402 ms | 5,807 / 8,187 ms | — |
| **New S3 provider v2 + presign** (`prefer-s3`), real S3 eu-north-1 | 20 / 0 / 0 (1 retried) | **1,195 / 26,636 ms** — the 17 ordinary rounds: 1,132 / 1,656 ms (min 950, max 2,521) | 1,226 / 26,667 ms (17 ordinary: 1,219 / 1,727) | 6,401 / 31,312 ms (17 ordinary: 6,368 / 8,833) | env 19, proxy 1 |

19 of 20 S3 boots made **no Git-proxy request before readiness**; the one
`GET project-snapshot` is round 20's retry (first transfer refused, fresh
proxy descriptor, done in 2.5 s). Hydration `ok` 20/20, import p50 304 ms.
Extractor `tar` ×20. A first attempt of this run (8 valid rounds before the
test account's 15-minute exported keys expired — see the main runbook's TTL
note) measured the same median: `s3_acquire` p50 1,178 ms.

**The tail is the distance.** Three rounds (1, 17, 19) completed in one
attempt but took 14.8, 26.6 and 29.6 s: the 1.5 MB object trickled across the
Atlantic at well under 100 KB/s without ever pausing for the 12 s inactivity
watchdog, and their hydration (the 1.6 MB pack) took 1.8–4.9 s the same way.
Nothing like it happened on the Git arm, whose bundle rides a Cloudflare-fronted
path. Fifteen percent of boots stretched to 15–30 s is not acceptable for a
default, and it is the strongest argument for the bucket being in the boxes'
own region.

Reading: at a transatlantic distance from the sandbox — comparable to, and a
little further than, dev's cross-country bucket — the S3 boot is level with
the Git bundle at the median (1,132 vs 1,052 ms on the ordinary rounds)
instead of 800 ms behind, because the descriptor round trip is gone. What
remains is the first-byte distance: TLS + one GET to Stockholm is ~1 s of the
1.13 s. From a bucket in the boxes' own region (32 ms first byte from New
York to us-east-1, 101 ms from LA to us-west-2) the same request is several
hundred milliseconds shorter and the trickling tail should disappear with the
distance; that case could not be measured because the test account's policy
denied US buckets, and it is where S3 would pull clearly ahead of Git.

### Real S3, bucket in the boxes' region (us-east-2), plain and accelerated, 2026-09-15

A second throwaway account with every region open: the same module in
**us-east-2** (Ohio, 65 ms first byte from the New York boxes) with S3
Transfer Acceleration enabled on the bucket, so the plain regional endpoint and
the accelerated endpoint (`KORTIX_PROJECT_SNAPSHOT_S3_ACCELERATE=true` on the
API, presigned URLs on `<bucket>.s3-accelerate.amazonaws.com`) were measured
against the same objects. Presign branch, 20 rounds per arm, 400-file project,
Git bundle from the laptop through the quick tunnel as before.

| Arm | Attempts / failures / fallbacks | Acquisition p50 / p95 | `repo-materialized` p50 / p95 | Full boot p50 / p95 | Descriptor source |
|---|---|---|---|---|---|
| New Git provider (`git` mode) | 20 / 0 / 0 | 944 / 1,239 ms | 962 / 1,278 ms | 6,053 / 10,065 ms | — |
| **S3 v2 + presign, plain us-east-2** | 20 / 0 / 0 (2 retried) | **315 / 1,192 ms** (283 / 1,158 in-guest) | 344 / 1,222 ms | **9,776 / 11,291 ms** | env 18 / proxy 2 |
| New Git provider (`git` mode), accelerated run | 20 / 0 / 0 | 1,047 / 1,351 ms | 1,074 / 1,383 ms | 5,994 / 9,573 ms | — |
| **S3 v2 + presign, Transfer Acceleration** | 20 / 0 / 0 (5 retried) | 352 / 1,185 ms (397 / 1,143 in-guest) | 385 / 1,205 ms | 9,109 / 11,870 ms | env 15 / proxy 5 |

Hydration `ok` 20/20 in both runs (import p50 87 ms plain, 157 ms
accelerated). No trickling tail: max acquisition 1.2 s plain against the
26–30 s tail from Stockholm. **Transfer Acceleration buys nothing this
close** (352 vs 315 ms at the median, 5 retries instead of 2): its edge is a
first-hop optimisation for long paths, and New York → Ohio is not one. Keep
the bucket in the boxes' region; leave acceleration off.

From the box's region the S3 acquisition is **3× faster than the Git
bundle** (315 vs 944 ms) — and yet the S3 boot reached `runtime_ready` **3.7 s
later** (9.8 vs 6.1 s at p50). That gap is not S3; it is the section below.

### The daemon versus OpenCode's bind→handler window (found 2026-09-15, fixed in #7242)

In-guest marks, medians of the plain run above (ms after daemon start):

| mark | Git | S3 |
|---|---|---|
| `repo-materialized` | 1,037 | 344 |
| `managed-reconcile` (root-list poll + `/event` subscribe start here) | 1,634 | 811 |
| `opencode-listening` (root list answered) | 2,272 | 6,245 |
| `opencode-ready` | 2,298 | 6,260 |

Per round the S3 arm was bimodal: 16 rounds with the root list answered at
6.0–6.4 s, 4 rounds (the ones whose checkout landed after 1.2 s) at 2.0–2.3 s.
The two Git rounds whose checkout landed before 0.65 s showed the same 6.2 s.

**Mechanism.** OpenCode 1.18.23 builds its server with Effect's
`NodeHttpServer`: `make` calls `server.listen()` and returns once the port is
bound; `on("request", handler)` is attached later, in `serve`, after the
router is built. For ~100 ms the kernel accepts connections, Node parses the
request, the `request` event has no listener, and the request is never
answered and never retried — the client waits for its own timeout. Reproduced
inside a box with a plain-socket sprayer against a second `opencode serve`
(native binary, port 4210): connections accepted 0.645–0.747 s after spawn
(6 of 6) were never answered; every connection from 0.767 s was answered in
≤18 ms. Identical with an empty cwd and no config dir. A 100 ms poll always
lands in that window once: 12/12 trials against a fake server with a 110 ms
dead window, Bun and Python alike, each losing the full 5 s timeout.

**What the daemon lost.** The readiness probe (2 s timeout) lost 2 s on every
boot, S3 and Git alike (`opencode-http-listening` at 3.6–3.8 s). The root-list
poll (5 s timeout) lost 5 s whenever it was already polling when the port
bound — every S3 boot with an early checkout — and that is the whole 3.7 s
boot gap. The `/event` subscribe had **no timeout**: on those boots it hung
for the life of the session (`ss`: 184 bytes sent, 0 received after 112 s, no
`[opencode-events] subscribed` line), so the daemon never saw `session.idle`.
A prompt on such a session: OpenCode finished the answer in 6 s, the API
closed the turn 18.4 s after start with `end_reason = unknown` (the reaper),
against 3.1 s and `completed` on a Git session whose subscribe had connected.

**Fix (daemon, `kortixd`).** Until the current OpenCode has answered once,
the supervisor probes only the instance-free liveness route with a 300 ms
timeout (`LISTENING_PROBE_TIMEOUT_MS`), and exposes that first answer as
`waitForCurrentListeningResponse()`. The root-list gate
(`waitForFastOpencodeRootReadiness`) waits on it on every boot, not only under
the fast-cold-boot flag; the `/event` loop waits on it before every attempt and
bounds the header phase of a subscribe at 10 s. Git keeps its timing (its
polling already started after the window); S3 boots no longer pay the 5 s.
Measured after the fix: see the next subsection.

### After the fix (same Ohio bucket, plain endpoint), 2026-09-15

Daemon rebuilt with the fix (new image `kortix-default-5b883d908877`), 10
rounds per arm, everything else as in the plain run above.

| Arm | Attempts / failures / fallbacks | Acquisition p50 / p95 | `repo-materialized` p50 / p95 | Full boot p50 / p95 | Descriptor source |
|---|---|---|---|---|---|
| New Git provider (`git` mode) | 10 / 0 / 0 | 955 / 1,423 ms | 996 / 1,456 ms | 6,215 / 7,498 ms | — |
| **S3 v2 + presign, plain us-east-2** | 10 / 0 / 0 (1 retried) | **361 / 1,136 ms** (287 / 1,061 in-guest) | 395 / 1,166 ms | **6,273 / 11,156 ms** | env 9 / proxy 1 |

In-guest marks, medians (ms after daemon start), before → after:

| mark | Git before | Git after | S3 before | S3 after |
|---|---|---|---|---|
| `repo-materialized` | 1,037 | 996 | 344 | 395 |
| `opencode-http-listening` (first answer) | 3,625 | **1,429** | 3,843 | **1,548** |
| `opencode-listening` (root list answered) | 2,272 | 2,043 | 6,245 | **2,191** |
| `opencode-ready` | 2,298 | 2,061 | 6,260 | **2,208** |

Every S3 round answered the root list 0.5–0.7 s after OpenCode's first
answer; no round lost a timeout; `[opencode-events] subscribed` on every
boot (+1.1 s on the probe session). The S3 boot is 3.5 s shorter at p50
(9,776 → 6,273 ms) and now equal to Git's 6,215 ms. The remaining spread is
outside the guest: S3 round 4 reached `opencode-ready` at 1,982 ms in-guest
and `runtime_ready` at 11,156 ms — sandbox provisioning, the same class as
Git's round 2 (7,498 ms with `opencode-ready` at 2,005 ms).

Reading: both boots are now bounded by OpenCode's own startup (~1.4 s to its
first answer) plus one instance init (~0.6 s); the checkout finishes before
that on either path, so acquisition speed is no longer visible in the boot
time on a 400-file project. S3's remaining ~150 ms in-guest deficit lands on
`opencode-http-listening` (1,548 vs 1,429): its extraction, hydration and
config-deps copy run while OpenCode starts. Where S3 still wins outright:
larger projects and projects without the scaffold root (the Git path there is
a full proxied clone, see the loopback section), and boots that must not
depend on the Git proxy's upstream.

## Compatibility gate (gate 6, v1 run)

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
