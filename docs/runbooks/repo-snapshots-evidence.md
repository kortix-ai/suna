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
and request-to-execution-ready is not measured at all. Observed cold medians on
the corrected methodology are 43.2–52.9% against the local synthetic Git arm.
**No claim is made that the proposed 50% gate is met.**

## 5. Test results

| Suite | Result |
| --- | --- |
| `apps/api` (`bash scripts/test.sh`) | 8987 pass / 1 fail |
| `apps/kortix-sandbox-agent-server` (`bun test`) | 1183 pass / 0 fail |
| Route coverage (`bun bin/ke2e.ts coverage`) | 0 uncovered of 640 |

The single API failure is `src/secrets/relay-transport.test.ts`, a bun
response-header behaviour assertion. `git diff origin/main -- apps/api/src/secrets`
is empty, so this branch does not touch it.

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
