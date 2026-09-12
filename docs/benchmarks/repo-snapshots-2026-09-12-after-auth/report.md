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
| large | n/a | git-cold | 30 | 1393 | 1530 | 1697 | 149 | n/a (child process) | n/a | 26264 |
| large | n/a | git-warm | 30 | 732 | 800 | 1027 | 56 | n/a (child process) | n/a | 26264 |
| large | gzip | prepare-miss | 30 | 2242 | 2613 | 2950 | 304 | n/a (child process) | 9899 | 26180 |
| large | zstd | prepare-miss | 30 | 1929 | 2164 | 2298 | 191 | n/a (child process) | 9618 | 26180 |
| large | zstd | snapshot-cold | 30 | 757 | 847 | 881 | 104 | 622 | 9618 | 26180 |
| large | gzip | snapshot-cold | 30 | 760 | 871 | 916 | 112 | 642 | 9899 | 26180 |
| large | gzip | snapshot-warm | 30 | 472 | 566 | 596 | 59 | 5 | 0 | 26180 |
| large | zstd | snapshot-warm | 30 | 446 | 520 | 656 | 58 | 5 | 0 | 26180 |
| many-small | n/a | git-cold | 30 | 2260 | 2773 | 2897 | 304 | n/a (child process) | n/a | 20936 |
| many-small | n/a | git-warm | 30 | 705 | 952 | 1254 | 109 | n/a (child process) | n/a | 20936 |
| many-small | gzip | prepare-miss | 30 | 2554 | 3405 | 3657 | 260 | n/a (child process) | 546 | 20852 |
| many-small | zstd | prepare-miss | 30 | 2474 | 2936 | 3234 | 306 | n/a (child process) | 468 | 20852 |
| many-small | gzip | snapshot-cold | 30 | 1283 | 1432 | 1454 | 200 | 926 | 545 | 20852 |
| many-small | zstd | snapshot-cold | 30 | 1301 | 1481 | 2059 | 165 | 947 | 467 | 20852 |
| many-small | gzip | snapshot-warm | 30 | 1002 | 1103 | 1158 | 126 | 4 | 0 | 20852 |
| many-small | zstd | snapshot-warm | 30 | 977 | 1066 | 1155 | 107 | 4 | 0 | 20852 |
| median | n/a | git-cold | 30 | 194 | 230 | 239 | 15 | n/a (child process) | n/a | 1560 |
| median | n/a | git-warm | 30 | 109 | 136 | 176 | 24 | n/a (child process) | n/a | 1560 |
| median | gzip | prepare-miss | 30 | 339 | 435 | 548 | 58 | n/a (child process) | 530 | 1476 |
| median | zstd | prepare-miss | 30 | 320 | 468 | 546 | 51 | n/a (child process) | 533 | 1476 |
| median | gzip | snapshot-cold | 30 | 95 | 112 | 140 | 13 | 74 | 530 | 1476 |
| median | zstd | snapshot-cold | 30 | 91 | 108 | 168 | 9 | 74 | 533 | 1476 |
| median | zstd | snapshot-warm | 30 | 54 | 60 | 78 | 3 | 1 | 0 | 1476 |
| median | gzip | snapshot-warm | 30 | 55 | 64 | 111 | 8 | 1 | 0 | 1476 |
| small | n/a | git-cold | 30 | 110 | 128 | 141 | 17 | n/a (child process) | n/a | 372 |
| small | n/a | git-warm | 30 | 68 | 81 | 106 | 8 | n/a (child process) | n/a | 372 |
| small | gzip | prepare-miss | 30 | 256 | 315 | 326 | 40 | n/a (child process) | 99 | 424 |
| small | zstd | prepare-miss | 30 | 247 | 307 | 327 | 39 | n/a (child process) | 101 | 424 |
| small | gzip | snapshot-cold | 30 | 57 | 70 | 87 | 8 | 35 | 99 | 424 |
| small | zstd | snapshot-cold | 30 | 57 | 63 | 64 | 6 | 33 | 101 | 424 |
| small | zstd | snapshot-warm | 30 | 40 | 48 | 79 | 2 | 1 | 0 | 424 |
| small | gzip | snapshot-warm | 30 | 41 | 47 | 54 | 4 | 1 | 0 | 424 |

Sample errors: 0/960.

## Codec — gzip versus Zstandard

| repo | gzip bytes | zstd bytes | size delta | gzip read p50 | zstd read p50 | gzip build p50 | zstd build p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| large | 10137025 | 9848707 | -2.8% | 760 ms | 757 ms | 2242 ms | 1929 ms |
| many-small | 558527 | 478162 | -14.4% | 1283 ms | 1301 ms | 2554 ms | 2474 ms |
| median | 542804 | 546161 | 0.6% | 95 ms | 91 ms | 339 ms | 320 ms |
| small | 101856 | 103801 | 1.9% | 57 ms | 57 ms | 256 ms | 247 ms |

## Component ratio — local synthetic Git clone versus local S3 snapshot

**This is not the rollout gate.** The proposed gate is defined on project
materialization inside a real session; this script measures neither a real
session nor a wide-area transfer. The ratio below is a component
measurement on one machine, reported so it is reproducible and so the
difference it does show is visible.

| repo | codec | baseline p50 (IQR) | snapshot p50 (IQR) | n | reduction | speedup |
| --- | --- | --- | --- | --- | --- | --- |
| large | gzip | 1393 ms (149) | 760 ms (112) | 30 | 45.4% | 1.83x |
| large | zstd | 1393 ms (149) | 757 ms (104) | 30 | 45.7% | 1.84x |
| many-small | gzip | 2260 ms (304) | 1283 ms (200) | 30 | 43.2% | 1.76x |
| many-small | zstd | 2260 ms (304) | 1301 ms (165) | 30 | 42.4% | 1.74x |
| median | gzip | 194 ms (15) | 95 ms (13) | 30 | 51% | 2.04x |
| median | zstd | 194 ms (15) | 91 ms (9) | 30 | 53.1% | 2.13x |
| small | gzip | 110 ms (17) | 57 ms (8) | 30 | 48.2% | 1.93x |
| small | zstd | 110 ms (17) | 57 ms (6) | 30 | 48.2% | 1.93x |

## Concurrency — simultaneous materializations of one revision

| repo | level | batch ms | per-materialization ms | failed |
| --- | --- | --- | --- | --- |
| small | 1 | 55 | 55 | 0 |
| small | 5 | 195 | 39 | 0 |
| small | 20 | 773 | 39 | 0 |
| median | 1 | 129 | 129 | 0 |
| median | 5 | 306 | 61 | 0 |
| median | 20 | 1067 | 53 | 0 |
| large | 1 | 819 | 819 | 0 |
| large | 5 | 2712 | 542 | 0 |
| large | 20 | 9605 | 480 | 0 |
| many-small | 1 | 1260 | 1260 | 0 |
| many-small | 5 | 5378 | 1076 | 0 |
| many-small | 20 | 18780 | 939 | 0 |

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
`/Users/gliba/.openclaw/workspace/reviews/kortix-architecture-2026-09-10/config-provider-s3-benchmark-raw/repo-snapshots-2026-09-12-after-auth/`, with checksums in `SHA256SUMS`, and remain committed on
branch `config-provider-s3` at `cf6549e717` under this same path.
`apps/api/scripts/bench-repo-snapshot.ts` regenerates them.
