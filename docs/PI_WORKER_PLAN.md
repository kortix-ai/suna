# pi worker — implementation plan and status

The harness/environment split, tracked against the requirements that started it.
Branch: `pi-worker`. Environment: `https://pi.kortix.com` (persistent branch env).

This file is the plan of record. Update the status column in the same commit
that changes the status — a plan that lags the code is worse than no plan.

> ### ⚠ The branch environment is frozen
>
> `pi.kortix.com` serves **`ef2163ba`** and has not moved since. The persistent
> preview sandbox cannot `git fetch` this PRIVATE repo — it holds no credential
> at all (no repo config, no `~/.gitconfig`, no `~/.git-credentials`, no
> `GIT_ASKPASS`), and `sandbox-preview.ts` supplies none. The deploy step is
> `continue-on-error`, so the job continues, the hostname is never re-pointed,
> and `/v1/health` keeps answering `ok` on the stale commit.
>
> **Everything below is verified by local gates only** until a repo-scoped
> credential exists in that box (`PREVIEW_MANAGED_GIT_GITHUB_TOKEN` — repo
> admin). `scratchpad/pi-system-test.sh` now fails loudly when the served commit
> does not match `origin/pi-worker`, so a stale environment can no longer be
> mistaken for a passing one.

---

## The requirements, verbatim in intent

From the design huddle (Marko Kraemer, transcript in the session that opened
this branch). Nine requirements; the wording is his, condensed.

| # | Requirement | Status |
|---|---|---|
| 1 | Worker = tiny fast Alpine harness, separate from the sandbox | **shipped** |
| 2 | Sandbox = the compute layer; one harness owns its environment | **shipped** |
| 3 | Pi only — drop OpenCode V2 / Claude / Codex as the main harness | **shipped** |
| 4 | API compiles agent config per commit; **no git clone in the sandbox** | **shipped** |
| 5 | Kortix YAML is the source of truth for agent definitions | **shipped** |
| 6 | Messages read from the durable store, not through the OpenCode API | **shipped** |
| 7 | Default tools point at the SANDBOX, never the worker filesystem | **shipped + pinned** |
| 8 | The worker is locked down; a tool must not touch its disk | **shipped + pinned** |
| 9 | Filesystems paradigm — shared volumes, "a Google Drive between agents", S3 | **shipped (API/SDK/CLI); agent path pending a dev deploy** |

### What "shipped + pinned" means for 7 and 8

These two are the whole point of the split, and the failure mode Marko named is
state corruption: the worker is shared and long-lived, so a tool that writes to
it corrupts every session that box later serves.

`apps/kortix-worker/src/isolation.test.ts` asserts both, and the second
assertion is the claim, not the first:

* every file and shell operation crosses the RPC boundary, **and** the worker's
  disk is byte-for-byte unchanged after a write, a mkdir and a delete are
  dispatched at paths inside it;
* a worker that cannot reach its environment **fails the tool** rather than
  falling back to local execution — the degraded path where a fallback would be
  most tempting and most damaging.

Mutation-checked: injecting one stray local write fails the first test and names
the leaked file. `spikes/pi-worker/test/proof.ts` proved this for the SPIKE; the
spike never touched `apps/`, so until that file the shipped worker had no test
of it.

---

## Requirement 9 — shared filesystems

> "instead of saving any memories anymore in the git, we would literally just
> have file systems … used like a Google Drive between the agents to share
> state … the volume stays alive no matter if sandboxes are"

Deliberately NOT the project repo. `/projects/:id/files*` reads git — config,
cloned per session, versioned. A filesystem is state: mutable, shared, and alive
whether or not any sandbox is. *"We should not be intermixing the concerns."*

### Storage

Blobs are **content-addressed by sha256**, so one string names the same content
in both backends, `put` is idempotent, and identical bytes under twenty paths
cost one blob.

Two backends, one address space:

* **S3** when `KORTIX_FS_S3_BUCKET` + `_REGION` + `_ACCESS_KEY_ID` +
  `_SECRET_ACCESS_KEY` are all set. `_ENDPOINT` points at R2/MinIO/any
  S3-compatible host; `_PREFIX` scopes the key space.
* **PostgreSQL** otherwise — not a stand-in. `pi_runtime_artifacts` already
  records the constraint: it is "the one store every environment has, including
  self-host, which has no S3". An S3-only filesystem is one a self-hosted
  customer cannot use and no preview can test.

A **half-configured** S3 falls back to PostgreSQL rather than failing every
write at runtime. Each row records the backend holding its bytes
(`filesystem_files.storage`), so a deployment that gains or loses S3 still reads
what it wrote before the switch.

### Surfaces

| Surface | Where | State |
|---|---|---|
| REST | `/v1/projects/:projectId/filesystems*` (7 routes) | live |
| SDK | `kortix.project(id).filesystems.*` | live |
| CLI | `kortix fs ls\|create\|rm\|list\|put\|get\|del` | live |
| Docs | `apps/web/content/docs/sdk/filesystems.mdx` | written |
| Agent | `bash` → `kortix fs …` in the session environment | **pending dev deploy** |

The agent path needs **no new worker tool**. The pi worker runs exactly four
tools by design, `bash` executes in the session ENVIRONMENT, and that image
carries the CLI at `/usr/local/bin/kortix`
(`apps/sandbox/Dockerfile:244`), self-authenticating from `KORTIX_TOKEN` /
`KORTIX_API_URL` / `KORTIX_PROJECT_ID`.

> **Why it is still pending.** That binary is COMPILED INTO the sandbox image,
> and the image is built by `deploy-dev.yml` — on main. `deploy-preview.yml`
> builds only the gateway, API and frontend, so the branch preview runs new API
> code against an old sandbox image. Measured on pi.kortix.com: an agent
> answered `/usr/local/bin/kortix` for `command -v kortix` and
> `FS_SUBCOMMAND_ABSENT` for `kortix fs --help`. The mechanism is proven; the
> binary is stale until this branch merges and dev deploys.

---

## What an adversarial review found (2026-09-02)

Four reviewers with distinct lenses (security/tenant isolation, data integrity,
agent usability, HTTP/SDK contract), each finding handed to a verifier told to
REFUTE by default. 22 agents; the survivors, all now fixed:

| Severity | Defect | How it was proven |
|---|---|---|
| high | Chunked PUT buffered the whole body before the size check | verifier reproduced an OOM on **bun 1.2.23**, the version the image pins; the same probe 413s on a laptop's 1.3.14 |
| high | A caller-chosen filesystem name un-bounds the 25 s deadline | `path.includes('/start')` matches `/filesystems/start/files/content` |
| medium | Path percent-decoded twice, aliasing distinct names onto one key | measured on the preview: two writes, ONE row, first file's bytes gone |
| medium | `?limit=abc` → NaN → LIMIT clause dropped, returns every row | `Math.min(Math.max(NaN,1),1000)` is NaN |
| medium | Stored content-type echoed with raw bytes — stored XSS | a file written `text/html` executed on the API origin |
| medium | SDK surfaced every error as the literal string `"true"` | the platform envelope sets `error` to BOOLEAN `true` |
| low | Virtual-host S3 branch dropped the bucket from the request | dead code today, wrong the day it is used |

Two lessons worth keeping: the first OOM fix (a `content-length` gate) did NOT
close it, because a chunked request declares no length — the review caught the
incomplete fix as well as the bug. And the unit tests MASKED the double decode
by feeding wire-shaped strings that never occur over HTTP.

## Open work

Ordered by what blocks the most.

1. **Agent path to production** — merge to main → `deploy-dev.yml` rebuilds the
   sandbox image → re-probe a live session for `kortix fs --help`. Nothing else
   is needed; this is a deploy, not a code change.
2. **The warm pool stays off everywhere** (`KORTIX_PI_WORKER_POOL_TARGET=0`).
   The claim-durability fix (a claimed box must resume as a worker, never
   re-park) is proven against the real baked script through a real stop/resume,
   but never on a live pooled box, because creating one requires the pool. The
   pool is DAYTONA-ONLY and that is load-bearing: the claim lives on the box's
   writable layer, so it only survives a provider whose resume returns the same
   box with its disk intact.
3. **Filesystem versioning** — Marko deferred it explicitly ("probably over time
   we're going to have like a versioning system"). Content addressing already
   makes it cheap: a version is another row pointing at a blob that already
   exists.
4. ~~**Blob garbage collection**~~ — **done and scheduled.**
   `sweepUnreferencedBlobs` (`filesystems/gc.ts`) decides WHICH blobs are
   collectable; `filesystems/blob-sweeper.ts` decides WHEN, hourly among the
   leader-elected singleton workers. The safety rule is the GRACE PERIOD, not
   the reference check: `putFile` stores bytes then metadata, so a blob is
   legitimately unreferenced mid-write.
5. **`message.removed` / `message.part.removed`** — Kortix uses them for revert
   and compaction; pi's `Session` tree can branch but nothing wires it to
   `Agent`. Frontend-visible.
6. **`PREVIEW_MANAGED_GIT_GITHUB_TOKEN` does not exist**, so previews have no
   managed-git credential. An in-sandbox guard restores it ~150 s after every
   deploy wipes it; until then session create answers 500. Creating the secret
   needs repo admin and would retire the guard.

---

## How to verify this system

Nothing here is a unit test; each command talks to the deployed environment.

```bash
# whole system, 19 checks: health, auth, session, worker, a real turn,
# resume, filesystems, the CLI path, tenant isolation
bash scratchpad/pi-system-test.sh scratchpad

# the isolation invariant (requirements 7 and 8)
cd apps/kortix-worker && bun test src/isolation.test.ts

# filesystems: 16 path-normalisation + 11 blob-store unit tests,
# plus 5 S3 integration tests against a real S3 server
docker run -d --name kortix-fs-minio -p 19000:9000 \
  -e MINIO_ROOT_USER=kortixtest -e MINIO_ROOT_PASSWORD=kortixtest123 \
  minio/minio:latest server /data
docker exec kortix-fs-minio mkdir -p /data/kortix-fs
cd apps/api && dotenvx run -- bun test ./src/filesystems/

# the CLI as an agent invokes it — from the repo, against any environment
export KORTIX_API_URL=https://pi.kortix.com/v1 KORTIX_TOKEN=<jwt> \
       KORTIX_PROJECT_ID=<project>
cd apps/cli && echo "handoff" | bun run src/index.ts fs put notes plan.md
```

The S3 integration suite **skips cleanly** when MinIO is not running, and one of
its five tests asserts that a WRONG SECRET IS REJECTED — so the passing
round-trips prove the SigV4 signature is correct rather than proving the server
accepts anything.

---

## Rules this branch paid for

Each of these is in `.claude/skills/learnings/SKILL.md` with its incident:

* a claim delivered over HTTP is not durable state — persist it before
  acknowledging, or the first resume loses it;
* a test that SIGKILLs a child orphans its grandchildren, and a leaked listener
  poisons a fixed port range;
* two repairs for the same deploy race each other, and the loser's fix is
  silently undone;
* a bare directory pattern in `.gitignore` matches at EVERY depth, and a test
  that reads the working tree cannot see what was never committed;
* an OpenAPI `{param}` matches ONE path segment, so a route carrying a file path
  404s on every real path;
* `bun test` is not the SDK's gate — `bun run test` is, and the difference is
  532 failures;
* a CLI change reaches agents only when the sandbox image rebuilds.
