# Materialization, before and after the readiness work

Same four fixtures, same revisions, same runtime, same local S3 endpoint, same
30 measured rounds after 2 warmups, same machine. The baseline is
`docs/benchmarks/repo-snapshots/` — 960 samples, preserved untouched. This rerun
is 960 samples, 0 errors.

**This comparison shows that the readiness, ordering and image work did not
regress materialization. It is not a measurement of that work.** This harness
never acquires a GitHub token and never provisions a session, so it cannot see
the startup authentication that was removed; attributing any difference below to
that removal would be wrong. The numbers move by less than the within-arm spread
(the IQR column in each report), which is the scale to read them against.

| repo | arm | baseline p50 | after-auth p50 | change |
| --- | --- | --- | --- | --- |
| small | git-cold | 99 ms | 110 ms | +10.5% |
| small | snapshot-cold/gzip | 55 ms | 57 ms | +4.7% |
| small | snapshot-cold/zstd | 55 ms | 58 ms | +5.5% |
| small | snapshot-warm/gzip | 40 ms | 41 ms | +2.1% |
| median | git-cold | 188 ms | 195 ms | +3.5% |
| median | snapshot-cold/gzip | 87 ms | 95 ms | +9.3% |
| median | snapshot-cold/zstd | 88 ms | 92 ms | +4.8% |
| median | snapshot-warm/gzip | 52 ms | 56 ms | +6.0% |
| large | git-cold | 1372 ms | 1397 ms | +1.8% |
| large | snapshot-cold/gzip | 726 ms | 761 ms | +4.9% |
| large | snapshot-cold/zstd | 728 ms | 761 ms | +4.6% |
| large | snapshot-warm/gzip | 437 ms | 473 ms | +8.2% |
| many-small | git-cold | 2225 ms | 2266 ms | +1.8% |
| many-small | snapshot-cold/gzip | 1224 ms | 1283 ms | +4.9% |
| many-small | snapshot-cold/zstd | 1235 ms | 1304 ms | +5.6% |
| many-small | snapshot-warm/gzip | 970 ms | 1002 ms | +3.3% |

Every arm moved in the same direction by a similar amount — including the two
Git arms, which this feature does not touch at all. That is the signature of
host load between two runs, not of a code change in either path.

The component ratio both reports agree on: a local snapshot read is **42–53%
faster** than a local synthetic Git clone of the same revision, across every
fixture shape and both codecs. That is a component measurement on one machine —
not the rollout gate, and not evidence about session startup, which is measured
by `scripts/bench-boot-attribution.ts` against a real API.

Command (identical to the baseline's, only `--out` differs):

```sh
cd apps/api
dotenvx run -f .env.local -f .env -- bun run scripts/bench-repo-snapshot.ts \
  --repo small=<fixtures>/small --repo median=<fixtures>/median \
  --repo large=<fixtures>/large --repo many-small=<fixtures>/many-small \
  --rounds 30 --warmups 2 --codec both --concurrency 1,5,20 \
  --out ../../docs/benchmarks/repo-snapshots-2026-09-12-after-auth
```
