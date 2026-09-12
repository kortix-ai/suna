# Config Provider v1 — evidence

What has actually been run, what it proves, and what is still unproven. Updated
per checkpoint. Local component evidence and deployed evidence are kept apart on
purpose: they are not interchangeable.

## 1. Full session boot — REAL cloud sandbox, `required` mode

The strongest evidence on this branch. A real `POST /v1/projects/:id/sessions`
against the running API, a real provider sandbox, and the shipped daemon inside
it. Nothing mocked.

```text
POST /projects/:id/sessions → 201
session 80245a32-145b-4471-88e1-c1d3202c41b9

DAEMON HEALTH (/kortix/health, read through the API proxy)
  runtimeReady      true
  git_network_ops   0
  repo_snapshot     {"mode":"required","used":true,
                     "commitSha":"3ff3e376bb0d5eae3b285a3e767210983d427501",
                     "compression":"gzip","bytes":2621,
                     "transferMs":296,"firstEntryAtMs":276,
                     "extractMs":20,"verifyMs":8,"attempts":1}
  boot_timeline     … repo-snapshot@413ms, repo-materialized@413ms,
                     config-deps@420ms, opencode-workspace-reloaded@611ms …
```

Reproduced after every subsequent change (session 5cbda8f2: `runtimeReady: true`,
`git_network_ops: 0`, `used: true`, `transferMs: 274`, `firstEntryAtMs: 252`).

What this establishes:

- The workspace was served from the published S3 object in `required` mode,
  where there is no automatic Git fallback. `used: true` is the daemon's own
  record, not an inference.
- **`git_network_ops: 0`** on the Supervisor host. The counter is incremented
  inside `gitWithAuth`, the single function every authenticated Git invocation
  passes through, so this is a count and not the absence of a log line.
- **Extraction overlapped the download in a real boot**: the first entry landed
  at 276 ms while the transfer ran to 296 ms.
- The session reached `runtimeReady: true`.

API-side log for the same session:

```text
[repo-snapshot] session pinned a prepared revision
  {"sessionId":"80245a32…","ref":"main","mode":"required","commitSha":"3ff3e376…"}
[provision-timeline] session-create 80245a32 total=590ms
  snapshot-pin=+0ms(@0) env-vars=+39ms(@39) git-auth=+26ms(@65) kicked=+524ms(@590)
```

### What this run FOUND (and what was then fixed)

Three Git-backed reads survived the static audit and only showed up here. Each
reached `https://github.com/…` on a prepared start; the first two failed the
session outright:

1. `secret-grant.ts` → `loadGrantForRunningAgent` — a second
   `loadProjectAgents` that never received the pin. Fatal:
   `SecretGrantResolutionError`.
2. `network-secret-boundary.ts` → `resolveSessionNetworkBoundary`, called from
   `session-sandbox.ts` during provisioning — a third call site. Also fatal.
3. `compile-agent-config.ts` → `resolveCompiledAgentConfigForSession` — not
   fatal, but it silently dropped the compiled agent config.

All three now take the pinned snapshot. Only the manifest READ moves; secret
values, revocations and every authorization input are unchanged.

### What is still NOT zero on the API host

`git-auth=+26ms` remains in the timeline above. `provisionSessionSandbox`
resolves the git project eagerly for **sandbox image** resolution
(`firstImagePromise` → `resolveImage`). That is the per-project image
subsystem (`kortix.project_snapshot_builds`), which this brief puts out of
scope. For this fixture the project's auth method is `none`, so no GitHub
request was made — but for a GitHub App project this path WOULD mint an
installation token. **The Supervisor host is proven at zero; the API host is
not, and the remaining call site is named.**

## 2. Zero-attempt proof on BOTH hosts — component level

`apps/api/src/__tests__/integration-repo-snapshot-e2e.test.ts`, against a live
S3 endpoint, a real database, a real Git upstream and the real Supervisor
extractor. During the prepared start:

- a recording `git` shim is on `PATH` and every invocation is logged; any
  network subcommand is refused and counted;
- `fetch` is wrapped so an `api.github.com` / `github.com` request is counted
  and refused — the surface the PATH shim cannot see;
- `KORTIX_GIT_CACHE_DIR` points at a directory that does not exist, so any Git
  fallback would have to clone.

Asserted: both attempt lists empty, and the shim non-empty (so the assertion
cannot pass vacuously). Config reads are exercised with an empty AND a warm
local cache. Prerequisites FAIL the test rather than skipping, unless
`KORTIX_REPO_SNAPSHOT_E2E=skip` is set explicitly.

## 1b. `prefer` falls back, in a real sandbox

The same harness with `KORTIX_REPO_SNAPSHOT_MODE=prefer` and nothing published
for the revision (`E2E_SKIP_PUBLISH=1`):

```text
POST /projects/:id/sessions → 201   (session 06eeba63)
  runtimeReady      (boot proceeds on the existing path)
  git_network_ops   2
  repo_snapshot     null
```

`prefer` did not fail the session and did not invent a revision: with nothing
prepared, the API's pin missed, no descriptor reached the sandbox, and the boot
used the existing Git path — whose network operations are counted (2, against 0
on the prepared run). That is the counted-fallback contract, observed rather
than asserted.

## 1c. `required` fails closed, over real HTTP

Same harness, `KORTIX_REPO_SNAPSHOT_MODE=required`, nothing published:

```text
POST /projects/:id/sessions → 503
{"error":"snapshot for 564dda88bdc5cfddae5eeb4323eb3b0b128f20bf is not prepared yet;
  retry once preparation completes",
 "code":"REPO_SNAPSHOT_PREPARING","retryable":true}
```

The mode matrix, end to end and observed rather than asserted:

| mode | prepared? | outcome |
| --- | --- | --- |
| `required` | yes | boots from S3, `git_network_ops: 0` (§1) |
| `required` | no | 503 `REPO_SNAPSHOT_PREPARING`, retryable, names the SHA |
| `prefer` | no | existing Git path, `git_network_ops: 2` (§1b) |
| `shadow` / `off` | either | legacy path unchanged — `repo-snapshot-modes.test.ts` |

`required` never silently fell through to the clone path, and the error names
the exact revision rather than a generic failure.

## 2b. Descriptor and archive routes — real HTTP, real Kortix token

`apps/api/scripts/verify-repo-snapshot-http.ts`, against the running API and a
live object store. The `tests/` flow suite covers the auth boundary, which is
all a shared deployment can safely assert; this proves what a boundary test
cannot.

```text
14 pass, 0 fail
  200 for a prepared revision
  names the exact pinned commit
  carries the archive digest
  declares the delivery mode (proxy)
  never leaks the bucket name
  is not cacheable
  a second project on one revision reuses the artifact
  a project on another repository cannot reach it          409
  an unprepared revision is 409, not a substitution
  a branch name is refused                                 400
  archive: 200 and the exact published byte count
  archive: advertises the archive digest
  archive: another repository cannot stream it             409
  archive: anonymous is refused                            401
```

The shared-artifact and cross-repository rows are the brief's "shared identity"
and "access and restriction" groups: two projects on one revision receive the
SAME object, and repository identity — not project ownership alone — is what
gates it.

## 2c. The real publisher worker, and the backfill command

`integration-repo-snapshot-lifecycle.test.ts` drives `runRepoSnapshotTick` —
the shipped worker, not a stand-in — over a queued revision:
queued → claimed under lease → built → uploaded → manifest written → `ready`.
It then asserts both objects are actually in the store at the recorded sizes,
because a ready ROW is not an artifact. Observed: 1346-byte payload, 823-byte
manifest, key
`kortix-ai/worker-fixture/<sha>/<repository-id>/project-snapshot-v1/<digest>.tar.gz`.

`scripts/backfill-repo-snapshots.ts` was run against the local database in
`--dry-run` and found two real defects on the way:

- it filtered sessions by a `deleted` status that does not exist in
  `project_session_status`, so Postgres rejected the whole query (22P02);
- it printed the summary reason twice when the per-ref line already carried it.

Both fixed. The command reports every project it could NOT prepare individually,
with the reason, and never folds them into a success count — which is how the
five leftover fixture projects with no GitHub auth showed up as five named
errors rather than a silent zero.

## 3. Object store: what was actually used

| Evidence | Store |
| --- | --- |
| Full session boot (§1) | Local S3-compatible endpoint (MinIO), reached by the API; the sandbox used `proxy` delivery through the API tunnel. |
| Component and lifecycle tests (§2) | Same. |
| Benchmark | Same. |
| **AWS S3** | **Not exercised.** No AWS credentials are available in this environment. |

The client is hand-signed SigV4 over `fetch` with no S3-specific SDK, and the
integration tests exercise real SigV4, real `If-None-Match: *` semantics and
real presigned-URL scoping against a real S3 API server. That is not the same
as proving AWS. What is needed to close it is in §6.

## 4. Benchmark

`docs/benchmarks/repo-snapshots/` — `raw.json`, `results.csv`, `report.md`.

It is a **local component microbenchmark** and does not establish the rollout
gates. Both arms are local (a `file://` Git mirror and a local S3 endpoint), the
Git arm is a synthetic clone rather than the daemon's full `materializeRepo`,
and request-to-execution-ready is not measured at all. Observed cold medians on the corrected methodology are **43.2–53.7%** against
the local synthetic Git arm (960 samples, 0 errors, 30 measured rounds per
cohort, arms shuffled each round). **No claim is made that the proposed 50%
gate is met**: the gate is defined on a measurement this script does not take.

Concurrency (same revision, cold local cache, 0 failures at every level):

| repo | 1 | 5 | 20 |
| --- | --- | --- | --- |
| small | 57 ms | 40 ms/each | 44 ms/each |
| median | 86 ms | 59 ms/each | 55 ms/each |
| large | 783 ms | 509 ms/each | 468 ms/each |
| many-small | 1278 ms | 1058 ms/each | 941 ms/each |

### Codec decision: gzip stays the default

| repo | gzip | zstd | delta |
| --- | --- | --- | --- |
| large | 10137025 B | 9848707 B | −2.8% |
| many-small | 558527 B | 478162 B | −14.4% |
| median | 542804 B | 546161 B | +0.6% |
| small | 101856 B | 103801 B | +1.9% |

Read time is within noise on every cohort (720/726, 1223/1232, 87/88, 55/54 ms).
zstd builds faster on the largest cohort (1872 vs 2186 ms), but building runs on
a background worker and is off the session critical path. The payload is
dominated by already-zlib-compressed Git objects, which is why recompression
barely moves either way.

gzip therefore stays the default: no measured read-time win, a size delta inside
±3% on three of four cohorts, and the one place zstd wins is not on the path
that matters. zstd is fully supported and verified end to end — both runtimes
were checked for `node:zlib` Zstandard support (`oven/bun:1.2` → bun 1.2.23 and
`oven/bun:1.3.11`, the API and sandbox-agent pins) — so it is one environment
variable away if a future cohort shows a real win.

## 5. Test results

| Suite | Result |
| --- | --- |
| `apps/api` (`bash scripts/test.sh`) | 8988 pass / 1 fail |
| `apps/kortix-sandbox-agent-server` (`bun test`) | 1183 pass / 0 fail |
| Route coverage (`bun bin/ke2e.ts coverage`) | 0 uncovered of 640 |

The single API failure is `src/secrets/relay-transport.test.ts`, a bun
response-header behaviour assertion. `git diff origin/main -- apps/api/src/secrets`
is empty, so this branch does not touch it.

### CI flakes seen, and why they are not this branch

| Failure | Why it is not this change |
| --- | --- |
| `Vercel — Authorization required to deploy` | A Vercel account authorization, separate from the repository preview. Not a code failure. |
| `apps/cli sessions new CLI flow` — two 30 s timeouts on one head | Those tests drive the CLI against a STUB HTTP handler that returns a canned `POST /sessions` response; the API code never executes. `git diff origin/main -- apps/cli` is empty, and both pass locally (6 pass / 0 fail). A local-git + stub-server timeout under CI load. |
| `audit HTTP route registry` | This one WAS this branch, and is fixed: `apps/web` keeps a generated registry plus a label per route, and three new routes had to be registered. |

## 5b. LFS and submodules

Writing the fixtures the brief asks for found that an LFS repository could not be
packaged at all. `.gitattributes` declares a smudge filter, `git checkout` tries
to run `git-lfs`, and on an image without that binary packaging failed with
`git-lfs: command not found`. The sandbox's verification had the same exposure.

Both now run filter-neutral, which is also the property the brief already
requires — "verification must not execute archive-provided hooks, external
filters, or configuration includes". The archive carries the LFS POINTER byte
for byte, which is what a checkout without `git-lfs` produces today. Submodule
CONTENT is not populated, which is what `git clone --depth 1` already does; the
gitlink and `.gitmodules` survive so `git submodule update` still works.

Both are preserved, neither is materialized, and that is the status quo rather
than a change. A repository declaring some other custom filter fails loudly when
that binary is absent — recorded on the snapshot row, never silently packaged
with different content.

## 6. Blockers — exact, with the supported action

### Preview environment

Both authorized routes are denied for this account, reproducibly:

```text
$ gh pr edit 7219 --repo kortix-ai/suna --add-label preview
GraphQL: DimitrijeGlibic does not have the correct permissions to execute
`AddLabelsToLabelable` (addLabelsToLabelable)

$ gh workflow run deploy-preview.yml --repo kortix-ai/suna -f pr_number=7219
HTTP 403: Must have admin rights to Repository.
```

The PR is from the `DimitrijeGlibic` fork; the account has no write/triage
permission on `kortix-ai/suna`. `deploy-preview.yml` re-checks the label
server-side (line 120), so there is no bypass, and none was attempted.

**Supported maintainer action:** add the `preview` label to PR #7219. The
workflow triggers on `labeled` and builds at the exact head SHA.

### AWS S3

No AWS credentials in this environment. Nothing was requested or provisioned.

**Supported maintainer action:** create a private, environment-scoped bucket
and set `KORTIX_REPO_SNAPSHOT_BUCKET`, `KORTIX_REPO_SNAPSHOT_REGION` and
`KORTIX_REPO_SNAPSHOT_PREFIX`. Credentials come from the ambient AWS chain (ECS
task role / EKS web identity), exactly as the SES transport already does; set
`KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` only for a static
key pair. IAM needs `s3:PutObject` and `s3:GetObject` on `<bucket>/<prefix>*`
and nothing else.

Then re-run, unchanged:

```sh
cd apps/api && dotenvx run -f .env.local -f .env -- bun test --isolate \
  src/repo-snapshots/s3-publish.integration.test.ts \
  src/__tests__/integration-repo-snapshot-lifecycle.test.ts \
  src/__tests__/integration-repo-snapshot-e2e.test.ts
```

The end-to-end test reaches storage through a signed HEAD, not a MinIO health
probe, so it runs against AWS without modification.

### Deployed Git-vs-S3 end-to-end measurement

Needs a deployment with snapshots enabled:

```sh
cd apps/api && BENCH_TARGETS='[{"label":"dev","projectId":"<uuid>"}]' \
  BENCH_DB_URL=… BENCH_TOKEN=… BENCH_API=https://dev-api.kortix.com \
  bun run scripts/bench-boot-attribution.ts
```

It reports snapshot-served boot counts, transfer and first-entry times, every
fallback reason, and how many boots reached zero Git network operations.

## Checkpoint — 2026-09-12, readiness fixes on top of 55047593c4

This checkpoint covers the observation-ordering, discovery, legacy-metadata and
pinned-catalogue corrections. Image startup end-to-end, benchmarks and the
production package are still open; see "Outstanding" below.

### Reproducible local setup

The worktree's database and Supabase are NOT the ports the inherited profile
names, and `KORTIX_URL` is unset there while internal billing is enabled. Every
command below is exactly what was run:

```sh
cd apps/api
dotenvx run -f .env.local -f .env --quiet -- bash -c 'export \
  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:13922/postgres \
  KORTIX_URL=http://127.0.0.1:13608; bun test --isolate --timeout=120000 <files>'
```

Object store: the existing MinIO on `127.0.0.1:19000`, bucket
`kortix-repo-snapshots`. Supabase gateway: `127.0.0.1:13921`.

### What changed

1. **A null observation generation is an assertion, not an absence.**
   `store.ts` treated `generation: null` — "no row existed when my lookup
   began" — as "no token", so the write applied unconditionally. A 404 that
   started before a branch existed could therefore erase the SHA someone
   recorded while it was in flight. A null generation is now INSERT-ONLY on
   conflict.
2. **A 404 no longer proves a branch was deleted.** GitHub answers 404 for a
   repository the credential cannot see, with the same message as a missing
   ref, so the previous wording-based classifier deleted good revisions on a
   permissions blip. `confirmBranchDeleted` re-reads the repository with the
   SAME credential and only confirms deletion when that succeeds.
3. **A project whose first preparation failed comes back on its own.** Two
   bounded scans run in the worker tick: `discoverUnregisteredProjects` retries
   identity lookups, ordered by an attempt timestamp stored ON THE PROJECT so
   the scan advances past permanent failures instead of re-reading the same
   first page; `scheduleMissingDefaultRefs` gives a registered project its
   missing ref row.
4. **Legacy `metadata.github` projects survive all of it.** `getProjectGitRemote`
   reads `metadata.git` first, so writing a partial `git` subtree onto a legacy
   project downgraded it to provider `generic` with no auth. Bookkeeping now
   writes into the subtree the project already uses, and every worker and
   webhook project selector uses the same effective-remote SQL — previously
   they matched `metadata.git.external_repo_id` only, so a legacy project could
   be discovered and repaired and still never reconcile.
5. **Pre-existing `refs/heads/*` rows are readable and consolidated.** Rows an
   older build wrote under the full-ref spelling were invisible to a lookup for
   `main`. Every store entry point now resolves the stored spelling, and
   migration `20260912164500000_repo_snapshot_ref_alias_consolidation.concurrent.ts`
   folds the old rows into the canonical one (batched, incrementally committed).
6. **A pinned session gets its own catalogue.** With a governing pin, every
   project-scoped `source: 'toml'` row is excluded — not just the slugs the pin
   also declares — so a template the revision renamed or deleted cannot come
   back with its old path and spec. UI-owned and shared rows are kept. The
   pinned manifest read no longer swallows failures: a missing archive or a
   checksum mismatch fails the catalogue instead of quietly serving the
   platform default.

### Results

| Suite | Result |
| --- | --- |
| `apps/api` full unit suite (`bash scripts/test.sh`) | 9013 pass, 79 skip, 1 fail |
| `src/repo-snapshots/` + `src/snapshots/` + metadata-merge guard | 384 pass, 5 skip, 0 fail |
| 6 repo-snapshot integration suites (real DB + MinIO) | 52 pass, 0 fail |
| `apps/api` `tsc --noEmit` | clean |
| `packages/db` migration lint | 209 files pass |

The single unit failure is `src/secrets/relay-transport.test.ts` — "bun does NOT
preserve duplicate non-known RESPONSE headers" — in a file this branch does not
touch. It fails identically at the branch point.

New integration coverage:

- `integration-repo-snapshot-discovery.test.ts` (13) — a first identity-lookup
  failure recovers with no second webhook; several pages of failing projects
  cannot starve the one behind them; the attempt is recorded in the database,
  not in memory; legacy PAT and GitHub-App projects keep their remote through
  every write; a legacy project reconciles to a queued revision with its own
  `source_project_id`.
- `integration-repo-snapshot-ref-alias.test.ts` (8) — raw pre-existing
  `refs/heads/*` rows, and the migration driven against the real table.
- `integration-repo-snapshot-templates.test.ts` (7) — the pinned catalogue:
  old-only slug rejection, path/spec/declaration from the pin, two revisions
  side by side, no writes to project-global rows, UI and platform precedence,
  no-manifest, unreadable snapshot.
- `branch-deletion.test.ts` (6) — the 404 classifier against real HTTP.
- `integration-repo-snapshot-lifecycle.test.ts` (+5) — observation ordering as a
  generation rather than a clock.

Every integration suite cleans up only the ids it created.

### Correction — the consolidation merge rule

The first version of the migration compared `alias.revision` to
`canonical.revision` and kept the higher one's SHA. That is wrong: `revision`
counts writes to ONE row, so a stale alias at revision 9 says nothing about a
current canonical row at revision 3, and the migration would have restored the
old SHA — while the running application, which always prefers the canonical
row, said the opposite. The canonical row now simply wins, its `desired_sha`
and `revision` are left untouched so no in-flight CAS token is invalidated, and
only the reconcile deadline moves to the earlier of the two.

Two further test defects found with it: the migration's batching loop was
driven through an adapter that read `rows.length` instead of postgres-js's
`count`, so a data move larger than one batch would have looked complete after
the first pass (now covered by a 700-row case); and `scheduleRefReconcile` — a
different function from `ensureRefReconcileScheduled` — still normalized the
key instead of resolving the stored spelling, so an alias-only row's deadline
was never updated.

The migration test now runs against a throwaway database it creates and drops,
because the migration's SQL is deployment-wide by definition. The one test that
calls `claimRefsDueForReconcile` asserts nothing else is due before claiming,
rather than leasing another writer's row.

### Correction — one branch, one lock

Three further races, each reproduced against the real table before the fix.

1. **A generation only means something for the row it came from.** A token read
   from a legacy `refs/heads/main` row carried a bare counter, so after that row
   was consolidated away it could authenticate a write to the *canonical* row
   that happened to sit at the same number, restoring a stale SHA.
   `RefObservationToken` now carries the ref key it was read from, and an
   observation whose authoritative row identity changed is dropped.
2. **Resolving the key and writing to it are two statements.** A consolidation
   renaming the row between them let a delayed write recreate the legacy row
   beside the canonical one — reintroducing exactly the orphan the migration
   removes. Every mutation now resolves the key and writes inside one
   transaction holding `pg_advisory_xact_lock` on the branch's CANONICAL name,
   so all writers for one branch serialize regardless of which spelling they
   started from.
3. **The migration takes the same lock.** It consolidates one branch at a time
   under that branch's lock, so the "does a canonical row exist" test and the
   write that depends on it are atomic and a rolling writer can no longer turn
   the rename into a `23505`. Its progress loop counts ROWS RETURNED rather
   than reading a value out of a result, which is the one answer node-pg and
   postgres-js report identically.

Two more, from the same review round:

4. **A read must not lose a row to a rename either.** `readRepoRef` resolved the
   key and then read it in two statements; a consolidation landing between them
   reported a branch as ABSENT while it plainly existed. Both spellings are now
   matched in ONE select, canonical first.
5. **The migration no longer tests before it writes.** An old replica takes no
   advisory lock, so a canonical row could still appear between an `exists`
   check and the rename and abort the pass with `23505`. The per-branch work now
   attempts the rename and catches `unique_violation`, merging instead — there
   is no window between a test and a write because there is no test.

Residual, and documented rather than fixed: an API replica running the PREVIOUS
build takes no advisory lock, so during a rolling deploy it can still create a
legacy row. The consolidation is safe to run again, and the running application
reads either spelling, so the effect is a row to clean up later, not a lost
revision.

### Pushes, and what a bounded budget may not drop

A push through the Git proxy now records a reconcile deadline for EVERY branch
it touched before preparing any of them. That local write is what makes the
inline budget safe: the first 20 branches are prepared immediately, and branch
21 — or a branch whose preparation throws — still has a row the reconcile pass
picks up, instead of waiting for somebody to push again. Each inline
preparation is isolated, so one failing ref cannot take the rest of the push
with it. Proved in `integration-repo-snapshot-discovery.test.ts` with a
25-branch push whose FIRST ref always fails.

### The last-ready fallback is not pinned-image parity

When the pinned image is still building, the builder boots the newest ready
image of the same template lineage. That image may have been built from a
different Dockerfile and a different resource spec. The trade is deliberate — a
session boots now instead of waiting — so the result carries `servedOlderImage`
and NO spec, and metering falls back to its own default rather than billing the
current template's numbers for an image nobody booted. A caller that needs the
exact pinned image waits for the build.

`integration-repo-snapshot-ref-alias.test.ts` proves the lock ordering directly:
a second connection holds the branch lock, renames the row and records a newer
SHA while a delayed observation waits on it; the observation then returns the
canonical row and creates nothing.

### Outstanding

Real HTTP GitHub-App and custom-image startup with Git blocked on both sides,
later Git and Kortix-CR operations, the three-arm boot benchmark, the strict AWS
test mode, and the production deployment package.
