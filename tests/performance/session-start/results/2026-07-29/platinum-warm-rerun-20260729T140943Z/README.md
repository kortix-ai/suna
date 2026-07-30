# Platinum exact-commit repository-image A/B

## Identity

| field | value |
|---|---|
| Project | `b941768b-eb77-4e71-a2df-a678f4f1dc28` |
| Commit | `85f0efd3b8232796d6b3cef382481e3fa7857ae4` |
| Image | `kortix-ppwarm-b941768b-37a8eec1-e516c44c8217` |
| Provider | Platinum |
| Harness | Pi through ACP |
| API | Local diagnostic API on port `8028` |

The image key contains the exact commit.

The image uses `capture: 'none'`.

It contains the repository and runtime disk files.

It does not contain a running VM, daemon, harness, ACP connection, or ACP
session.

## Image builds

| build ID | result | duration |
|---|---:|---:|
| `3ca6fe57-9e79-49e4-aa43-1138b9fb5c68` | failed | 9m 15.402s |
| `caf9f543-9e1e-4c34-af97-c22398063280` | ready | 10m 10.923s |

Platinum returned no detailed error for the failed build.

## Session results

The cold control has two valid samples.

The repository-image path has five valid startup samples.

| phase | cold controls | image-hit p50 |
|---|---:|---:|
| Image resolution | 2.533s, 2.554s | 105ms |
| Platinum create | 2.097s, 2.250s | 2.108s |
| Repository materialization | 2.341s, 2.528s | 39ms |
| Selected Pi harness boot | 431ms, 431ms | 460ms |
| Create to runtime ready | 7.928s, 8.734s | 3.863s |
| ACP initialize | 238ms, 221ms | 301ms |
| ACP `session/new` | 5.357s, 5.107s | 5.270s |
| Create to session ready | 14.223s, 14.222s | 9.462s |

The first image-hit sample contains a Platinum create outlier of `11.732s`.

The image-hit runtime-ready p90 is therefore `13.416s`.

## Integrity checks

All five image-hit rows record this template:

```text
kortix-ppwarm-b941768b-37a8eec1-e516c44c8217
```

The retained sample `ff3b7c32-7eda-49be-94bb-d944c0d05fcc` returned:

```text
$ git -c safe.directory=/workspace -C /workspace rev-parse HEAD
85f0efd3b8232796d6b3cef382481e3fa7857ae4
```

## Reproduce

Run one startup-only sample:

```bash
API_BASE=http://localhost:8028/v1 \
BENCH_API=http://localhost:8028/v1 \
BENCH_PROJECT_ID=b941768b-eb77-4e71-a2df-a678f4f1dc28 \
BENCH_PROVIDER=platinum \
BENCH_STARTUP_ONLY=1 \
BENCH_OUT=/tmp/platinum-warm.json \
./tests/performance/session-start/run.sh session-ready
```

Analyze a set:

```bash
node tests/performance/session-start/analyze-startup-ready.mjs \
  tests/performance/session-start/results/2026-07-29/platinum-warm-rerun-20260729T140943Z/warm-*.json
```

The failed `cold-miss*.json` files remain in this directory.

They preserve the PostgreSQL `42703` and transient create failures from the
rerun.
