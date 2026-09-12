# Repository snapshot materialization benchmark

Environment: bun 1.4.0, node 26.3.0, darwin-arm64, 14 CPUs, endpoint http://127.0.0.1:19000.
Rounds: 2 warmup + 30 measured per cohort, arms interleaved and shuffled each round.

| repo | sha | files | content bytes |
| --- | --- | --- | --- |
| small | `76f12d90b3` | 29 | 132942 |
| median | `ab3b92e66d` | 150 | 800504 |
| large | `49ece9fddb` | 1976 | 16797537 |
| many-small | `a398c69df6` | 5000 | 1151914 |

| repo | codec | arm | n | p50 ms | p90 ms | p95 ms | IQR ms | CPU p50 ms | transferred KiB | checkout KiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| large | n/a | git-cold | 30 | 1364 | 1451 | 1574 | 89 | n/a (child process) | n/a | 26264 |
| large | n/a | git-warm | 30 | 709 | 798 | 856 | 51 | n/a (child process) | n/a | 26264 |
| large | gzip | prepare-miss | 30 | 2186 | 2387 | 2441 | 128 | n/a (child process) | 9899 | 26180 |
| large | zstd | prepare-miss | 30 | 1872 | 2033 | 2132 | 157 | n/a (child process) | 9618 | 26180 |
| large | zstd | snapshot-cold | 30 | 726 | 791 | 814 | 80 | 576 | 9618 | 26180 |
| large | gzip | snapshot-cold | 30 | 720 | 810 | 873 | 65 | 585 | 9899 | 26180 |
| large | zstd | snapshot-warm | 30 | 461 | 526 | 557 | 79 | 5 | 0 | 26180 |
| large | gzip | snapshot-warm | 30 | 437 | 555 | 615 | 46 | 4 | 0 | 26180 |
| many-small | n/a | git-cold | 30 | 2224 | 2434 | 3016 | 197 | n/a (child process) | n/a | 20936 |
| many-small | n/a | git-warm | 30 | 666 | 765 | 849 | 73 | n/a (child process) | n/a | 20936 |
| many-small | gzip | prepare-miss | 30 | 2427 | 2600 | 2873 | 163 | n/a (child process) | 546 | 20852 |
| many-small | zstd | prepare-miss | 30 | 2381 | 2691 | 3457 | 201 | n/a (child process) | 468 | 20852 |
| many-small | gzip | snapshot-cold | 30 | 1223 | 1300 | 1334 | 66 | 906 | 545 | 20852 |
| many-small | zstd | snapshot-cold | 30 | 1232 | 1323 | 1332 | 104 | 891 | 467 | 20852 |
| many-small | zstd | snapshot-warm | 30 | 954 | 1027 | 1142 | 91 | 4 | 0 | 20852 |
| many-small | gzip | snapshot-warm | 30 | 968 | 1010 | 1060 | 80 | 4 | 0 | 20852 |
| median | n/a | git-cold | 30 | 188 | 204 | 218 | 11 | n/a (child process) | n/a | 1560 |
| median | n/a | git-warm | 30 | 96 | 113 | 129 | 8 | n/a (child process) | n/a | 1560 |
| median | zstd | prepare-miss | 30 | 287 | 316 | 388 | 23 | n/a (child process) | 533 | 1476 |
| median | gzip | prepare-miss | 30 | 312 | 366 | 427 | 22 | n/a (child process) | 530 | 1476 |
| median | gzip | snapshot-cold | 30 | 87 | 95 | 96 | 6 | 68 | 530 | 1476 |
| median | zstd | snapshot-cold | 30 | 88 | 108 | 109 | 7 | 66 | 533 | 1476 |
| median | gzip | snapshot-warm | 30 | 52 | 60 | 66 | 5 | 1 | 0 | 1476 |
| median | zstd | snapshot-warm | 30 | 52 | 58 | 61 | 5 | 1 | 0 | 1476 |
| small | n/a | git-cold | 30 | 99 | 114 | 118 | 13 | n/a (child process) | n/a | 372 |
| small | n/a | git-warm | 30 | 61 | 70 | 86 | 6 | n/a (child process) | n/a | 372 |
| small | zstd | prepare-miss | 30 | 230 | 250 | 272 | 20 | n/a (child process) | 101 | 424 |
| small | gzip | prepare-miss | 30 | 234 | 252 | 276 | 16 | n/a (child process) | 99 | 424 |
| small | gzip | snapshot-cold | 30 | 55 | 65 | 73 | 5 | 33 | 99 | 424 |
| small | zstd | snapshot-cold | 30 | 54 | 58 | 65 | 4 | 31 | 101 | 424 |
| small | zstd | snapshot-warm | 30 | 38 | 49 | 61 | 6 | 1 | 0 | 424 |
| small | gzip | snapshot-warm | 30 | 40 | 44 | 50 | 5 | 1 | 0 | 424 |

Sample errors: 0/960.

## Codec — gzip versus Zstandard

| repo | gzip bytes | zstd bytes | size delta | gzip read p50 | zstd read p50 | gzip build p50 | zstd build p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| large | 10137025 | 9848707 | -2.8% | 720 ms | 726 ms | 2186 ms | 1872 ms |
| many-small | 558527 | 478162 | -14.4% | 1223 ms | 1232 ms | 2427 ms | 2381 ms |
| median | 542804 | 546161 | 0.6% | 87 ms | 88 ms | 312 ms | 287 ms |
| small | 101856 | 103801 | 1.9% | 55 ms | 54 ms | 234 ms | 230 ms |

## Component ratio — local synthetic Git clone versus local S3 snapshot

**This is not the rollout gate.** The proposed gate is defined on project
materialization inside a real session; this script measures neither a real
session nor a wide-area transfer. The ratio below is a component
measurement on one machine, reported so it is reproducible and so the
difference it does show is visible.

| repo | codec | baseline p50 (IQR) | snapshot p50 (IQR) | n | reduction | speedup |
| --- | --- | --- | --- | --- | --- | --- |
| large | gzip | 1364 ms (89) | 720 ms (65) | 30 | 47.2% | 1.89x |
| large | zstd | 1364 ms (89) | 726 ms (80) | 30 | 46.8% | 1.88x |
| many-small | gzip | 2224 ms (197) | 1223 ms (66) | 30 | 45% | 1.82x |
| many-small | zstd | 2224 ms (197) | 1232 ms (104) | 30 | 44.6% | 1.81x |
| median | gzip | 188 ms (11) | 87 ms (6) | 30 | 53.7% | 2.16x |
| median | zstd | 188 ms (11) | 88 ms (7) | 30 | 53.2% | 2.14x |
| small | gzip | 99 ms (13) | 55 ms (5) | 30 | 44.4% | 1.8x |
| small | zstd | 99 ms (13) | 54 ms (4) | 30 | 45.5% | 1.83x |

## Concurrency — simultaneous materializations of one revision

| repo | level | batch ms | per-materialization ms | failed |
| --- | --- | --- | --- | --- |
| small | 1 | 57 | 57 | 0 |
| small | 5 | 202 | 40 | 0 |
| small | 20 | 889 | 44 | 0 |
| median | 1 | 86 | 86 | 0 |
| median | 5 | 293 | 59 | 0 |
| median | 20 | 1104 | 55 | 0 |
| large | 1 | 783 | 783 | 0 |
| large | 5 | 2546 | 509 | 0 |
| large | 20 | 9352 | 468 | 0 |
| many-small | 1 | 1278 | 1278 | 0 |
| many-small | 5 | 5291 | 1058 | 0 |
| many-small | 20 | 18829 | 941 | 0 |

## Limits of this measurement

- **Not the rollout gate.** Request-to-execution-ready is not measured.
- **Both sides are local.** The Git arms read a `file://` mirror; the
  snapshot arms read a local S3 endpoint. Neither pays a wide-area
  transfer. No claim is made about how the gap changes in production —
  the two arms would face different networks, and that is unmeasured.
- **The Git arm is synthetic.** It is a clone with the daemon's flags at
  the verified SHA. It does NOT model the daemon's baked scaffold, delta
  bundle, or warm-checkout reuse, all of which make the real path faster
  than this arm in the cases where they apply.
- **`git-warm` excludes the mirror clone**, so it flatters the baseline.
- **CPU is parent-process only.** The Git arms and `prepare-miss` do work
  in `git` children whose CPU is not attributable here; those cells read
  `n/a` rather than a misleadingly small number.
- **RSS is the benchmark process after the arm**, not a per-arm peak.
- **Transferred bytes are exact for snapshot arms only.** The Git arms
  report the produced checkout size, which is not a network figure.
- Download and extraction OVERLAP in the snapshot arms; their durations
  are never summed and presented as a saving.
- Every arm now produces the same deliverable: a fresh writable working
  tree. `snapshot-warm` copies the cached tree out rather than reporting
  a cache stat.

## Raw data

`raw.json` and `results.csv` (960 samples) are not tracked in the reduced
candidate. They are preserved byte-for-byte outside the repository at
`/Users/gliba/.openclaw/workspace/reviews/kortix-architecture-2026-09-10/config-provider-s3-benchmark-raw/repo-snapshots/`, with checksums in `SHA256SUMS`, and remain committed on
branch `config-provider-s3` at `cf6549e717` under this same path.
`apps/api/scripts/bench-repo-snapshot.ts` regenerates them.
