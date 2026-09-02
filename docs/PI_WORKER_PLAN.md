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
5. ~~**`message.removed` / `message.part.removed`**~~ — **done.** Rewind is
   implemented in the worker: `POST /session/:id/revert` and `/unrevert` at the
   RAW ROOT (where the SDK's prefix-less OpenCode client lands), publishing one
   `message.removed` per hidden message. Staged and reversible; the next prompt
   commits. `apply()` learned both removal events so a reconnecting client
   reads the same transcript as one that watched it. What is NOT done is
   compaction — the same events would carry it, but nothing summarises yet.
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

---

## Where we are against "Splitting the Harness"

The architecture read (huddle 2026-08-26) set Phase 0, gate G0 and Phase 1.
Status against its own criteria, not against a summary of them.

**Phase 0 — the Pi spike. Cleared, all five proofs.** Tool replacement holds,
the gateway works, it bundles and boots fast, history survives the process, and
the event stream is enough. `spikes/pi-worker/README.md` carries the numbers.

**Gate G0 — the RPC tax. Measured: WARN.** Multiplexed WebSocket 16.0 ms p50
vs pooled keep-alive 19.2 ms vs per-call fetch 20.3 ms. The finding that
matters is the second one: the tax is set by the provider's topology, not by
us — both sandboxes sit in one Daytona region yet traffic leaves through the
public edge. The split wins clearly to ~100 tool calls per turn and is
break-even beyond.

**Phase 1 — the worker. Four of five pieces done.**

| # | Piece | State |
|---|---|---|
| 1 | `apps/kortix-worker` — HTTP+SSE around Pi, SDK-backed tools only | done, and the isolation invariant is pinned by a test |
| 2 | Compile pipeline: `kortix.yaml`@sha → one `.mjs`, content-addressed | done — `pi_runtime_artifacts`, one bundle per agent per commit |
| 3 | Worker template — Alpine + supervisor that fetches and execs | done — pi-worker snapshot, entrypoint, `fetch-runtime.mjs` |
| 4 | Session start on the worker, **with the before/after number** | half — sessions start and answer; **the number does not exist** |
| 5 | Tool RPC into a lazily-provisioned environment | half — lazy env works; transport is not the multiplexed one |

The doc is unambiguous about what piece 4 is for: *"That number is the entire
justification for the project; produce it early."* It has not been produced.

---

## Phase 2 — the plan

Ordered by what the architecture doc says decides success, not by what is
pleasant to build. Items 1–3 are the ones that can still invalidate the design.

### P2.1 — Produce the number — **DONE, with one leg missing**

Clock: `spikes/pi-worker/bench/ttft-session.ts`. It starts OUTSIDE the API, so
it is a strict superset of the API-side clock the doc asks for, and it
attributes four phases — create, ready, prompt, **first assistant text**.

**Measured 2026-09-02, 10 runs each, same prompt.**

| path | env | provider | ready p50 | **TTFT p50** | TTFT p95 | n |
|---|---|---|---|---|---|---|
| pi worker, cold (pool off) | preview | daytona | 2.90s | **4.25s** | 8.76s | 10/10 |
| opencode | dev | platinum | 21.52s | **29.19s** | 59.27s | 13/13 |

That is **6.9× on time-to-first-token** and 7.4× to a reachable runtime.

**The doc's instrumentation claim is confirmed, and it is the solid result
here** because it is measured within ONE environment: the in-guest
`session_start_timeline` reports **0.08s p50** while the wall clock to a
reachable runtime is **2.90s**. The existing instrument sees about **3%** of
the cost. Nothing built on `bootMark()` could have produced the row above.

> #### The leg that is missing, and it is the one that matters
>
> The doc's bar is *"worker cold start versus today's WARM-POOL HIT"*, and
> warns: *"If the worker only beats the cold path, we have spent a quarter
> matching what a cache already delivers."*
>
> **A warm-pool hit was never observed.** Thirteen consecutive dev sessions all
> took ~20s to become reachable, dev `/health` exposes no pool state, and the
> session metadata carries no pool markers. So the row above is
> **cold vs cold** — the charitable comparison, not the bar.
>
> Two further confounders, stated rather than buried: the two legs ran in
> DIFFERENT environments on DIFFERENT providers (daytona vs platinum), where
> the doc asks for same-region. And the opencode leg's `prompt` column can read
> later than its `TOKEN` column, because its first token is seen on `/event`
> before the message POST resolves; `TOKEN` is the meaningful column.
>
> **What is proven:** the split is worth ~7× against a cold start, and the old
> instrument could not have shown it. **What is not:** that it beats a warm
> cache. Until a pool hit is measured, the honest claim is the doc's weaker
> one — the worker makes warm-path latency the *default and deterministic*
> case rather than a probabilistic cache hit.

### P2.2 — Environment readiness — **partly done, and the limit is stated**

**Measured, same cold session on pi.kortix.com:** first token **4.25s**, first
`bash` call **37.5s**. The environment's cold start did not go away with the
split; it moved out of session setup and into the middle of the first answer.
An earlier probe failed outright with
`could not attach environment: environment status: provisioning`, so this is
not only slow, it has been seen to break.

**Shipped:** `LazyKortixEnv.prewarm()`, triggered when the PROMPT arrives.
Not at session create — that would provision for sessions nobody ever prompts,
and a session which never touches compute being dramatically cheaper is part of
what the split is sold on. Not at the first tool call — that is the 37.5s.
`publishUserMessage` runs three lines before `agent.prompt`, so provisioning
overlaps the whole reasoning turn.

It is safe by construction rather than by care: the existing `attaching`
promise makes a tool call arriving mid-prewarm JOIN it instead of starting a
second provision, and a failed prewarm is swallowed because the tool call that
actually needs the environment attaches again and reports it as its own Result.

> **What this does NOT do.** It shortens the wait by roughly the time the model
> spends before its first tool call. It does not remove it. The residual is
> provisioning time minus that overlap, and closing it properly needs a **warm
> pool for environments** — the same idea the session pool already implements
> for the old path, applied to the new one. That is the real P2.2 finish line
> and it is not built.
>
> Not yet verified live: the branch environment is frozen, so the before/after
> on a deployed box is owed.

### P2.3 — The transport — **done, and the plan item was wrong**

The item said "take the transport already measured best". It could not be done
as written: **gate G0's 16.0ms multiplexed-socket number came from the spike's
STUB environment.** The real daemon served only `POST /` and `POST /rpc` —
there was no `/rpc-ws` anywhere in `apps/kortix-sandbox-agent-server`.
Defaulting the worker to `ws` would have broken every tool call in production.
G0's own record should be read with that in mind.

**Shipped:**

* The daemon upgrades `/kortix/env-rpc/rpc-ws`, reusing the pty websocket
  machinery already in `Bun.serve`. Each frame is dispatched by re-entering the
  app's own HTTP route with a synthetic request, so the ~250-line op switch is
  not duplicated — a websocket tool call behaving differently from the same call
  over POST is the bug nobody goes looking for.
* The worker NEGOTIATES: one probe per session, then the socket for the rest of
  it, or pooled keep-alive for the rest of it. Daemons are image-baked, so a
  sandbox created before this endpoint exists will never serve it.
* A failure *after* the socket has served a call is rethrown, not masked. That
  is a dropped connection; switching quietly to HTTP would hide a broken
  environment behind a slower one.
* The API's WS proxy needed no change — `ws-proxy.ts` matches any path under
  `/v1/p/<ext>/<port>/` and forwards the signed user context as a header and,
  optionally, a query parameter. The daemon accepts either.

**Keep G0's actual conclusion in view:** transport is worth 21%, not an order of
magnitude, and **co-location is the lever** — a provider-selection criterion,
not a code change. The reason to take the socket anyway is correctness: per-call
HTTP already produced a bug in the spike when a keep-alive socket was retired
between calls.

> Not verified live. The branch environment is frozen, and a daemon change
> reaches only newly baked images regardless — so this is the first item whose
> verification needs an image rebuild, not just a deploy.

### P2.4 — `session_id == sandbox_id` stops being true — **scoped: 28 sites, not done**

The item said to scope this honestly before starting. Scoped. **The honest
answer is that it is much bigger than this plan assumed, and my first reading of
it was wrong.**

What I concluded first, from reading the storage layer: *"P1.7 already did the
refactor."* That is true of the storage and only the storage —
`session_environments` is its own table with `sessionId` as the primary key, the
claim is an `INSERT … ON CONFLICT DO NOTHING`, the worker reaches the box over
the provider edge rather than the session proxy, the credential question is
settled (*"the environment IS the session, credential-wise"*), and stop/delete
are wired into the session lifecycle with metering brackets.

What that reading missed is that **the split leaked into every consumer that
assumed one runtime per session, and none of them were updated.** A 55-agent
audit of six surfaces found 49 candidate sites and confirmed 28 (21 dismissed).
Full detail: [`PI_P24_SCOPE.md`](./PI_P24_SCOPE.md).

By surface: 4 api-session, 3 auth/credential, 2 proxy, 8 lifecycle, 4 SDK,
7 DB/tests. By effort: 11 mechanical, 17 design-needed.

**The three that matter most, and the first is verified live:**

1. **Environment compute is not billed.** `startComputeSession` is called with
   `sandboxId: environmentId` (a fresh `randomUUID`) and no `workloadType`, so
   it defaults to `'session'`; the billing invariant sweep joins
   `session_sandboxes` on `sandboxId`, finds nothing, and
   `decideComputeClose` returns `sandbox-row-missing` on its first pass — every
   5 minutes. Measured on pi.kortix.com: **21 environments hold an
   `environmentId`, exactly ONE has a compute row at all, it ran 88.5 s, and the
   total billed is $0.0049.** The 20 missing rows are not explained by the sweep
   alone and want their own look. `workload_type` is also CHECK-constrained to
   `('session','app','monitor')`, so `'environment'` is not representable
   without a migration — this one is design-needed, not a join.

2. **A stopped environment wedges its session permanently.** The provider's
   `autoStopInterval: 60` powers an idle environment off, but nothing writes
   `stopped` to its row — `applyStoppedState` is keyed on the worker's
   `session_sandboxes` row and the provider webhook keys on an `externalId` the
   environment does not have. `ensureSessionEnvironment` then short-circuits at
   line 182 on `status === 'active' && externalId` before the re-claim, so it
   returns a box that is off, and every tool call fails with nothing to repair
   it. On pi, 20 of 21 environment rows read `active` with a box attached.

3. **The automatic stop paths never touch the environment.**
   `stopSessionEnvironment` has two call sites, both manual (`stop.ts:129` and
   the explicit route). The dominant path — `deadline_expired` →
   `stopExpiredBox` — stops the worker only, so a reaped session leaves its
   environment running for up to another hour.

**What landed in this session** is the reaper tie-in the code records against
itself (*"Metering + reaper tie-in is the recorded fast-follow"*), plus one
design correction found by measuring:

- `reaping/orphan-environments.ts`, wired into the maintenance tick. Session
  gone (no row, or soft-deleted past a 5-minute grace so it never races the
  inline teardown) → delete. Idle a week → delete. Merely idle a day → **stop,
  never delete.**
- That last distinction is the correction. The first version deleted on a 24h
  idle horizon. Then I measured pi: **16 of 21 environments are idle past a day
  while their sessions are alive.** An environment holds the session's WORKING
  TREE — committed work is safe on the session branch in the git mirror, but
  uncommitted changes exist only in that box. Deleting on the short horizon
  would have destroyed sixteen live sessions' uncommitted work, to reclaim
  compute the provider's own auto-stop had already stopped billing for. A week
  of silence is evidence nobody is coming back; a day is not.
- It also happens to unwedge failure (2) after 24 h, because writing `stopped`
  is exactly what lets `ensure` resume. That is a side effect, not the fix.
- Teardown split into `platform/services/session-environment-teardown.ts`.
  Importing `deleteSessionEnvironment` from the service pulled the whole
  provisioning graph (image builder, git, manifest schema, agent-config
  compiler) into every API process to run a delete, and broke
  `e2e-project-maintenance.test.ts` with a `mock.module` cascade — the
  2026-08-27 learning. Fixing the import rather than the mocks cost one module
  and zero mock edits.

> Verified: 10 + 15 + 6 + 3 + 149 tests pass across `orphan-environments`,
> `routes/session-environment`, `maintenance`, `e2e-project-maintenance` and
> `sandbox-reaper`, run per-file (co-running hits the known apps/api
> `mock.module` leak). `tsc --noEmit` clean. The reap rule was mutation-checked
> before the redesign. **Not verified live:** no reap has been observed on a
> deployed API — the short horizon is 24 h.

**Recommended order for the remaining 28**, since they are not equal: (1) the
wedged-session bug, because it is user-facing and live on pi today; (2) the
automatic stop paths, which are mechanical and stop the bleeding; (3) billing,
which needs a migration and belongs in one deliberate change; (4) the SDK and
proxy items, which are genuinely P2.5/P2.6 work and should move with them.

### P2.5 — Two lifecycles that can disagree

Reaping, idle timeouts, wake fences and billing all assume one runtime per
session. **A live worker with a reaped environment must be a defined state, not
a discovered one** — including what the next tool call does when it finds one.

### P2.6 — The secret boundary follows the worker

The session credential is pinned to its sandbox and rejects mismatched egress.
The worker now holds the model keys and the Kortix credential, so that pinning
has to move with it, and the environment becomes a second, separately-scoped
principal.

### P2.7 — Ship it where nobody is watching

The doc's own rollout: triggers, schedules and channel-started sessions run
with no human waiting on a first token, so a regression there costs latency,
not a customer's live demo. Ship the worker path to those before any
interactive traffic.

---

## What is NOT in Phase 2, deliberately

* **Filesystem versioning** — deferred in the huddle; content addressing makes
  it cheap whenever it is wanted.
* **Compaction** — rewind ships the removal events it would ride on, but
  nothing summarises yet.
* **Durable Objects** — explicitly deferred in the doc; micro-VM first, and the
  program does not change.
* **Closing the custom-tool leak completely** — the doc's honest position is
  that arbitrary in-process code can always find a writable path. The four
  mitigations remove the accidental cases; the deliberate case stays a user
  error with a recovery story.

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
