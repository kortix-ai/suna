---
name: learnings
description: "The project's hard-won incident learnings — durable rules extracted from real outages and near-misses, each with the incident that taught it. Load WHENEVER you write or review a DB migration or schema change, touch deploy/release workflows (.github/workflows/deploy-*, promote.yml, vercel config), plan a promote/release, respond to a prod incident, or when another skill references a learning. ALSO load after resolving any incident: this file is append-only and every new incident MUST deposit its rule here."
---

# Project learnings

Rules paid for with real downtime. Each entry: the rule first, the incident that
taught it second. This register is **append-only** — when an incident or
near-miss resolves, add its rule here in the same session, newest first. Keep
entries under ~8 lines; deep detail goes in the incident's memory/RCA and is
linked, not inlined.

## How to add a learning

1. Write the RULE as an imperative a developer can obey while coding.
2. Name the trigger surface (what someone is doing when it applies).
3. One-line incident citation (date, version, blast radius).
4. Reference any enforcing automation (lint, CI gate, workflow) — a learning
   with an enforcer is a fact; one without is a TODO to build the enforcer.

## Register

### Parse untrusted text with one forward scan, not a backtracking regular expression (2026-09-03)

**When:** trimming URLs or extracting text from upstream HTML and other untrusted response bodies.
**Incident:** the Pi PR introduced three high-severity CodeQL alerts; 30,000 trailing-slash
candidates took 363 ms, and 10,000 unclosed HTML tags took 425 ms on a developer machine.
**Rule:** use an index or cursor that advances monotonically. Add an adversarial-size regression test.
**Enforcer:** CodeQL blocks polynomial regexes; the worker and SDK tests cap both cases at 100 ms.

### Read deployed capability and environment facts from the target, not the runner label (2026-09-03)

**When:** writing browser assertions for a deployed preview, staging, or production target.
**Incident:** the Pi gate called its target `custom`, while `/v1/health` correctly reported
`preview`; another test required Platinum even though the target exposed Daytona only.
**Rule:** read the environment and available providers from target responses, then assert the UI
renders that exact contract. Do not translate runner labels or hard-code optional providers.
**Enforcer:** `18-apps-ui.spec.ts` reads health; `12-sandbox-templates.spec.ts` reads provider coverage.

### Browser fixtures must not require host CLIs that the test image does not install (2026-09-03)

**When:** adding database setup to a deployed Playwright journey.
**Incident:** three Pi browser journeys stopped at `spawnSync psql ENOENT` before opening the UI.
**Rule:** use the shared `pg` client with parameterized SQL. Do not spawn `psql` from browser fixtures.
**Enforcer:** `test-runner-contract.test.ts` rejects `execFileSync('psql', ...)` in the fixture helpers.

### Shell you GENERATE is expanded by the shell that writes it — transfer it base64, and prove the secret landed in one file (2026-09-02)

**When:** emitting a shell snippet from a TS template literal
(`buildPreviewBootstrapScript`), from a Python string, or through
`docker exec sh -lc "..."` / a provider `exec` API. Anything containing `$1`,
`$(...)`, `"` or `\n` is interpreted by the OUTER shell (or by TS) before the
inner script ever exists.

**Two failures in one afternoon, same root cause.** (1) An inline credential
helper, `git config credential.helper "!f() { ...; echo "password=$(cat $F)"; }; f"`
— the nested double quotes collapse, the outer shell runs `$(cat $F)` at CONFIG
time, and git stores the literal token in `.git/config`. (2) The workaround for
(1), written with `printf %s "...\n..."` through a provider exec: `%s` does not
interpret `\n` so the helper became one line, `$1` expanded to empty (`[ "" = get ]`),
and `$(cat ...)` expanded again — inlining the token a second time.

**The rules:** (1) transfer generated scripts **base64-encoded**
(`echo <b64> | base64 -d > file`) — the repo's own `encodedFileCommand` already
does this; (2) a credential belongs in exactly ONE file, and the check is a
`grep` for the token pattern across the config AND the helper, not just the one
you were thinking about; (3) `bash -n` proves syntax, never semantics — both
broken versions passed it. Only running the snippet and grepping the result
caught either.

**The enforcer that works:** a test that WRITES a sentinel token, executes the
emitted snippet in a temp repo, and asserts the sentinel is absent from
`.git/config` while the helper still answers `get` with it
(`tests/unit/sandbox-preview.test.ts`). Text assertions on the generated script
passed happily while the token leaked.


### A second runtime per session inherits none of the first one's reconcilers, and a status column nobody writes is a permanent wedge (2026-09-02)

**When:** giving a session a second box — a pi environment, or anything else
that gets its own table instead of a `session_sandboxes` row. Every reconciler,
sweep, meter and stop path in this repo keys on `session_sandboxes`, and a new
table silently opts out of all of them at once. Grep for the table name across
`billing/`, `reaping/` and `session-lifecycle/` before assuming a lifecycle is
wired; `stopX`/`deleteX` existing and being CALLED from the manual paths proves
only the manual paths.

**The wedge:** `session_environments.status` had exactly one writer
(`stopSessionEnvironment`, reachable only from the manual Stop and its route),
while the box carried `autoStopInterval: 60`. So the provider powered boxes off
and nothing wrote it down. `ensureSessionEnvironment` short-circuited on
`status === 'active' && externalId`, and `claimEnvironmentWork` re-claims only
`error`/`stopped`/stale `provisioning` — never `active`. A stopped box therefore
served forever from a row that could not be re-claimed: every tool call failed
and nothing in the system could repair it. **20 of 21 rows on pi.kortix.com read
`active` with a box attached.**

**The rules:** (1) any status column a PROVIDER can change behind your back must
be verified against the provider before it is trusted, not just written on the
paths you control; (2) `unknown` from an unreachable provider must not
authorize a teardown — serving stale is the recoverable mistake (the same split
`providers/status.ts` records as "the single most expensive bug in this
subsystem"); (3) a new runtime table needs its billing join, its stop-path
write, and its reaper entry added deliberately — `startComputeSession` defaulting
`workloadType` to `'session'` for a non-session box makes the invariant sweep
close its meter on the first pass. Measured: 21 environments, ONE compute row,
88.5 s, $0.0049 total.

*Scope:* found by a 55-agent audit — 49 candidate sites, 28 confirmed — recorded
in `docs/PI_P24_SCOPE.md`. The wedge and the reaper tie-in are fixed; billing
(needs a `workload_type` CHECK migration) and the automatic stop paths are not.
*Enforcer:* `environment-liveness.test.ts` pins the decision, and
`routes/session-environment.test.ts` pins that `ensure` actually calls it.
Nothing yet asserts that a new runtime table appears in the billing sweep.


### A `pull_request_target` deploy runs the DEFAULT BRANCH's scripts, so a fix to the deploy path is dark until it reaches main (2026-09-02)

**When:** changing anything under `tests/src/core/sandbox-preview.ts`,
`tests/bin/preview-stack.ts`, or the Caddy/compose templates a preview
generates, and then testing it by pushing to the branch that owns the preview.
`deploy-preview.yml` is `pull_request_target`; its build jobs check out
`needs.authorize.outputs.sha` (your commit) but the **deploy job checks out
`${{ github.event.repository.default_branch }}`**. So the images are yours and
the deploy logic is main's. A push proves nothing about a deploy-script change,
and the change cannot fail loudly — it simply never runs.

**The incident:** a branch environment is REUSED, so nothing reclaims the images
each deploy supersedes; ~3 GB of api/frontend/gateway layers accumulate on a
50 GB disk. A prune was written on `pi-worker` weeks earlier and never took
effect, because the deploy reads main. pi.kortix.com reached 100% / 0 avail:
`supabase-db` crash-looped on `could not write lock file "postmaster.pid": No
space left on device`, `supabase-kong` restarted, `preview-edge` and 12 other
services stayed in `Created`, and the deploy's own health gate then refused to
re-point the hostname — correctly — leaving a 502 for ~30 min. 22.2 GB pruned
by hand restored it (100% -> 54%).

**The second rule, from the same incident: never gate a cleanup behind the
health it protects.** The prune ran only AFTER the new stack proved healthy,
which is exactly the state a full disk prevents — the cleanup sat behind the
failure it existed to prevent. Reclaim before the pull as well, gated on the
disk actually being tight (`image prune -af` spares every image a container
references, running or not).

**Diagnostic:** `x-kortix-environment: pi` present on a Cloudflare 502 means the
Worker is healthy and passing an upstream failure through; the sandbox origin
answering `upstream-unreachable: Failed to connect` means nothing is listening
on 8080. Then `df -h /` inside the box, not the deploy log.
*Enforcer:* none. A check that a PR touching the preview deploy path is on
main before it is trusted, or a disk-usage assertion in the deploy summary,
is the TODO.


### A persistent preview sandbox cannot fetch a PRIVATE repo, so the branch env silently freezes on an old commit (2026-09-02)

**When:** relying on a persistent branch environment (`preview` label,
`deploy-preview.yml`) to reflect what you just pushed.
`tests/src/core/sandbox-preview.ts:97-99` does
`git remote set-url origin https://github.com/<repo>.git` and then
`git fetch --depth=1 origin <ref>` — with NO credential. That only works while
the sandbox happens to hold one, and `kortix-ai/suna` is private: an anonymous
`git ls-remote` inside the box answers
`could not read Username for 'https://github.com'`. Verified in the live pi
sandbox that it has no credential at all — no repo config, no
`~/.gitconfig`, no `~/.git-credentials`, no `GIT_ASKPASS`.
**The failure is SILENT in the worst way.** The deploy step is
`continue-on-error: true`, so the job keeps going, "Point the stable hostname"
never runs, and the environment keeps serving the LAST commit that fetched.
`/v1/health` reports `status: ok` the whole time — it is healthy, just old. Five
consecutive deploys failed this way before it was noticed, and two rounds of
"live verification" in between were actually testing stale code and reported
the OLD behaviour as the current one.
**Rules:** (1) after any preview deploy, assert `/v1/health`'s `commit` EQUALS
the SHA you pushed — a 200 proves the environment is alive, never that it is
current, and this is the same class as the deploy-dev rule about a green
`/health` not being deployment proof; (2) treat a `continue-on-error` deploy
step as a step that WILL fail unnoticed — the run's conclusion is not the
environment's state; (3) a persistent sandbox needs a durable credential, not
whatever it was created with.
**Diagnostic:** the deploy log shows `HEAD is now at <older sha>` followed by
`fatal: could not read Username`, four retries, exit 128 — and the environment
answers healthy on that older sha.
*Incident:* pi.kortix.com frozen on `ef2163ba` while seven later commits sat
pushed and undeployed. Unblocking needs `PREVIEW_MANAGED_GIT_GITHUB_TOKEN` (or
any repo-scoped credential in the box), which requires repo admin.
*Enforcer:* none. A post-deploy assertion that health's `commit` equals the
pushed SHA would have caught it on the first failure instead of the fifth.

### A CLI change does not reach agents until the SANDBOX IMAGE is rebuilt, and the preview never rebuilds it (2026-09-02)

**When:** adding or changing a `kortix` CLI command that agents are meant to
use. The agent path is `bash` → `kortix …` inside the session ENVIRONMENT, and
that binary is COMPILED INTO the sandbox image
(`apps/sandbox/Dockerfile:244`, `COPY --from=cli-builder /cli/kortix
/usr/local/bin/kortix`). That image is built by `deploy-dev.yml` — on main.
`deploy-preview.yml` builds only the gateway, API and frontend images, so a
branch preview runs NEW api code against an OLD sandbox image.
**Measured:** with `kortix fs` committed and the preview deployed, an agent on
pi.kortix.com answered `/usr/local/bin/kortix` for `command -v kortix` and
`FS_SUBCOMMAND_ABSENT` for `kortix fs --help`. The mechanism was fine; the
binary was three commits stale.
**Rules:** (1) a CLI change is verifiable on a preview only by running the CLI
from the REPO against the preview's API (`KORTIX_API_URL` + `KORTIX_TOKEN` +
`KORTIX_PROJECT_ID` env, which is exactly how the in-sandbox CLI
authenticates) — the in-sandbox binary proves nothing until dev redeploys;
(2) never conclude "agents can use it" from a green API test; probe the actual
binary in a live box; (3) when a new CLI subcommand is the agent surface for a
feature, say in the PR which deploy makes it real.
**Diagnostic:** `command -v kortix` succeeds but the new subcommand prints
usage/unknown — a stale image, not a broken command.
*Near-miss:* would have shipped `kortix fs` believing agents could already call
it. Caught by probing a live session instead of trusting the API tests.
*Enforcer:* none. A check that the sandbox image's CLI version matches the
deployed API commit would catch it.

### `bun test` is not the SDK's gate — `bun run test` is, and the difference is 532 failures (2026-09-02)

**When:** judging whether a change to `packages/sdk` is green. The package's own
script is `find src -name '*.test.ts' | xargs -n1 -P4 bun test --isolate` — ONE
FILE PER PROCESS. Running a bare `bun test` in that directory puts all 188 files
in one process, where the suite's `mock.module` calls replace modules wholesale
and take unrelated files down with them: measured 2230 pass / **532 fail**
against 2770 pass / **0 fail** for the same tree under the real script. The
failures name real-looking things (`backendApi.post is not a function`,
`Failed to write file (502)`) and point at the victim, never the polluter.
**Rules:** (1) use `bun run test`, never `bun test`, to judge this package;
(2) a new suite here will pass alone and fail in a shared process — that is the
pre-existing leak, not your code, and the way to tell is a git-stash baseline of
the SAME command, both numbers written down; (3) when the two numbers differ by
hundreds, suspect the runner before the diff.
**The other half:** adding exports fails
`public-surface`/`public-type-surface` by design. Those are a QUESTION — "did I
mean to change the public API?" — not a test to re-record. Answer it by
set-comparing old against new and confirming REMOVED is empty; additive is safe,
a removal or rename is a breaking change needing an alias. Regenerate only then,
with `UPDATE_SURFACE_SNAPSHOT=1` / `UPDATE_TYPE_SURFACE_SNAPSHOT=1`.
*Near-miss:* the filesystems SDK surface looked like it had broken 542 tests;
the real number was 2 (both snapshots), both additive, both expected.
*Enforcer:* the package's `test` script already encodes the right invocation —
the trap is only for someone who types `bun test` out of habit.

### An OpenAPI `{param}` matches ONE path segment, so a route carrying a file path 404s on every real path (2026-09-02)

**When:** putting anything slash-bearing into a typed route parameter — a file
path, a ref name, a nested key. `@hono/zod-openapi`'s `{path}` compiles to a
single-segment matcher, so
`/{projectId}/filesystems/{name}/files/{path}` served `plan.md` and 404'd
`notes/2026/plan.md` — which is most real paths. The HANDLER was correct; the
pattern it hung off never matched, so the failure looked like "file not found"
rather than "route not found", and every negative test still passed for the
wrong reason.
**What made it invisible locally:** 32 unit tests were green — the path
normaliser, the blob store against real MinIO, the whole service layer — because
none of them route. A green unit suite says the pieces work; it says nothing
about whether a request can REACH them. The bug surfaced on the first real HTTP
call to the deployed preview, on the third step of nine.
**Rules:** (1) a path-shaped value travels as a QUERY parameter
(`?path=`) unless the router is known to support wildcards — this API already
established that with `/v1/projects/:id/files/content?path=`; (2) every new
route family gets one real request against a deployed origin before it is
called done, and the request must use a REALISTIC value (a nested path, not
`a.txt`); (3) when a route 404s, check whether the pattern matched at all
before debugging the handler.
**Diagnostic:** sibling routes on the same prefix work (`create`, `list`,
`delete` all 2xx) while one family 404s — that asymmetry is a routing shape
problem, not a data problem.
*Near-miss:* caught on the pi-worker preview before reaching main or a user.
*Enforcer:* flows FS-1..FS-4 use `notes/2026/plan.md`, a genuinely nested path,
so a segment-matching regression fails the suite rather than passing on a
flat filename.

### A bare directory pattern in .gitignore matches at EVERY depth, and a test that reads the working tree cannot see what was never committed (2026-09-02)

**When:** adding product content under a directory name that also appears in
`.gitignore` — starter templates, fixtures, scaffolds, vendored config. Root
`.gitignore` carried `.kortix/` with no leading slash, written to drop the
repo's own dogfood project. Git applies such a pattern at ANY depth, so it also
matched `packages/starter/templates/pi/.kortix/` — the scaffold every new pi
project is built from. `git add` reported nothing, the commit went in without
the files, and the branch shipped a pi template of four files: a manifest
declaring `default_agent: kortix` whose agent markdown did not exist, and no
`.kortix/pi/` for `kortix init` to link into, so all six of its symlinks
dangled. `templates/base/` predated the rule and stayed tracked, which is why
only the NEW template was hit.
**The reason it survived review:** `pi-template.test.ts` and
`pi-starter-compiles.test.ts` both assert exactly the missing files
(`map.has('.kortix/pi/agents/kortix.md')`, body > 200 chars) and both PASSED
locally — they read the working tree, where the ignored files sat on disk. A
green local suite says nothing about what is in the commit. Reproducing the
committed state by moving the two files aside turned 12 pass into 3 fail.
**Rules:** (1) anchor an ignore meant for the repo root with a leading slash
(`/.kortix/`), or pair the broad rule with an explicit
`!packages/**/templates/*/.kortix/` re-include; (2) after adding files under
any name that appears in `.gitignore`, run `git status --ignored` or
`git check-ignore -v <path>` before trusting a silent `git add`; (3) verify a
packaging change from a FRESH CLONE, never from the working tree that authored
it — `git ls-files <dir>` is the cheap version of that check.
**Diagnostic:** product files present on disk, absent from `git ls-files`, and
a scaffold whose file count is smaller than the template's directory listing.
*Near-miss:* caught on the pi-worker branch before it reached main or any user;
every `kortix init` on the pi template would have produced an agent-less project.
*Enforcer:* the two tests above are correct and now run against committed
content; the `!packages/starter/templates/*/.kortix/` re-include is what keeps
them honest.

### Two repairs for the same deploy race each other, and the loser's fix is silently undone (2026-09-01)

**When:** any environment where a deploy REGENERATES config and more than one
actor patches it back. On pi.kortix.com the deploy rewrites
`docker-compose.preview.yml` from main's `tests/`, dropping the `kortix-api`
git-cache volume. Two things restore state afterwards: `post-deploy.sh` (runs
when the deploy run reports success) and the in-sandbox managed-git guard (runs
150 s after it sees the token wiped). Both call the same
`docker compose … up -d --force-recreate --no-deps kortix-api`. Whichever runs
LAST decides the outcome — and the guard recreated against the still-stripped
overlay at 18:19:43, giving the API an unmounted `/tmp/kortix`. Every project's
git mirror, including pi-lab's bare upstream, disappeared from the container's
view and `POST /projects/:id/sessions` answered **500 GitOperationError: '…/pi-lab.git'
does not appear to be a git repository**. The data was never lost — the volume
still held all 67 refs; only the mount was missing.
**Rules:** (1) every actor that recreates a container must ASSERT the full
desired config first, not assume a sibling script already did — the guard now
re-appends the volume block before its own recreate; (2) a repair script is not
a substitute for the config reaching `main`; (3) when a deploy regenerates
config, enumerate everything that recreates containers on that box before
declaring the environment fixed.
**Diagnostic:** `docker inspect <api> --format '{{range .Mounts}}…'` returning
EMPTY while `docker compose … config` shows the volume correctly — that gap means
the RUNNING container predates the config, so read the container's `Created`
timestamp against the repair logs.
*Incident:* pi.kortix.com session-create broken ~18:19–18:26 UTC, found by a
verification turn rather than by an alarm. No user traffic.
*Enforcer:* the guard's own assertion (in-sandbox). The real fix is landing
`tests/` on main so nothing has to be re-applied at all.

### Env handed to a process over HTTP is not state the box owns; persist it or the first resume loses it (2026-09-01)

**When:** any handoff where a long-lived box is told WHAT to be at runtime — the
pi worker pool's park/claim, and anything else that boots generic and is
specialised by a request. `park.mjs` received the claim env over HTTP and
spawned the worker with it **in the child process only**, while the container's
own environment still said `KORTIX_PI_PARK=1`. Stop/resume re-ran the
entrypoint, which exec'd the park script again with the claim gone: port 8000
answered `{parked:true,runtimeReady:false}` forever,
`shouldBootstrapSessionRuntime` retried once, and the session could never run
another turn. Its transcript survived; nothing else did.
**Rules:** (1) persist the claim to the box's disk BEFORE acknowledging it, and
prefer it over the generic path on every later boot — the acknowledgement is a
promise the box must be able to keep; (2) a failed persist answers 500 and stays
claimable rather than accepting a claim it cannot honour; (3) whenever a
container has a "mode" env var, ask what re-running the entrypoint does — a
resume is not a fresh create.
**Diagnostic:** a session whose transcript loads but whose every turn hangs, on
a box whose `/kortix/health` says `parked:true`. A cold-created box resumed
fine, so it read as random until the pool was in the picture.
*Near-miss:* pool is gated off everywhere (`KORTIX_PI_WORKER_POOL_TARGET=0`), so
this never reached a user — it would have shipped with the pool.
*Enforcer:* `pi-worker-park.test.ts` boots the real baked script, claims it,
kills the box, and re-boots the SAME disk.

### A test that SIGKILLs a child orphans its grandchildren, and a leaked listener poisons a fixed port range (2026-09-01)

**When:** any test that spawns a process which itself spawns another (a
supervisor, a park/handoff script, a dev server that forks). `child.kill()`
reaches only the direct child; the grandchild is reparented to init and KEEPS
its port bound. 42 had accumulated on one machine, each squatting a port in the
helper's `18800 + random(500)` range, so a later boot drew a stranger's worker,
got `{runtimeReady:true}` with no `parked` field, and the assertion failed on
`parked === undefined` — 1 run in 6, at a rate that climbed with every run and
therefore looked like a change-induced regression rather than a leak.
**Rules:** (1) `spawn(..., { detached: true })` and kill the process GROUP
(`process.kill(-pid, 'SIGKILL')`) — the group id survives reparenting, so it
reaches the orphans; (2) never pick a test port from a fixed range — bind `0`,
read the assigned port, close, use it; (3) a flake whose rate RISES across a
session is accumulating state on the machine — count the processes before
blaming the diff.
**Diagnostic:** `lsof -nP -iTCP -sTCP:LISTEN` in the range, plus
`ps -o pid,ppid,pgid,command` showing `ppid=1`.
*Enforcer:* `killTree()` + `freePort()` in `pi-worker-park.test.ts`; 12/12 clean
and 0 new leaks afterwards.

### A fix on a path the client never calls is not a fix, and a test that uses the same wrong path certifies it (2026-09-01)

**When:** adding or verifying a route on a runtime the SDK talks to. The pi
worker served the Stop button's abort at `/kortix/opencode/session/:id/abort`.
The SDK builds its OpenCode client with `baseUrl = <backend>/p/<externalId>/8000`
(`getClientForUrl`, packages/sdk/src/core/runtime/client.ts), so
`session.abort()` posts to `<base>/session/:id/abort` — the RAW root.
`handleRawSessionList` was GET-only, so that POST fell through to the worker's
catch-all 404: Stop did nothing, the UI painted "Interrupted" from its own
optimistic receipt, and the agent generated to completion. The route had been
added on 2026-08-29 to fix exactly this symptom — on the wrong path — and all
five of its unit tests drove the prefixed path, so they passed while the
product stayed broken.
**Rules:** (1) verify a runtime route by calling the URL the CLIENT builds,
not the one you wrote — read the client's `baseUrl` and concatenate; (2) when
a surface answers on two prefixes, one of them is the product's; assert THAT
one; (3) a bug reported as "the button does nothing" is a routing question
before it is a logic question — curl both paths and compare status codes.
*Incident:* pi.kortix.com, found by testing Stop by hand — raw 404 vs prefixed
200 on one live session. Fixed in `58f5cdf4`; verified live, a 3000-word
request stopped at 917 words mid-sentence.
*Enforcer:* `runtime-surface.test.ts` -> "the RAW path the SDK calls" drives
`handleRawSessionList` directly.


### A request that provisions a machine can never satisfy the 25s deadline — return status and do the work out of band (2026-08-29)

**When:** writing or reviewing any endpoint that creates/resumes a sandbox, VM,
or other multi-second resource, especially one a poller calls.
`POST /sessions/:id/environment/ensure` awaited a full Daytona provision inside
the request; `middleware/request-deadline` kills every request at 25s, and the
loser of the claim waited a further 120s (`CLAIM_WAIT_MS`). So the FIRST compute
tool call of every pi session got 503 after 503 until the worker's 180s budget
expired: `write` sat at `running` for three minutes and then failed, on a
session that was otherwise healthy. The caller was ALREADY a poller
(`LazyKortixEnv.attach` re-asks every 2s until `active`) — the blocking wait
bought nothing and cost everything.
**The rule:** claim, start the work detached, return the current status. And
detaching costs one thing the request-bound version got free — **a claim whose
owner dies must expire**: nothing else ever re-claims a `provisioning` row, so
add a staleness window (`PROVISION_STALE_MS`) or one crash wedges that resource
forever. Diagnostic: a 503 whose `duration` is exactly the deadline, repeating
at the caller's poll interval.
*Incident:* pi.kortix.com, every session, until #7024. No prod impact — pi is
preview-only. *Enforcer:* `session-environment.test.ts` pins that `ensure` never
awaits the work and that a stale claim is re-claimable.

### An adapter that passes a foreign error vocabulary through breaks the consumer silently (2026-08-29)

**When:** bridging one runtime's filesystem/exec contract to another's over
HTTP (env-rpc, tool bridges, anything returning `{code, message}`).
The daemon's env-rpc is a thin `fs` proxy and returns the real errno; the
worker's `KortixExecutionEnv` handed it straight to pi as a `FileError.code`.
pi's `withFileMutationQueue` canonicalises a mutation target first and tolerates
a path that does not exist YET — but only for code `not_found`, rethrowing
anything else. So `ENOENT` meant **`write` could never create a file**: every
new file died on its own pre-flight lstat and the agent fell back to `bash`
heredocs (10 in one turn, live), while the tool's own description promised
"Creates the file if it doesn't exist".
**The rule:** translate at the adapter, mirror the reference implementation
verbatim (pi's `harness/env/nodejs.js`, its spellings `not_directory` /
`is_directory` included), and map unmapped errnos to `unknown` rather than
leaking a second raw code. A passthrough default is what hides this: the happy
path works, only the CREATE path fails.
*Incident:* pi.kortix.com, all file creation, until #7024.
*Enforcer:* `kortix-env.test.ts`.

### `docker image prune --filter until=24h` reclaims nothing on an environment that redeploys daily (2026-08-29)

**When:** adding disk housekeeping to any long-lived, frequently-redeployed box.
The persistent branch environment pulls ~3GB of images per deploy and never
reclaimed them; it hit 100% and the stack stopped coming up. The first fix used
`until=24h` to "keep today's generation as a rollback" — it reclaimed **0 B**,
because that box deploys several times a day so every superseded image is
younger than a day. Unfiltered (`docker image prune -af`) the same box went
90% -> 46%, 20.35 GB, with all 12 services still running: a running container
holds a reference to its own image, so only genuinely dead layers go.
**The rule:** prune AFTER the new stack passes its health check, with no age
filter, never fatal (`|| true`) — and verify the reclaim on the real box, because
a prune that frees nothing looks exactly like a prune that works.
*Enforcer:* `tests/unit/sandbox-preview.test.ts`.
### A durable FIFO has one order key and advances at one boundary (2026-09-03)

**When:** implementing a queue whose enqueue requests can race. Define one total
order and reuse it for listing, admission, claims, repair, and promotion. Never
mix client send time with database insert time. Promote the next item only after
the current turn closes; delivery-time promotion races terminal promotion and
loses the wake. *Incident:* queued prompts reversed after hydration, and the
next prompt paused up to the 2-second admission backoff. *Enforcer:*
`inbox-order.test.ts`, `integration-prompt-inbox.test.ts`, and
`queued-continue-inbox-delivery.test.ts`.

### A read that fails is not an admin decision — health flags fail open (2026-09-02)

**When:** writing any code path that answers "is the platform in maintenance /
locked down / degraded?", especially one an edge proxy polls.
`getEdgeMaintenanceConfig()` returned a synthetic `level: 'blocking'` whenever
the Vercel Edge Config read threw *or the key was simply absent*. The
`api-router` worker polls that route as `MAINTENANCE_STATE_URL` and answers
every non-read-only request to `api.kortix.com` with a 503 carrying that
config's `message`. So one failed network call locked production writes, and
users got `ApiError: Kortix is temporarily unavailable. Service will resume
automatically.` — the string that only that fallback produces. Nobody had
touched the admin toggle. **The rule:** an unknown state is `none`. Distinguish
"the store says nothing" (normal operation) from "the read failed" (serve the
last value actually read, else normal operation). A lockdown that must survive
the flag store being down belongs in the consumer as an explicit override
(`MAINTENANCE_LEVEL_OVERRIDE` on the worker), never as a failure default.
Commit 005fd6a4c9 fixed three of these paths on 2026-08-02 and missed the
fourth and fifth — when you flip one fail-closed path, grep for every producer
of the same message. *Incident:* prod, Better Stack `Kortix Frontend`: 1,000+
`ApiError` occurrences over ~2 days; the client-side twin
(`automaticMaintenanceConfig()`) additionally navigated users off a healthy app
to `/maintenance` on one failed poll. Enforcement:
`maintenance-store.test.ts` edge-gate cases, `maintenance-client.test.ts`
"stays out of maintenance after a status request failure".

### A runtime that only updates by pulling never updates a box that predates the puller (2026-09-01)

**When:** designing or relying on any "the box converges on the API" mechanism
(runtime-assets, daemon self-update). A daemon built before the pull code
exists never pulls; restart/resume keep the VM and warm-fork keeps the disk, so
every box from before the cutover is a fossil until the CONTROL PLANE reaches
into it through the provider's own exec channel. Ship the push path with the
pull path, and probe the fleet for boxes whose `/kortix/health` has no `runtime`
block. *Incident:* OpenCode's 48-bit message-id rollover (2026-08-14) silently
broke every pre-wrap session on OpenCode < 1.18.15; the fix (1.18.15) never
reached July boxes — 9 prod sessions dead 19 days, 4 h 15 m zombie turns.
*Automation:* `legacy-runtime-bootstrap.ts` scheduled from `box-reaper` (PR #7088);
`scripts/legacy-runtime-sweep.ts --dry-run` lists what is still legacy.

### Verify "converged" by what is RUNNING, not by what was installed (2026-09-01)

**When:** any install-then-restart flow. The daemon memoised its OpenCode binary
path at boot, installed 1.18.23, restarted — and kept spawning 1.17.11. The
install log said success; `readlink /proc/<pid>/exe` said otherwise.
*Automation:* `restart()` drops the memoised path (opencode.ts); the bootstrap
relaunches once more after an `updated` boot pass and its health wait requires a
FRESH daemon (`uptime_s` small), never the one just killed.

### Pin every bundled Go binary to the scanner's fixed dependency floor (2026-09-01)

**When:** you add or update a Go binary copied into `apps/api/Dockerfile`, or a
root dependency installed by its `--filter kortix --prod=false` layer. The
production image contains both. Pin each binary's module graph to Trivy's fixed
version, then scan the complete `linux/amd64` image.

*Incident:* Deploy Dev run `33501907712`, job `99838193732`, failed on
`CVE-2026-56854`. Caddy contained `x/crypto v0.53.0`; Supabase CLI contained
`v0.54.0`. Both were below the fixed `v0.55.0`.
*Enforcer:* `apps/kortix-app-runtime/build_test.go`,
`scripts/worktree/__tests__/contract.test.ts`, and the Deploy Dev Trivy gate.

### A proxied WebSocket that carries idle traffic needs a keepalive YOU send (2026-08-30)

**When:** you proxy a WebSocket through `apps/api` (the PTY terminal, an app
preview socket, anything on `/v1/p/.../connect`). Every hop between the API and a
sandbox drops a connection with no bytes on it, and a terminal is idle by nature
— a shell at its prompt emits nothing and a reader types nothing. Measured on a
real Platinum box, the API->sandbox leg dies at **exactly 60 s** of silence.

`websocket.idleTimeout: 0` on both Bun servers does NOT cover this: it governs
neither the provider edge nor the API's own upstream client. And on a PTY you
cannot keep the leg busy with data — an upstream byte is typed into the user's
shell, a downstream byte is printed into their terminal. **Send a PING control
frame on BOTH legs, well under the shortest hop timeout, and clear the interval
on every close path** (`PREVIEW_WS_KEEPALIVE_MS`, `pingPreviewWsLegs`).

**Diagnosing a WS that dies on a timer:** a browser reports every drop as `1006`
with no detail, so instrument from a Bun client instead and run three arms on ONE
sandbox in ONE minute — no keepalive, PING, DATA. A ping terminates at the API,
so `PING dies / DATA survives` proves the cut is on the UPSTREAM leg; the reverse
proves it is on the client leg. Guessing at ALB/Cloudflare timeouts from the
outside is how this stayed unexplained.

*Incident:* PR #7062. Terminals reconnected once a minute on dev, staging AND
prod ("not connecting anymore, basically EVERY time"), rendered as
`Reconnecting in Ns (code 1006)`. Root cause reproduced on the LOCAL stack with
no Cloudflare and no ALB in the path, which is what ruled out the edge.
*Enforcer:* `apps/api/src/sandbox-proxy/ws-proxy-keepalive.test.ts` pins that both
legs are pinged, that one leg throwing does not skip the other, and that the
interval clears the measured 60 s cut twice over. There is still NO end-to-end
coverage of the PTY WebSocket in `tests/` — `grep -rn "kortix/pty" tests/` was
empty before this incident, which is why a socket that died every 60 s on every
environment shipped unnoticed.

### A floor that refuses a DEBIT stops the bookkeeping, not the spending (2026-09-01)

**When:** writing anything that moves money after work has been performed —
a usage settlement, a metering debit, a post-hoc reconciliation. Two different
questions were being answered by one function:

  ADMISSION  — "may this account START work?"   strict floor, never negative
  SETTLEMENT — "record work already DONE"       must always succeed

`atomic_use_credits` refuses any debit that would go below zero. Correct for
admission; for settlement it deletes the RECORD of spend that already happened,
because refusing it does not un-spend the money. Compounded by
`subscriptionBypassesWalletFloor`, which exempted any paying per-seat /
credit-plan / paid-tier account from the floor entirely — added to fix a COPY
bug ("Your team isn't on a plan yet" shown to a paying Team account), by
removing metering instead of fixing the words.

Measured on one 6-seat account: `grantForSeats(6)` = $150/mo included usage,
wallet $0.00, `credit_ledger` $588.81, and the gate admitting every create /
start / wake / prompt / gateway call. Past $0 every debit returned
`success:false`, no ledger row was written, and "Spent this period" — which
SUMs `credit_ledger` — silently froze while compute kept burning.

**Rules.** (1) Never let a balance floor gate a settlement; overdraft instead,
and let the NEXT admission refuse — recording the debt blocks the account
harder than losing it did. (2) A failed settlement is unrecorded revenue: log
it at `error` with the account, never `warn`, and never `.catch(() => {})`.
(3) Fixing wrong COPY by widening a spend permission is never the smaller
change. (4) Any client surface that turns a balance into a decision must read
the state machine, not the number — `billing-gate-state.ts` had carried a
docblock naming that exact defect ("the sidebar keyed off the raw balance")
since PR #5141 and it shipped again anyway, because prose enforces nothing.

**Diagnostic:** a wallet at exactly $0.00 on an account that plainly still
works is this. Confirm by summing `credit_ledger` for the period against the
account's grant: if spend exceeds the grant and the balance is pinned at zero,
the ledger stopped recording rather than the account stopping.

*Incident:* no outage; revenue under-collected and finance reporting blind for
one billing period on every drained per-seat account. Fixed in PR #7080.
*Enforcer:* `billing-source-rules.test.ts` (three source-level tripwires: no
balance-to-number decisions outside the decision layer, no billing prose in
components, the bypass stays deleted on both sides of the wire);
`billing-state.test.ts` sweeps every Stripe status x plan class against the
universal floor; `settle-credits.test.ts` pins the settlement contract.

### Keep lazy optional dependencies type-lazy across shared-source imports (2026-08-28)

**When:** a package imports source files from another package without installing
that package's runtime dependencies. Do not use a static type import for an
optional dependency. Define the required structural type locally, and keep the
runtime import behind the existing lazy boundary.
*Near-miss:* staging promotion PR #7027 failed because the sandbox agent typecheck
resolved the worker's `import('ws')` type without installing worker dependencies.
*Enforcer:* the Sandbox Agent CI job runs `bun run typecheck` before its build.

### `deploy-preview.yml` runs from the DEFAULT BRANCH, so everything it references must be on main (2026-08-28)

**When:** adding anything the preview deploy touches — a file under `tests/`, a
Cloudflare worker under `infra/cloudflare/workers/`, a script it shells out to —
while developing on a feature branch. The workflow is `pull_request_target`, and
its deploy and teardown jobs check out
`${{ github.event.repository.default_branch }}`, NOT the pull request head. The
PR's own code is only ever built into the images; the ORCHESTRATION is main's.

Hit twice in one afternoon. First the branch-environment machinery
(`previewSandboxIdentity`, sandbox reuse, the Caddy reload) lived only on the
feature branch, so the label flow could not have used it. Then the `pi-router`
worker did, and the deploy failed with
`infra/cloudflare/workers/pi-router/wrangler.toml does not exist` — the file was
right there in the branch being deployed, and irrelevant.

**The rule: if the preview WORKFLOW reads it, it ships to main first** — as its
own PR, ahead of the feature that needs it. A feature branch may only contribute
images.

**Diagnostic:** a preview step that cannot find a file which plainly exists on
your branch is this, every time. `git ls-tree -r --name-only origin/main -- <path>`
settles it in one command.
*Near-miss:* PR #7019. The guard failed loudly with the exact path rather than
proceeding, which is why it cost one run and not an afternoon.
*Enforcer:* none for the general case. Each referenced path needs its own
existence check in the step that uses it, the way the worker step now has one.

### `compose up -d` does not restart a container because a bind-mounted FILE changed (2026-08-28)

**When:** a redeploy rewrites a config file that a container reads through a
bind mount — a Caddyfile, an nginx conf, a prometheus.yml. Compose recreates a
container for a new image, env var, port or volume DEFINITION; new bytes inside
an already-mounted file are not part of that comparison. If the process does not
watch its config either (Caddy does not), the container keeps serving what it
loaded when it first booted, for as long as the box lives.

A per-PR preview never showed this because it is deleted and recreated on every
push. It appeared the first time a REUSED environment's config actually changed:
moving the branch environment to `pi.kortix.com` rewrote the Caddyfile's pinned
`X-Forwarded-Host`, the file said the new host both on disk and inside the
container, and the running Caddy still pinned the old one — so every Server
Action died with React #441 again (see the entry below).

**The rule: after writing a mounted config, reload the process that reads it**
(`compose exec -T <svc> caddy reload --config …`), or recreate that service
explicitly. Never infer from "compose up succeeded" that a mounted config took
effect.

**Diagnostic:** compare the file with the process's LIVE configuration, not with
the file inside the container — those two agree even when the bug is present.
For Caddy, `curl localhost:2019/config/` from inside the container; the same
shape of check applies to any config-reloading daemon.
*Near-miss:* the pi branch environment, 2026-08-28. Caught within minutes by
driving the real sign-in page; nothing deployed was affected.
*Enforcer:* `tests/unit/sandbox-preview.test.ts` asserts the bootstrap issues
the reload. Nothing detects a NEW mounted config file that lacks one.

### An environment that shares ONE origin between frontend and API must enumerate every path the API serves outside the common prefix (2026-08-27)

**When:** editing the preview edge (`buildPreviewCaddyfile`), or mounting a
route in `apps/api/src/index.ts` anywhere other than under `/v1`.
Deployed environments give the API a host of its own, so every path it serves
reaches it and prefix questions never arise. A preview shares one origin with
the frontend and splits by prefix, and the `@api` matcher listed only `/v1*`.
So `/health`, `/health/live`, `/health/ready`, `/metrics`, `/scim/v2/*`,
`/internal/*` and `/.well-known/oauth-authorization-server` went to
`frontend:3000`, which answered `307 -> /auth?redirect=…`. 13 flows failed on
it (SYS-1/8/9, SCIM-1..5, GW-1/8/10/12, SEC-J), each reading as an auth or
availability bug rather than a routing one.

**The rule: a new non-`/v1` mount is TWO edits** — the route and the preview
matcher — and the matcher carries a comment saying so. More generally, an
environment whose topology differs from dev (one origin instead of two hosts)
does not inherit dev's routing for free; enumerate what the difference hides.

**Diagnostic:** a `307` to `/auth` on a path that needs no auth is the frontend
answering, not the API. `curl -o /dev/null -w '%{http_code} %{redirect_url}'`
tells them apart in one call — the API returns the endpoint's own status
(`200`/`401`), never a redirect to a login page.
*Near-miss:* PR #7012, found while verifying preview↔dev parity. Preview only;
no deployed environment is affected, because none of them share an origin.
*Enforcer:* `tests/unit/preview-stack.test.ts` asserts each of the six paths is
present in the `@api` line. Nothing yet fails when a NEW non-`/v1` mount is
added to the API without updating the matcher — that check is the TODO.

### A reverse proxy in front of Next.js owns `x-forwarded-host`, or every Server Action dies (2026-08-27)

**When:** putting any proxy/ingress in front of a Next.js app — a preview edge,
a sandbox ingress, a tunnel. Next's Server Action CSRF guard compares
`x-forwarded-host` against `origin` and aborts when they differ:
`Invalid Server Actions request`, HTTP 500, surfaced in the browser only as
**minified React error #441**. It kills EVERY Server Action, not just the one
in front of you — on the preview stack that meant nobody could sign in at all,
because the whole auth flow is Server Actions.

The mismatch is easy to create and invisible from the client: the sandbox
ingress set `x-forwarded-host` to the INTERNAL host (`*.aec.local`) while the
browser's `origin` was the public `*.sbx.platinum.dev`. Nothing in the app is
wrong, and no application log says so — the error text lives in the **Next
server's** own stdout, reachable only from the container
(`docker logs <frontend>`), never from the response, which carries an opaque
`digest`.

**Rules.** (1) A proxy that terminates the public hostname must pin
`X-Forwarded-Host` (and `X-Forwarded-Proto`) to the PUBLIC host on the Next
upstream — the API/Supabase/static handles neither need it nor should get it.
(2) A minified React error with no stack is a SERVER error: read the server's
own log before reading any client code. (3) `digest` is a hash, not a message —
grep the container for it.

*Incident:* every `preview`-labelled PR was impossible to sign into; the whole
environment read as "the app is broken". Fixed by pinning the host in
`buildPreviewCaddyfile`.
*Enforcer:* `tests/unit/preview-stack.test.ts` — "pins the PUBLIC host on the
Next upstream for Server Actions".

### An experiment flag that deploy-dev pins to an explicit `false` can never double as a kill switch (2026-08-27)

**When:** reusing an existing feature/experiment flag to gate a new default-on
behaviour with "unset = on, explicit `false` = off" semantics.
`deploy-dev.yml` injects `KORTIX_FAST_COLD_BOOT_ENABLED=false` into the API
task on EVERY push deploy (`.github/workflows/deploy-dev.yml`, the
`enable_fast_cold_boot` dispatch input), so on dev that flag is always
"explicitly false" even though `apps/api/.env*` leave it unset. PR #6964 gated
the fresh-session git hint (`KORTIX_BASE_SHA` + scaffold delta + OpenCode
config-dir hint) on that reading; dev sessions got `KORTIX_SESSION_FRESH=1`
only and still fetched `main` through the proxy (3.0–3.4 s instead of 0.2 s).
`provision-core.ts` had the same gate on its seed-time hint for weeks.

**The rule: a new default-on path gets its OWN flag** (#6973:
`KORTIX_FAST_GIT_BOOT_ENABLED`, `optBoolTrue`), and before choosing
"explicit false = off" semantics on any flag, grep the deploy workflows and
`infra/scripts/ecs-deploy.sh` for who sets it — `.env` files are not the only
source of the task environment.

**Diagnostic:** the daemon env inside a box (`env | grep KORTIX_` via
`POST <sandbox_url>/kortix/pty`) and `projects.metadata->'git'->'fast_boot'`
staying `null` after a session: the API never even attempted the hint.
*Near-miss:* #6964 → #6973, one wasted deploy cycle.
*Enforcer:* none. A config test that asserts every `optBoolUnset`-style
"configured?" gate is not also set by `deploy-*.yml` would catch it.

### A new import edge into a widely-mocked graph breaks hand-written module mocks all over the suite — and the failure names no test (2026-08-27)

**When:** adding an import to code that many suites exercise (a middleware, a
proxy, a gate). `mock.module` replaces a module **WHOLESALE**, so every suite
that stubs a module by listing its exports silently deletes the ones it did not
name. Pull that module into a new part of the graph and those missing names
become `SyntaxError: Export named 'X' not found in module …`, printed as
`# Unhandled error between tests` — attributed to NO test, and it takes an
unrelated parallel worker down with it, so the visible symptom is a stranger's
suite failing.

Fix them one at a time and it cascades: `loadTokenBinding` →
`ensureAgentServiceAccount` → `createAccountToken` →
`resolveInheritedSessionSharing`, each spread pulling the next real module in.

**The rule: fix the import, not the mocks.** Ask what the new code actually
needs. Here the Apps gate wanted one email lookup and reached it through
`projects/lib/access`, which re-exports it from behind the whole
project/session/IAM read graph; `accounts/core/owner-emails` is the same
function with `drizzle` + `db` as its entire import list. One line, cascade
gone, zero test churn. Spread the real module (the 2026-08-18 rule) when you
own the mock and the dependency is genuinely needed — not as the way out of a
cascade you created.

**Diagnostic:** a suite that fails with `1 fail / 1 error` where the failing
test is in a file your branch never touched, and the run prints `1 tests
failed:` followed by nothing, is this. Read the `Unhandled error` block, not the
failing test name.
*Near-miss:* PR #6963 (the Apps viewer token). Cost two CI rounds and a wrong
"it's a pre-existing flake" call before the real cause was read.
*Recurrence, same day:* `d990e122aa` added `ensurePiWorkerImage` to the static
import from `snapshots/builder` in `platform/services/session-sandbox.ts`. The
module edge already existed — only the NAME was new — and that was enough: all
eleven suites that stub `snapshots/builder` by listing its exports died at
import. It reddened the packages lane on two unrelated PRs (#6978, and #6957 on
different tests) before anyone read the cause. Fixed in #6982 by deferring that
one name to a dynamic import at its single call site: zero mock churn.
**It does not reproduce locally** — the full `apps/api` suite passes 8745/0 both
with and without the fix. Only CI's worker count and interleaving surface it, so
"it passes on my machine" proves nothing about this class. Read the CI
`Unhandled error` block.
*Enforcer:* none. A lint that flags `mock.module` factories which do not spread
the real module would catch the mocks; nothing catches the import edge. Worth
building — this rule has now been paid for twice in one day.

### Two migrations generated from the same parent fork the drizzle chain, and main then cannot generate ANY migration (2026-08-27)

**When:** two PRs are open at once and each runs `pnpm migrate:generate`. Each
snapshot records `prevId` = whatever the tail was when it was cut. Merge both
and `drizzle/meta/` has two snapshots claiming the same parent; the next
generate anywhere on main dies with
`[a_snapshot.json, b_snapshot.json] are pointing to a parent snapshot: … which
is a collision` — and the wrapper still prints the reassuring
`No schema changes detected` line (same lie as the 2026-08-19 TTY entry), so it
reads as "nothing to do" rather than "the repo is wedged".

The second snapshot is also WRONG on content, not just on lineage: it was
diffed against the older parent, so it is missing whatever the other PR added
(here `accounts.branding`, from #6947, absent from #6953's snapshot).

**The repair** (metadata only — no applied migration file is touched, so
immutability holds): in the LATER snapshot set `prevId` to the earlier
snapshot's `id`, and copy in the objects the earlier one added. Then generate
and READ THE SQL: it must contain only your own change. If it re-proposes the
other PR's DDL, the content merge was incomplete.

**The prevention:** regenerate your migration against the current tail
immediately before merging (rebase → delete your snapshot + journal entry →
`migrate:generate` again), the same way a lockfile is refreshed.
*Incident:* main was un-generatable between #6947/#6953 merging (2026-08-26
21:26Z) and the repair on the `app-viewer-token` branch. No deploy was affected
— both migrations applied fine; only generation was blocked.
*Enforcer:* none — a CI check that asserts one linear `prevId` chain over
`drizzle/meta/*_snapshot.json` is the TODO.

### A web API the middleware needs must exist in the IMAGE's runtime, not the laptop's (2026-08-27)

**When:** adding any global middleware or hot-path code that uses a Web/Bun
API (`CompressionStream`, `DecompressionStream`, `ReadableStream.from`,
`Response.json`, …), or bumping/pinning Bun anywhere. `apps/api/Dockerfile`
pins `ARG BUN_VERSION=1.2` (1.2.23 today) while every developer laptop and
every CI lane runs Bun 1.3.x. `CompressionStream` does not exist in Bun 1.2.
The compress middleware from #6946 peeked the body of every eligible response
and then threw `ReferenceError: CompressionStream is not defined`, so on dev
**every API response ≥ 1 KiB answered 500** (`GET /accounts`, `account-state`,
`iam/permissions`, `iam/roles` — the whole account hub) while sub-KiB routes
and `/health` stayed green. 8,545 green unit tests, a green typecheck and a green
deploy proved nothing, because none of them ran on the image's Bun. Cloudflare
sends `Accept-Encoding: gzip` to the origin regardless of the client, so no
request could dodge the path.
**Rules:** (1) feature-detect any Web API a middleware uses at module load and
fail OPEN (skip the feature, never touch the body) when it is absent; (2) treat
`BUN_VERSION` in the Dockerfile as the runtime contract — either pin the
laptop/CI to it or add a test that runs the middleware under
`oven/bun:<BUN_VERSION>`; (3) a green `/health` after deploy is not a smoke
test — hit one route whose response exceeds 1 KiB.
*Incident:* dev broken 2026-08-26 22:41 → 2026-08-27 (fix in progress) — first
noticed only because the branding rollout verification hit `GET /accounts`.
*Enforcer:* `compress.test.ts` pins the fail-open path with `CompressionStream`
deleted from `globalThis`; nothing yet runs the suite under the image's Bun.

### A React effect keyed on a provider-issued object must cache its work by id, never bail — and only the deployed page proves it (2026-08-26)

**When:** an effect does one-shot async work (a consent read + approve, an
exchange, anything consumed server-side) and its deps include an object the
auth/data provider re-issues (`user`, `session`). The re-run cancels run #1
via cleanup; a "started already" guard then makes run #2 bail, and the page
holds its loading state forever. Cache the PROMISE per id and let whichever
run is current apply it; a redirect after a consumed request fires
unconditionally.
*Incident:* Sign in with Kortix consent page (#6945) spun forever on
dev.kortix.com for a fresh client while `/v1/oauth/authorize/consent/:id`
answered 200; local Chromium never re-issued `user` in that window, so the
local run passed. Fixed in #6949 the same evening; dev only.
*Enforcer:* none — the rule is: drive the deployed page for any auth flow.

### The dev edge WAF 403s any query string carrying a bare `localhost` / `127.0.0.1` host (2026-08-26)

**When:** pointing a locally-running app at `dev-api.kortix.com` with a
`redirect_uri`, `callback`, or `return_to` on `localhost`. Cloudflare answers
403 before the API sees the request (cf-ray, no `x-kortix-*` headers). Use a
`*.localhost` name (`demo.localhost:8792` — browsers resolve it to loopback
and the OAuth registry accepts the suffix).
*Near-miss:* the dev sign-in demo hit 403 on `/v1/oauth/authorize`; read as an
API regression until curl with `app.example.test` returned the API's own 400.
*Enforcer:* none — docs note in `/docs/sdk/sign-in` is the TODO.

### `github-release` needs the npm publishes, so an npm-publish failure silently strips the tag, Release, changelog, and VERSION sync from a shipped prod deploy (2026-08-26)

**When:** touching `scripts/publish-npm-package.sh`, the deploy-prod publish
jobs, or diagnosing a deploy-prod run that went `failure` while
`api.kortix.com` correctly serves the new version.
`deploy-prod.yml`'s `github-release` job `needs: […, publish-sdk,
publish-agent-tunnel, …]` with the default `if: success()`. `deploy-ecs` does
NOT depend on the publishes, so the SERVICE rolls fine — but if any npm
publish fails, `github-release` (tag + GitHub Release + release notes) and the
`sync-main-version` / `sync-staging-version` / `announce` / `attach-desktop`
jobs are all SKIPPED. The result: prod serves the release, and there is no
tag, no Release, no changelog, no VERSION bump — an invisibly half-finished
release. v0.13.6 hit this: `publish-npm-package.sh` ran `npm install -g
npm@latest`, which is now `npm@12.0.2` requiring node `>=22.22.2`, while
`actions/setup-node@22` provisions `22.22.0` → `EBADENGINE`, failing
`publish-llm-catalog` + `publish-agent-tunnel` (and skipping `publish-sdk`,
which needs `publish-llm-catalog`). Same node-floor class as the
`pnpm/action-setup@v6` gate breaker the same day.
Rules: (1) after any deploy-prod that reports `failure`, verify BY HAND that
the tag, GitHub Release, and main/staging VERSION advanced — a green
`/health` is not proof the release finished; recover a skipped `github-release`
manually (`gh release create <tag> --target <prod-sha> --title … --notes-file
RELEASE_NOTES.md`, attach the run's `cli-binaries`, then bump VERSION on both
branches). (2) Pin publish tooling to a floor the runner's node satisfies
(`npm@^11.5.1`, not `@latest`). (3) Better structurally: `github-release`
should not hard-depend on the npm publishes — an npm outage should not erase
the release record; make the publish jobs `continue-on-error` or drop them
from `github-release.needs`.
*Incident:* v0.13.6 deploy-prod run 33009428048 — service live on 0.13.6, but
tag/Release/changelog/VERSION-sync skipped; recovered by hand. Script fix in
#6940; the `needs`-decoupling is still a TODO.
*Enforcer:* none — the decoupling and a post-deploy "release artifacts exist"
check are the TODOs.

### A guard that has never fired has never been tested; and an artifact upload path is a publish path (2026-08-26)

**When:** writing any secret guard in CI (`if grep …; then exit 1`), or
uploading a directory as a workflow artifact on a public repository.
Two facts, one incident. (1) The "Guard test artifacts against secrets" step
in `tests-release.yml` invoked `rg` under `2>/dev/null`; GitHub's ubuntu
images do not ship `rg`, so from its first run (2026-08-19) until the
Blacksmith move (2026-08-25, `grep`) it passed on nothing, every time. A
guard is only evidence after it has been SEEN to fail on a planted value —
plant one in a dry run before trusting it. (2) The moment it ran for real it
found `tests/test-results/deployment-bypass-state.json`: the Playwright
storage state from #6632's bypass exchange, holding the live `_vercel_jwt`
cookie for `staging.kortix.com` (HS256, `aud: staging.kortix.com`, 7-day
expiry). `tests/test-results/**` is uploaded verbatim by every deployed
browser job, and `kortix-ai/suna` is public — so every release-gate run from
2026-08-20 to 2026-08-26 published a valid deployment-protection bypass
cookie; 78 unexpired `tests-release-browser-shard-*` artifacts held one.
Rules: never write a credential-bearing file under a directory that any
workflow uploads (`tests/.state/` now; `web-ecs-workflow.test.ts` pins the
helper path AND a by-name exclusion on all four `tests/test-results/**`
uploads); treat `path: <dir>/**` as "publish everything here"; and when a
new guard first goes red, assume it is telling the truth before assuming it
is noise. Fixed in #6933/#6934; artifacts deleted by hand the same day.
*Incident:* v0.13.6 gate run 32998656515 — all 3 browser shards failed on
the guard after their journeys had passed. No known exploitation; the
cookies themselves cannot be revoked by us — rotating the Vercel
"Protection Bypass for Automation" secret is the operator follow-up.
*Enforcer:* the unit pin above + the (now real) artifact guard.

### A release-gate flow is added or un-quarantined only in the PR that carries its green deployed run (2026-08-26)

**When:** adding a flow with `requires: ['daytona']` (it never runs in local
CI), or deleting a `quarantine:` field. Local lanes skip these flows, so a
green PR proves nothing about them; the first time they execute is the next
production release gate. Two did exactly that in v0.13.6 (gate run
32992496089): SESS-23, un-quarantined in `09aa887a55` with a comment saying
the wake path "must prove the contract on every run", failed on the first run
with the SAME stop→wake 503 its old quarantine text described; CONN-26, a
new real-LLM flow (`gpt-5.6-luna` must call `add_connector` within 300 s),
added in `5b070ebb18` by direct push, timed out at 392 s and left no
transcript. Each cost a staging hotfix + rebuild + redeploy (~25 min) inside
the release, on top of a GitHub Actions outage.
Rules: (1) the PR that adds or un-quarantines a deployed-only flow links a
green `tests-release.yml` dry run (`gh workflow run tests-release.yml --ref
staging -f expected_sha=<sha>`) — no link, no merge; (2) an LLM-behaviour
flow captures the transcript on timeout, or it cannot be diagnosed from CI;
(3) a `quarantine:` text is a claim about the product — re-quarantine with the
new evidence rather than arguing with the old text. Re-quarantined in
#6927/#6928 (SESS-23) and #6929/#6930 (CONN-26).
*Enforcer:* none — a check that a PR touching `quarantine:` or a
`requires: [... 'daytona']` flow links a tests-release run is the TODO.

### A runner migration re-tests every setup action; one job on a different major is a latent break (2026-08-26)

**When:** moving a workflow to a different runner image (Blacksmith), or
bumping a setup action (`pnpm/action-setup`, `setup-node`) in ONE job of a
multi-job workflow. `tests-release.yml` ran `pnpm/action-setup@v4` in three
jobs and `@v6` in the `deployed browser shard` only (dependabot #6343 bumped
one). On GitHub's `ubuntu-latest` no pnpm is preinstalled, so both majors
behaved the same and the v0.13.5 gate was green. The Blacksmith image ships
pnpm v11.19.0 at `PNPM_HOME`; `@v6`'s self-installer took its "Switching pnpm
from v11.19.0 to v8.11.0" path, warned `Failed to create bin ... @pnpm/exe ...
ENOENT`, and left a standalone `@pnpm/exe` on PATH. That binary runs on its
own bundled Node (18.5.0), so `pnpm install --frozen-lockfile` failed
`engine-strict` against `eslint@9.39.4` (`Got: v18.5.0`) although
`setup-node` had put 22.22.0 on PATH one step earlier. All three browser
shards of the v0.13.6 gate died in ~60 s; the api shards on the SAME runner
label passed on `@v4`.
Rules: (1) every job in a workflow uses one major of each setup action — a
dependabot bump that touches one `uses:` line of four is a review reject;
(2) after a runner-image migration, run the release gate as a dry run
(`gh workflow run tests-release.yml --ref staging -f expected_sha=<sha>`)
BEFORE the next promote — Blacksmith (#6906) moved the gate on 2026-08-25 and
the first real run was the release; (3) a whole-shard failure in well under
the usual runtime is a setup failure — read the install step, not the tests
(same class as the 2026-08-18 lockfile entry).
*Incident:* v0.13.6 release PR #6923, gate run 32992496089; fixed by #6925 /
#6926 (pin `@v4`); ~1 h of release delay on top of the GitHub Actions outage.
*Enforcer:* none — a lint that every `pnpm/action-setup@` in a workflow file
shares one major is the TODO.


### A row lock held to COMMIT makes batch size a blast radius, and a 500 turns backpressure into a livelock (2026-08-26)

**When:** writing anything that inserts into `kortix.audit_events`, sizing an
audit batch, or triaging `insert into "kortix"."audit_events"` blocking another
one in `pg_stat_activity`.
`kortix.audit_prepare_event` allocates the per-session sequence and hash-chain
head from `kortix.audit_session_sequences`; PostgreSQL holds that row lock until
the inserting transaction COMMITs. So the lock is held for the WHOLE statement,
not the allocation: one 200-row ingest pinned a session for its full duration and
one 100-row queue flush built in arrival order pinned up to 100 sessions at once.
Rules: (1) one statement never spans two sessions; (2) chunk a batch so the lock
is held per chunk and committed chunks survive a later failure; (3) give the
audit pool a `lock_timeout` far below its `statement_timeout` — a lock wait is
not work; (4) report contention (57014/55P03/40001/40P01) as a retryable 503 with
`Retry-After`, never a 500, and back the client off exponentially.
*Incident:* Essentia self-host 2026-08-26 — `POST …/audit/events` returned
500 [57014] 445 times in 3h, each at ~10s, while the sandbox relay's flat 1s
retry re-entered the same lock queue and kept the convoy alive. Predecessor:
PR #6702's dedicated audit pool isolated the damage but did not remove it.
*Enforcer:* `statementBatches` + its tests (`apps/api/src/shared/audit-queue.ts`),
`isAuditContentionError` tests (`apps/api/src/shared/audit-db.test.ts`), the
per-session lock-scope integration test in
`packages/db/scripts/centralized-audit-v2.integration.test.ts`.

### A CI lane that runs inside a third-party sandbox inherits that provider's availability, and a fallback nobody exercises is not a fallback (2026-08-26)

**When:** deciding where a test lane executes, or adding a provider fallback
to any CI path. The PR gate ran each lane inside a Platinum sandbox with
`auto` fallback to Daytona. On 2026-08-25 Platinum restores timed out for ~an
hour; every lane that fell back landed on a Daytona guest whose kernel
(6.18.15) could not mount overlay2, so `dockerd` never started and the lane
exited 3 — on runs 32905168237, 32906337979, 32908378870 and all three
attempts of 32909110032. The fallback had never been exercised under load;
it added a second provider's failure modes instead of removing the first's.
The runner (8 vCPU / 32 GB, Docker, cached pnpm store and Docker images)
could run the lane itself: core 2m16s and browser 4m30s natively versus ~5 min
each through the sandbox. Rule: **run a lane on the runner unless the lane
needs something the runner cannot provide (a public origin, a specific
kernel, GPU); if a lane must use a provider, rehearse the fallback path
weekly or delete it.** PR #6906 removed the sandbox-worker path for the PR
gate; `deploy-preview.yml` keeps a sandbox only because a preview needs a
public HTTPS origin.
*Enforcer:* `tests/unit/sandbox-workflow.test.ts` "has no cloud-sandbox
worker path left" fails if `tests.yml` or `tests-pr.yml` names a provider
again.

### A guard that tolerates its own tool being absent guards nothing (2026-08-25)

**When:** writing any CI step of the form `if <tool> <pattern> … 2>/dev/null; then fail`.
If the tool is missing, the command fails, `2>/dev/null` hides why, the `if` reads
false, and the step prints its success line. Use a tool every runner image ships
(`grep`), or probe for it (`command -v rg || exit 2`) BEFORE the check; and pin
the pattern in one place the producer also uses (`GUARD_PATTERN_SOURCE` in
`tests/src/core/scrub.ts`), so the writer scrubs exactly what the guard greps.
*Incident:* `Guard test artifacts against secrets` in tests.yml / tests-release.yml /
tests-browser-nightly.yml called `rg`, which GitHub's ubuntu-24.04 image does not
ship. It reported "No secret-shaped values found." on every run since it was
written. The first Blacksmith run (image ships rg) failed it: 32 secret-shaped
values — 8 `kortix_pat_*`, `kortix_sa_*`, setup-link `{accountId,nonce,exp}`
tokens — inside the 73 MB `results.json` + `report.html` uploaded as PUBLIC
workflow artifacts on every PR (tokens of an ephemeral local stack; the
release gate would have uploaded STAGING tokens the same way). Fixed in the
Blacksmith follow-up PR: write-time shape scrub in `report.ts` (proven 32 → 0
on the real artifact) + grep-based guard.
*Enforcer:* `tests/unit/scrub-secret-shapes.test.ts` — scrubber vs guard
pattern parity, `writeResults` output passes the guard, and every guard step
uses `grep -rEIl "$pattern"` with the shared pattern, never `rg`.

### A runner label is a tested contract, and a third-party runner pool is a deploy dependency (2026-08-25)

**When:** changing any `runs-on` / matrix `runner:` in `.github/workflows/`,
including an auto-generated PR (Blacksmith's Migration Wizard, Dependabot).
Two rules. (1) Run the workflow-pinning unit lane before merging —
`pnpm --dir tests test:unit` — because `tests/unit/*-workflow.test.ts` pin
runner labels, cache directives and step order as source text; a label
rewrite that touches nothing else still turns `main` red. (2) Never commit a
bare runner label. Every Linux `runs-on` is
`${{ vars.CI_RUNNER_<tier> || '<blacksmith label>' }}` so a repository
variable can move a tier back to GitHub-hosted without a PR — a PR cannot fix a
runner outage, its checks need runners. Off-Blacksmith the Docker actions
fall back (cold) instead of failing. Runbook: `docs/runbooks/ci-runners.md`.
*Incident:* PR #6901 (wizard, 125 label rewrites) merged at 22:00 UTC with its
`warm core worker` check red on 3 `image-build-speed-workflow.test.ts`
assertions (`ubuntu-24.04-arm` pinned) and three amd64 matrix legs left on
`ubuntu-latest`; in the following hour Deploy Dev jobs waited 14 s – 6 min in
`queued` for a Blacksmith runner while ≤3 ran. No prod impact.
*Enforcer:* `image-build-speed-workflow.test.ts` "every Linux job keeps the
Blacksmith runner kill switch" rejects any bare label in any workflow.
*Addendum (same day):* a vendor's cache claim is not a measurement. Five
consecutive builds of one `cache-key` on Blacksmith's sticky-disk builder
reused 0 layers (`WORKDIR /app` re-executed) while the registry cache reused
34–45 on the same Dockerfile; `grep -c ' CACHED'` on the build log is the only
proof of a warm build. Keep `cache-from`/`cache-to: type=registry` until a
re-measurement shows the sticky disk hitting (PR #6905).
### A provider handed to the provisioner is a PREFERENCE, not a lock (2026-08-26)

**When:** passing a sandbox provider into `provisionSessionSandbox`, or reading
one back to decide whether failover may run. Only an explicit `body.provider`,
an enabled per-project pin, or a restart on an existing box locks the runtime.
The weighted balancer's pick must stay unlocked, or admin-gated failover is dead
code for every session that never asked for a provider by name. *Incident:*
`platform_settings.provider_fallback` was ON in prod, yet 654 sessions died on a
provider at capacity in one hour with ZERO handoffs recorded in
`session_sandboxes` — `createProjectSession` forwarded the balancer's pick and
the provisioner read any provider as explicit. *Enforcer:*
`apps/api/src/projects/lib/sessions.provider-failover-wiring.test.ts` fails if
either end stops honoring `providerLocked`.

### Jitter every fleet cron; identical manifests share an expression (2026-08-26)

**When:** scheduling any cron a project starter, template, or marketplace clone
ships. Every project that copied the manifest inherits the same expression and
fires on the same millisecond. Offset each trigger deterministically by
`(project_id, slug)` — deterministic because the catalog writes `next_fire_at`
and the claim sweep recomputes it, and a random offset makes them disagree.
*Incident:* 756 projects inherited `0 0 3 * * *`; the 03:00 hour took 779
provisions and failed 654 (346 `capacity`) while every other hour that day ran
100% healthy at 6-28 provisions. *Enforcer:*
`apps/api/src/projects/trigger-schedule.jitter.test.ts` asserts 766 keys spread
across the window instead of stacking.

### Disabling a starter default does not disarm the fleet already built from it (2026-08-26)

**When:** fixing runaway automation by editing `packages/starter/templates/`.
That edit only changes what NEW projects receive. Trigger rows are reconciled
from each project's OWN repo manifest, so every project created while the
default was enabled keeps firing. Ship the template fix AND a remediation for
the existing population in the same change, and say which one you verified.
*Incident:* PR #6806 disabled the 03:00 harness reflector on 2026-08-23 and
reached prod in v0.13.5; three nights later 766 projects still fired it and 654
sessions failed. Growth stopped at the fix; the standing population did not.
*Enforcer:* none — this is a review question, not a lint.

### Size sandbox memory from measured peak RSS, not nominal workload size (2026-08-24)

**When:** assigning a sandbox template to image-heavy, document-heavy, or long-context agents.
Measure the largest runtime process during a representative turn and leave headroom for the
daemon, tools, and filesystem cache. A 4 GiB sandbox with no swap cannot safely run an
OpenCode process at 3.07 GiB anonymous RSS. Bind the agent to a larger ready template before
the next session; changing the default does not migrate existing sessions. *Incident:*
Essentia session `fea31312` lost its active turn when Linux OOM-killed OpenCode after a
141k-token image workflow. *Enforcer:* template and fresh-session slug read-back; no RSS gate.

### A snapshot build stuck in progress silently rolls every later resume back (2026-08-24)

**When:** operating pause/resume sandbox lifecycles where each pause appends a
diff build and resume restores the newest build with a ready status. A build
wedged in `snapshotting` is skipped by resume even when its rootfs upload
completed; the sandbox silently boots the pre-wedge state, and every later
pause then snapshots that stale branch as a new "success" build, burying the
good lineage deeper on each cycle. User data vanishes with zero errors on any
surface — the session opens fast and empty. Repair = finalize the wedged
`env_builds` row (`status='success'`, `finished_at=created_at`), mark the
stale-branch builds `failed`, resume. Verify the rootfs object exists in the
`fc-templates` bucket before finalizing. *Incident:* essentia session
`70f64114` resumed with an empty transcript on 2026-08-24; wedged build
`4b583212` (03:34:23Z, during the wake-race window fixed by `b250949eb1`) had
its full 660 MB rootfs in S3 but the status never flipped; 4 stale builds
stacked on top; a cluster-wide sweep found 71 wedged builds and 11
silent-rollback victim sandboxes. The transcript was recovered by the repair
above. *Enforcer:* none yet — a wedged-build watchdog belongs in the
self-hosted E2B ops (kortix-infra `e2b/ops`), and the sandbox daemon should
detect a restore that is older than Kortix's last-known session activity and
say so instead of serving an empty transcript.

### A stale readiness observer must claim the runtime row before stopping its provider (2026-08-24)

**When:** parking an established runtime after a failed readiness or wake probe.
CAS the exact observed `active` row, including `updated_at`, before closing
compute or calling `provider.stop()`. Never write a stale metadata object after
an external stop. Persist stop intent so a parked-row sweep retries after a
crash. *Incident:* overlapping Essentia `/start` requests paused each new E2B
boot after about 8 seconds and erased its wake fence; OpenCode needed 11.574
seconds. *Enforcer:* runtime-identity and parked-runtime verification tests pin
the CAS and durable retry.

### A response-header timeout must end when actual provider headers arrive (2026-08-24)

**When:** wrapping an AI SDK streaming request with a response-header deadline.
Apply the deadline to the provider `fetch`, then clear it when `fetch` resolves.
Do not use that deadline as the full-stream abort signal; AI SDK returns
synthetic gateway headers before Bedrock `/converse-stream` returns. Keep client
cancellation attached for the full body. *Incident:* Essentia Fable produced 14
zero-token turns at 89-91 seconds, recorded as `200 ok=true`. *Enforcer:* gateway
header/body/cancellation and timeout-classification tests.

### Refuse a release version whose tag already names another commit (2026-08-24)

**When:** resolving a production version before migrations or rollout. Check
`refs/tags/vX.Y.Z` first. Permit no tag, or the current prod commit for a rerun.
Do not trust a release action to move a tag: it can silently reuse the existing
ref and publish correct images under a tag that names unrelated code. *Incident:*
v0.13.5 served source `1eb51c95`, while its reused tag named `98843dc5` until
corrected. *Enforcer:* `deploy-prod.yml` version preflight and workflow unit test.

### Provider traffic credentials need a cross-replica refresh bound (2026-08-24)

**When:** caching a provider handle that carries a private ingress token. Bound
the cache lifetime and refresh it with single-flight connection work. A resume
can rotate the token in one API replica while every other replica retains the
old handle indefinitely. *Incident:* an Essentia E2B guest was locally ready in
12.9 seconds, but `/start` failed because another API replica used its stale
traffic token and received repeated `502 port not ready` responses.
*Enforcer:* E2B ingress rotation and concurrent-refresh tests.

### A deliberate runtime failure park must require explicit restart (2026-08-24)

**When:** returning a stopped sandbox after `runtime_boot_failed` or
`runtime_wake_failed`. Do not classify that row as an ordinary hibernated
sandbox. Automatic `/start` retries can otherwise resume the same broken runtime
and repeat the full readiness timeout forever. *Incident:* an Essentia E2B
session issued consecutive 9.6–10.2 second `/start` calls for over 80 seconds;
the existing 5-minute server window then parked and auto-resumed the same box.
*Enforcer:* API repeated-start and web resumability regression tests.

### Fence provider-status caches against lifecycle mutations (2026-08-24)

**When:** caching a confirmed provider `running` result. Capture a lifecycle
generation before the provider read. Cache the result only if that generation
is unchanged. Invalidate before and after start, stop, and remove operations.
An in-flight status read can otherwise finish after a stop and resurrect stale
`running` state. *Near-miss:* the Essentia `/start` latency optimization added
an E2B cache that could hide a completed pause for 1.5 seconds.
*Enforcer:* `e2b.test.ts` holds `getInfo()` across `stop()` and rejects revival.

### One React Query key needs one poll owner (2026-08-24)

**When:** mounting the same query through several session-page components. Give
exactly one stable route-level observer a `refetchInterval`; make every other
observer a cache reader with `refetchOnMount: false`. In-flight deduplication
does not merge independent timers or late stale mounts. *Incident:* five audit
observers produced 9 requests during one Essentia session load.
*Enforcer:* `session-audit-shared.test.ts` pins one owner and cache-reader mounts.

### Browser idle is not network idle (2026-08-24)

**When:** deferring a large non-critical request. Do not use
`requestIdleCallback` as a first-paint network gate; network waits create idle
main-thread windows immediately. Fetch at the user-demand boundary instead.
*Incident:* an idle callback started the 4.07 MB LLM catalog during every
session open. *Enforcer:* `llm-catalog-demand-loading.test.ts` bans layout boot.

### A successful surface deploy must not inherit skipped unrelated ancestors (2026-08-24)

**When:** chaining Dev deployment, canonical verification, and self-host channel
promotion jobs. Add `always()` and assert the direct prerequisite result for
each post-deploy job. A normal `if:` can inherit a skipped transitive ancestor,
skip verification, and leave the mutable self-host tag on an older image even
after the immutable image deployed successfully.
*Incident:* a Dev frontend deployed a transcript fix, but its DNS verification
and `:dev` promotion skipped. Self-host frontends kept a stale blank transcript.
*Enforcer:* `tests/unit/web-ecs-workflow.test.ts` pins the post-deploy conditions.

### Submit an initial session prompt exactly once (2026-08-23)

**When:** creating a session with `initial_prompt`. Do not submit the same
prompt again after session readiness. Assert one user turn and one assistant
turn through the real CLI process. *Incident:* the CLI created the session with
the prompt, then posted it again and returned HTTP 500 after the first reply.
*Enforcer:* `sessions.test.ts` counts runtime prompt requests for `--new`.

### Resolve a pnpm global package through `pnpm root -g` (2026-08-23)

**When:** validating or linking a binary installed by `pnpm add -g`. Build the
path as `$(pnpm root -g)/<package>`; do not parse `pnpm list --parseable` output.
That output changed shape and made the E2B template fail after a successful
OpenCode install, so new sessions continued using a stale warm template.
*Enforcer:* `apps/sandbox/opencode-warmup.test.ts` pins the Dockerfile command.

### A channel promotion must evaluate after skipped sibling surfaces (2026-08-23)

**When:** adding a dev image promotion job after a conditional multi-surface
deploy graph. Start its condition with `always()`, then require the selected
surface's build and verification jobs to report `success` explicitly.
*Incident:* Deploy Dev run `32654029814` deployed API SHA `a48c31be`, but GitHub
skipped the API `:dev` promotion because unrelated surface ancestors skipped.
A self-host deployment stayed on `3926a01a`. *Enforcer:*
`dev-channel-promotion-workflow.test.ts` covers API, gateway, and frontend.

### A WebSocket upgrade must obey the SAME wake policy as the HTTP path (2026-08-23)

**When:** adding or changing a gate in `resolvePreviewWsUpstream` / `ws-proxy`,
or any policy that answers a sandbox request with 503. A browser cannot see a
refused upgrade — it reports close code `1006` with no status and no reason — so
a gate the WebSocket path applies but the HTTP path does not becomes an
unrecoverable client loop, never an error the user can act on. Mirror the HTTP
resume policy, and log every refused upgrade with its status and path.
*Incident:* the session Terminal reconnected forever against an idle-parked box:
HTTP wakes it on user intent, the WS path had no wake branch at all, and the
panel's own `GET /kortix/pty` never resumes either — so a reload could not fix
it. PR #6792 adds `wake=1` for user-initiated attaches only.
*Enforcer:* `ws-wake-policy.test.ts` pins the marked/unmarked split; the
`[preview-ws] REFUSED` log makes the next one findable in one grep.

### A typed list from a remote endpoint is not a list — normalize it at the SDK seam (2026-08-23)

**When:** adding or touching any `@kortix/sdk` hook that returns a LIST from the
runtime or platform API. Coerce the response with `asRuntimeList` and read the
localStorage placeholder with `cachedRuntimeList`, so a body with an unexpected
shape degrades to "no items" instead of reaching a render that iterates it.
*Incident:* `GET /command` returned a truthy non-array on dev; the session view
crashed into its error boundary with `TypeError: t is not iterable` from
`detectCommandFromText`, and the bad value was cached, so a reload did not clear
it. Fixed by PR #6790. *Enforcer:* `shared.test.ts` covers both helpers; the
guard is only real for hooks that call them — check the call site in review.

### Give reviewed infrastructure rollbacks an explicit delete path (2026-08-23)

**When:** a rollback removes Terraform-managed resources. Keep automatic pushes
delete-safe. Expose a manual `allow_deletes` input, review the exact plan, and
apply the same plan through the guarded workflow. *Incident:* the `kortixd`
rollback planned four relay-only deletes; the dev deploy correctly stopped and
left the stable API image undeployed. *Enforcer:* `terraform-apply.yml` blocks
deletes unless the caller passes `allow_deletes=true`.

### Keep the legacy relay until old sessions pass a real cutover gate (2026-08-23)

**When:** replacing sandbox runtime startup, ingress, or relay ownership.
Do not merge the cutover until one pre-change session passes chat, files, PTY,
idle survival, and stop/start recovery through the browser. A persistent boot
lock must record the boot ID and owner PID, and recover an empty or stale lock.
*Incident:* PRs #6686 and #6773–#6786 moved the relay to `kortixd`; an empty
`/opt/kortix/bootstrap.lock` then blocked every later wake for that node.
*Enforcer:* TODO: add the pre-change-session journey to the browser release gate.

### Keep self-host sandbox gateway URLs aligned with the public proxy route (2026-08-23)

**When:** changing `LLM_GATEWAY_PROXY_TARGET`, Caddy LLM matchers, or sandbox
gateway URL resolution. Test the final public URL through the deployed proxy.
Internal proxy mode does not prove that `/v1/llm-gateway/v1` is public.
*Incident:* self-host sessions received Caddy `404` because Compose selected that
internal prefix while Caddy exposed `/v1/llm` directly to the gateway.
*Enforcer:* `compose-assets.test.ts` pins `LLM_GATEWAY_BASE_URL` to the public
`${KORTIX_URL}/v1/llm` route.

### Webhook signing secrets must use connector delivery (2026-08-23)

**When:** creating, updating, or diagnosing a webhook trigger. A stored secret
is not sufficient. Its delivery policy must authorize the `connector` consumer:
use `broker` strategy with `connector` consumer, then rotate after narrowing a
secret that previously reached a sandbox. Reject invalid policy during trigger
create/update, and return distinct runtime codes for missing, inactive, and
delivery-mismatched secrets. *Incident:* production `test-webhook` returned 409
because `SECRET` existed with `runtime`/`sandbox` delivery; the same manifest
also named an undeclared agent. *Enforcer:* `e2e-project-triggers.test.ts` and
`secret-consumer-access.test.ts`.

### Assert monotonic timestamps when later writes can advance one field (2026-08-22)

**When:** a test reads two timestamps written by one statement after asynchronous
lifecycle work starts. Require the invariant's monotonic order. Do not require
equality when later writes can advance one field before read-back. *Near-miss:*
release gate run 32598056475 failed `SESS-18` after `updated_at` advanced 223 ms
past `last_activity_at`. *Enforcer:* `SESS-18` requires
`last_activity_at > created_at` and `updated_at >= last_activity_at`.

### A sandbox environment carries one credential, not a boot protocol (2026-08-22)

**When:** provisioning a session or adding daemon boot data. Inject only the
session-bound `KORTIX_TOKEN`. The daemon must claim prompts and lifecycle
identifiers from the API with that token. Connector, provider, prompt, and
turn-ledger values must not enter the VM environment. *Incident:* an Essentia
`env` dump exposed connector credentials and four Kortix aliases; a real
Platinum probe then found the initial-turn nonce still inherited by OpenCode.
*Enforcer:* runtime-env tests reject all boot payload keys, daemon wire tests
assert the authenticated claim, and the live guest probe must print only
`KORTIX_TOKEN` for credential-like names.

### Prove the gated query ran after enabling its feature (2026-08-22)

**When:** enabling a feature on one page, then navigating to its data page in a
browser test. A route render does not prove the gated query ran. Wait for the
exact API response around an explicit reload before asserting its empty state.
*Near-miss:* release PR #6746 browser shard 2 failed twice with a permanent Apps
skeleton after a `200` feature PATCH and zero `GET /apps` requests. *Enforcer:*
`18-apps-ui.spec.ts` requires the Apps list response before the empty state.

### Fence every detached lifecycle mutation with a durable operation id (2026-08-22)

**When:** an HTTP handler returns before a sandbox stop, start, or recovery
finishes. Acquire one database claim per `session_id`. Predicate every provider
step and completion write on that claim. A client mutation flag cannot serialize
tabs, refreshes, or repeated requests. *Incident:* session
`ebdcac7f-58bd-4a9f-ad82-b5f536f12c9c` accepted three restarts in 27 seconds and
oscillated through `running -> provisioning -> stopped -> running -> stopped`.
*Enforcer:* `runtime-restart-fence.test.ts` and the restart compare-and-set query.

### Assert an asynchronous timestamp write on its own row (2026-08-22)

**When:** proving that one request advances a row timestamp while asynchronous
lifecycle work can update sibling rows. Compare the target row before and after,
or compare two fields written by the same statement. Do not infer the write from
relative list order. *Near-miss:* release gate run 32588846407 failed `SESS-18`
twice after a later sandbox transition advanced the older session's `updated_at`.
*Enforcer:* `SESS-18` requires adoption `updated_at == last_activity_at` and
`updated_at > created_at` on the adopted row.

### Bind public Vercel runtime metadata to the deployment, not the project environment (2026-08-22)

**When:** passing public release metadata to a Vercel Production deployment.
Use `vercel deploy --env KORTIX_PUBLIC_<NAME>=<value>`. Do not add a
`NEXT_PUBLIC_*` Production project variable. Vercel CLI 59.4.0 infers secret
visibility and rejects public framework prefixes. *Incident:* v0.13.3 left
`kortix.com` on v0.13.2 after `env add NEXT_PUBLIC_KORTIX_VERSION` failed.
*Enforcer:* `web-ecs-workflow.test.ts` pins the deployment-scoped runtime value.

### A self-host has TWO version axes — the images and the CLI binary. Updating one never updates the other (2026-08-22)

**When:** diagnosing a self-host that is "on latest", or shipping any feature
whose config the CLI renders (Caddyfile, `.env` keys, compose services).

Essentia ran API/gateway/frontend images from `main` while `/usr/local/bin/kortix`
was **1565 commits stale**. The CLI renders the Caddyfile and owns the `.env`
schema, so the box silently lacked every CLI-side feature that had shipped since:
preview origins could not be configured (no such flag existed), and the Caddy
half of the "Bad Gateway" retry fix (PR #6702) had never landed even though its
API half was live in the image. **Check `kortix --version` before believing any
self-host diagnosis.** Upgrade with `curl -fsSL https://kortix.com/install | bash`
(needs `HOME` set under SSM, or it dies on `HOME: unbound variable`).

**Three update-semantics traps found in the same box:**
1. `resolveTag()` reads `KORTIX_CHANNEL`, **never** `KORTIX_VERSION`. A bare
   `kortix self-host update` on a box pinned to `dev-latest` with
   `KORTIX_CHANNEL=stable` rolled it **back 758 commits** to a 3-week-old
   release. Always pass `--version <ref>` explicitly on a pinned box.
2. `KORTIX_IMAGE_PULL=never` (set by a past `--local-images`) makes every update
   a silent no-op against the local Docker cache — `status` still reports
   "no drift", because drift compares config to running images, not to the registry.
3. `status`/`version` say "up to date" while tracking a floating tag. Compare the
   **registry manifest digest** to the local `RepoDigests`, or the `/health`
   `commit` to `origin/main`. A version string is not evidence.

*Incident:* no outage from the staleness itself; it hid a shipped fix for ~1 day
and blocked a customer feature.

### Validate a config offline before applying it, and never trust a probe whose SNI you did not choose (2026-08-22)

**When:** enabling a wildcard site block, or writing any "did it come back up?"
check against a server doing on-demand TLS.

Enabling preview origins on Essentia crash-looped Caddy for ~4 minutes:
`subject does not qualify for certificate: '*.'`. A wildcard site address and the
env var it interpolates are **two separate writes** — the Caddyfile gained
`*.{$KORTIX_PREVIEW_BASE_DOMAIN}` while the running container's baked env still
had that var empty, and Caddy refuses to adapt a config containing a bare `*.`.

**Rules.**
1. Render the target config and run `caddy validate --config … --adapter caddyfile`
   in a throwaway container with the exact env **before** touching the live stack.
   The failing and passing cases both reproduce in seconds, with no blast radius.
2. After a config write, `--force-recreate` the container so its env is rebuilt
   from `.env`. A plain restart reuses the env baked at creation time.
3. **A probe to `https://localhost` is not a health check** against on-demand TLS:
   it presents SNI `localhost`, the issuance `ask` gate correctly rejects it, and
   TLS fails — so the probe returns `000` whether the service is healthy or not.
   It fired a needless rollback here. Use `--resolve <real-host>:443:127.0.0.1`.
   Prove any guard by running it against the *known-good* state first.
4. **Never infer "no DNS" from a bare-label lookup when the record is a wildcard.**
   `dig apps.essentia.kortix.cloud` returns nothing while `*.apps.essentia…`
   exists and serves live traffic. That inference led to clearing a live
   `KORTIX_APPS_BASE_DOMAIN` and taking deployed Apps down for ~25 min. Confirm
   with the *authoritative* NS and a synthesized name, and prefer an empirical
   before/after test to any reasoning about config intent.
5. Querying a name before its record exists poisons public resolvers for the
   SOA negative TTL (1800s here). Create the record first, then resolve.

*Incident:* Essentia self-host, 2026-08-22. Two self-inflicted outages (~4 min
API, ~25 min Apps), both caused by the operator's own verification, not by the
change. Enforcer: `kortix self-host doctor` now fails on a domain-mode instance
with no preview base domain (PR #6732).

### A selective capacity release must include the pool isolation it budgets (2026-08-22)

**When:** selecting database-capacity commits for a release. Do not ship pool
arithmetic without every pool and writer that arithmetic assumes. Verify the
release tree, not `main`, contains the dedicated pool and its call sites.
*Incident:* staging release `2e01bad2` included the bounded connection budget
but omitted PR #6702. All 6 API shards returned `503` while 14-23 slow audit
inserts occupied the shared pools. *Enforcer:* `database-capacity.test.ts`
reads `audit-db.ts` and every high-volume writer from the release tree.

### A browser retry must wait for the result it is retrying (2026-08-22)

**When:** retrying a client-rendered page after an eventually consistent write.
`domcontentloaded` does not mean that React consumed the API response. Wait for
the exact response and the final DOM state before the next navigation. A poll
that reloads immediately can abort every successful render itself.
*Near-miss:* PR #6724 failed browser-1 twice while every repeated account read
returned `200`. *Enforcer:* `08-accounts-project-access.spec.ts` waits for the
exact account response and the visible `Members` heading on each attempt.

### Mint every OpenCode message id with the native sortable codec (2026-08-22)

**When:** delivering an initial, queued, retried, or imported OpenCode prompt.
Never compose `msg_` ids from base36 timestamps or UUIDs. OpenCode 1.17.11
uses id order to detect an answered prompt; an id that sorts after native
assistant ids repeats a completed initial prompt indefinitely.
*Incident:* Agency production webhooks created 40+ duplicate assistant answers
per session across DeepSeek and GLM. *Enforcer:* `sandbox-turn-lifecycle.test.ts`
requires `prepareInitialSandboxTurn()` to match `WIRE_MESSAGE_ID`.

### Normalize missing User-Agent at webhook ingress before AWS WAF (2026-08-21)

**When:** proxying public provider webhooks through the API router to an AWS
WAF-protected origin. Providers may omit `User-Agent`; signatures, not that
informational header, authenticate these requests. AWS Managed Rules reject the
request before the API can verify its signature. Add a relay `User-Agent` only
for POST webhook routes and only when absent. Preserve sender headers elsewhere.
*Incident:* Agency webhooks returned origin `403`; the same body with any
`User-Agent` reached Suna. *Enforcer:* `api-router/worker.test.mjs` covers every
webhook path family, sender-header preservation, and non-webhook exclusion.

### A JWKS is not evidence of how tokens are signed, and publishing a key changes behavior before you promote it (2026-08-21)

**When:** migrating a Supabase project to asymmetric JWT signing keys, or
reasoning about which algorithm any environment actually uses.

Two traps, both hit in one session.

**1. Read the token, never the JWKS.** Dev's `/.well-known/jwks.json` advertised
`ES256` and had since 2025-11-30 — while every token it issued was `HS256`. The
key existed in `standby` and had never been promoted. A whole perf change was
reported as "dev gets the win" on that basis and it was wrong. The only
authoritative check is decoding a real access token header:
`base64url(token.split('.')[0])` -> `{"alg":...,"kid":...}`.

**2. Importing the legacy secret publishes an asymmetric key immediately.**
`POST /config/auth/signing-keys/legacy` looks inert — it only registers the
existing HS256 secret as a key — but it also surfaces a standby ES256 key in
JWKS. That flips every verifier from "JWKS is empty, fall back to the network"
to "I have keys, verify locally", **without anything being promoted**, and it
cannot be undone: a `standby` key may only move to `in_use` or
`previously_used`, so the JWKS cannot be emptied again.

That mattered because `apps/api/src/shared/jwt-verify.ts` implements ES256/RS256
only, selects a key by `kid` and falls through to *first key in the cache* when a
token carries none, and `middleware/auth.ts` treated `unsupported-alg` as a hard
401 rather than an inconclusive result. A legacy token with no `kid` would have
selected the new ES256 key and 401'd on a valid session. It was unreachable only
because GoTrue stamps a `kid` on every token, including projects with an empty
JWKS (verified: `{"alg":"HS256","kid":"IBZFPqpuE0oC+hnZ"}`). Fixed in PR #6698 —
check the algorithm before selecting a key, and route both middlewares through
one `isInconclusiveVerifyFailure` predicate.

**The rules:** (1) verify an environment's signing algorithm from a minted token,
never from JWKS or a docstring; (2) before publishing a key anywhere, read every
verifier that consumes that JWKS and confirm an unknown/foreign algorithm falls
back instead of rejecting; (3) treat the legacy import as a behavior change, not
bookkeeping — it is one-way.

*Near-miss:* no outage. Prod was staged (ES256 `standby`, HS256 `in_use`) and its
tokens never changed. Dev and staging were promoted and verified: pre-rotation
sessions kept returning 200 (the old key moves to `previously_used` and still
verifies) and `service_role`/`anon` keys were unaffected.
*Enforcer:* `apps/api/src/__tests__/unit-jwt-alg-fallback.test.ts` pins the
predicate and the no-`kid` symmetric case. Nothing enforces rule (1) — prose only.


### `git stash` is repo-global — never `pop` from a worktree (2026-08-21)

**When:** any `git stash` / `git stash pop` inside a `pnpm worktree` checkout.
The stash stack belongs to the REPOSITORY, not the worktree, and this repo
carries ~80 entries from other people and other branches. `git stash -u` on a
clean tree creates NOTHING, so a reflexive `stash … ; do work ; stash pop`
pops **someone else's `stash@{0}`** into your tree. To compare against another
ref, use `git worktree add <tmp> <ref>`, `git show <ref>:<path>`, or
`git diff <ref>` — never stash.
*Incident:* proving a CI failure was pre-existing, `git stash -q -u` on a clean
worktree stashed nothing, then `git stash pop` unpacked
`stash@{0}` — "WIP on relay-streaming: streaming substitution kernel", 16 files
/ 1203 insertions of a colleague's parked work — into an unrelated worktree.
A modify/delete conflict is the only reason git RETAINED the entry instead of
dropping it; a clean apply would have silently consumed it and left the work
recoverable only via `git fsck`. Recovered with `git reset --hard HEAD` +
`git clean -fd` after verifying `git stash show --stat 'stash@{0}'` still
listed all 16 files. **No enforcer** — the guard is the habit.

### Entitlement is a property of the subscription, and "has an active subscription" is not "pays us" (2026-08-20)

**When:** writing any rule that decides what an account may DO — the wallet
floor, a renewal grant, a feature gate. Do not read `credit_accounts.tier` or
`billing_model` as the authority. Both are stale by design: `tier` stays `free`
for paying accounts, `billing_model` stays `per_seat` long after cancellation,
and legacy paid tiers grant no monthly credits at all. Resolve from the
subscription Stripe is collecting on.

The trap on the other side, which is why this is one rule and not two: **the
free tier carries a REAL $0 Stripe subscription whose status is `active`** —
226,931 such rows on prod. So "has a paying subscription" alone is not
"is a paying customer" either. A bypass needs BOTH a collecting subscription
AND a plan that is actually paid for. Widening the paid-plan half from
`per_seat`-only to any paid tier is the fix; dropping it is an uncapped
free-tier hole.

*Incident:* a customer paying $40/mo for "Kortix Computer · Pro" could not run
a single turn. Legacy `pro` grants 0 monthly credits, so the wallet sat at $0
and `checkBillingActive`'s one-cent admission hold 402'd every run; the paid
renewal had granted nothing since April (`getMonthlyCredits('pro') === 0`).
36 accounts in that exact shape on prod, 29 of them at a zero balance.
Fixed in PR #6662.

*Method note — the rule that actually caught the second bug:* the free-tier
hole was not found by 7,538 green API tests, by typecheck, or by driving the
real API with a seeded account. It was found by running one read-only
`GROUP BY tier, billing_model, subscription_status` against **production** to
size the affected population. **Before changing a predicate that gates money or
access, count the rows it will newly admit, per class, on prod.** A local
fixture only proves the class you thought to seed.

*Enforcer:* `billing-state.test.ts` sweeps every Stripe status × plan class,
including a free-tier + `active` $0-subscription case modeled on the real prod
row; `per-seat-pricing.test.ts` pins `resolveRenewalGrant` for per-seat,
configured-grant and paid-by-amount branches.

### A URL that carries a credential must never reach a log line (2026-08-20)

**When:** logging any URL you did not build literally on that line —
WebSocket connect URLs, presigned links, proxy targets, redirect targets.
Browser WebSockets cannot send headers, so auth is smuggled in the query
string (`?token=`), which turns "log the URL you are dialing" into "print the
user's session JWT". Log `url.split('?')[0]`, or the origin + path, never the
whole thing. Reconnect backoffs make it worse: one flapping sandbox reprints
the credential every 1-15s for as long as it flaps.
*Incident:* `pty-terminal.tsx` logged the full PTY WebSocket URL from
`getKortixPtyWebSocketUrl`, which appends the live Supabase access token, on
every connect AND every reconnect. The same file already carried a comment
saying never to echo the token-bearing URL into the visible buffer — the rule
existed, the enforcement did not. Found by audit, not by an incident; fixed in
PR #6663. **No enforcer yet** — a lint rule banning bare `wsUrl`/`url`
identifiers as console arguments is the TODO.
### A per-host credential never goes in a client-wide header bag (2026-08-20)

**When:** giving any browser/HTTP client a token that authorises ONE origin —
Playwright `use.extraHTTPHeaders`, an axios/fetch default-headers object, a
`RequestInit` you reuse. These apply to EVERY request the client makes, so the
secret goes to every third party the page touches, and any extra header forces
the cross-origin preflight to list it — which a fixed
`Access-Control-Allow-Headers` then rejects, killing the real request with
`net::ERR_FAILED` (the 204 preflight makes it look like CORS passed). Prefer the
cookie/session form of the credential, scoped to its host; if a header is the
only option, attach it per-request to that origin. **Enforcer:**
`tests/unit/web-ecs-workflow.test.ts` fails if the bypass secret returns to
`extraHTTPHeaders`.

*Incident:* `VERCEL_AUTOMATION_BYPASS_SECRET` in `playwright.config.ts`
`extraHTTPHeaders` blocked EVERY browser API call on staging — the same 11 specs
red on every release-gate run (32306385663, 32310893789) — and shipped the
secret to 16 hosts incl. Google/Facebook/DoubleClick, in plaintext inside public
workflow-run trace artifacts. Fixed in PR #6632; secret required rotation.

### A deployed API cannot read the test runner's filesystem (2026-08-20)

**When:** writing any e2e fixture that hands the API a path — `repo_url`, a file
URI, a callback host. It works locally because the API is the same machine, and
fails only against a deployed target, where the origin 5xx arrives laundered as
`503 MAINTENANCE_MODE` and looks like an outage. Branch the fixture on the
target (`src/fixtures/world.ts` and `tests/e2e/helpers/manifest-project.ts` are
the pattern: local bare repo on `local`, provisioned managed-git otherwise).

*Incident:* specs 21/22 pointed staging at `/tmp/ke2e-git-*/remote.git` on the
GitHub runner; trigger writes 502'd and the resource-grants agent list came back
silently EMPTY. PR #6632.

### Rewiring writers and converting their table to a view must be TWO releases (2026-08-19)

**When:** an expand/contract store swap (table -> compatibility view). The
migration applies BEFORE the new image rolls, so old pods run against the view
for the whole build+rollout window — and any of their `INSERT ... ON CONFLICT
(cols)` writers 42P10 for that entire window (INSTEAD OF triggers cannot help;
conflict inference precedes them). Locally it is worse: the shared Supabase DB
is cutover'd the moment the migration runs, and EVERY other worktree still on
pre-cutover code breaks until it merges main.
The rule: **release N rewires every ON CONFLICT writer off the table; release
N+1 converts it to a view.** If they must ship together, size the window
explicitly (dev: minutes; prod: pod drain + build — unacceptable for hot
writers) and schedule the promote accordingly. After cutting over a shared
local DB, tell every other active session to merge main IMMEDIATELY.
*Incident:* RBAC cutover #6594 — dev's grant/invite/SSO-JIT/SCIM upserts
42P10'd from migration-apply until the API rollout landed; every local
worktree session on pre-cutover code broke against the shared DB at once.
*Enforcer:* none — prose only. The promote runbook must carry this check.

### A VALIDATE ships only with a reconciliation the TARGET data has passed (2026-08-19)

**When:** writing `VALIDATE CONSTRAINT` for an FK/CHECK added `NOT VALID`.
Zero violating rows on the local DB is not evidence — local data is young.
Long-lived envs hold rows written before the catalog/constraint existed (dev:
`iam_role_actions` rows with retired `project.cr.*`/`trigger.*` actions).
Either probe every target env for violators first, or — better — precede the
VALIDATE with idempotent reconciliation DML in the same migration so it cannot
fail on data the constraint predates. Reconcile by REMAPPING a retired value to
its replacement, never by deleting the row: where the retired action was a
rename/collapse (`project.cr.open` -> `project.gitops.push`), the row is the
whole reason the old name still exists, and deleting it silently strips a
capability from whoever held it — a permission change disguised as a migration
fix. Delete only a value with no replacement (the dead `trigger.*` family). A merged migration that VALIDATE-fails
blocks EVERY deploy of that env; the only sanctioned fix is a checksum-guarded
runtime override (`packages/db/scripts/migration-runtime-overrides.ts`).
*Incident:* RBAC cutover #6594 — `role_permissions_action_permissions_fk`
VALIDATE 23503'd on dev; Deploy Dev blocked ~1h; fixed by the third runtime
override (map `cr.*`→`gitops.*` dedup-aware, purge uncataloged, then VALIDATE).
*Enforcer:* `migration-runtime-overrides.test.ts` pins the override; nothing
yet lints "VALIDATE without reconciliation" — prose only.

### `drizzle-kit generate` reports a TTY prompt as "no schema changes" (2026-08-19)

**When:** running `bun packages/db/scripts/generate.ts <slug>` from any
non-interactive shell (an agent, CI, a piped command).
When a diff contains BOTH a created and a deleted table, drizzle-kit opens an
interactive "created or renamed?" picker. Without a TTY it throws
`Interactive prompts require a TTY terminal`, and the wrapper still prints
`No schema changes detected — kortix.ts matches the snapshot. Nothing generated.`
— the snapshot is NOT written, and `schema-sync` then rubber-stamps a stale one.
The rule: **read the line drizzle-kit itself prints (`No schema changes, nothing
to migrate 😴`), not the wrapper's summary**, and verify
`drizzle/meta/_journal.json`'s tail plus the snapshot `prevId` chain by hand. To
avoid the prompt entirely, split the change into two generate runs — deletions
first, then creations — so neither diff has both sides.
*Near-miss:* the canonical-RBAC cutover; `account_memberships` (created) landed
in the same diff as three dropped tables, and the first run silently produced no
snapshot. Same failure class as the 2026-07-16 forked-snapshot incident
(MIGRATIONS.md "Why drizzle-kit generate needed fixing").

### `ON CONFLICT (cols)` cannot run against a view (2026-08-19)

**When:** replacing a table with a compatibility view (expand/contract), or
adding an INSTEAD OF trigger.
A view has no indexes, so `INSERT ... ON CONFLICT (a, b) DO UPDATE` fails at
runtime with `42P10 there is no unique or exclusion constraint matching the ON
CONFLICT specification` — INSTEAD OF triggers do not help, because inference
happens before they run. `ON CONFLICT DO NOTHING` with NO target does work. A
view with a JOIN is not auto-updatable at all, and a rendered/expression column
is never assignable even on an otherwise auto-updatable view.
The rule: **before turning a table into a view, grep every writer for
`onConflictDoUpdate` / `ON CONFLICT (` on that relation and rewire it first.**
*Near-miss:* the canonical-RBAC cutover — five production write sites on
`project_members` / `project_group_grants` / `iam_resource_grants` / the
`account_members` accept paths would have 500'd on the first grant after deploy.
*Enforcer:* `apps/api/src/__tests__/unit-iam-gate-codemod-pin.test.ts`
("no production module writes a legacy grant table directly").

### A store swap needs the FKs the old store had, or it silently loses a cascade (2026-08-19)

**When:** moving rows from several tables into one canonical table.
`project_members`, `project_group_grants` and `iam_resource_grants` each had
`ON DELETE CASCADE` from `kortix.projects`; the canonical `role_assignments` had
no FK on `scope_id`, so the swap would have made "delete a project" stop
retracting its grants. The legacy `iam_policies` never had that FK either, and
410 of its 413 local rows pointed at deleted projects — orphans nothing could
observe and nothing cleaned up.
The rule: **enumerate every FK and every ON DELETE rule on the tables you are
replacing, and reproduce them on the survivor.** Add the FK `NOT VALID`, purge
the pre-existing violations in a batched `.concurrent.ts`, then `VALIDATE` in a
follow-up file.
*Near-miss:* the canonical-RBAC cutover, caught by diffing `pg_constraint` for
the retired tables before writing the migration.


### A picker that offers a model the runtime does not know is a silent outage; the runtime must learn the set from the API it talks to (2026-08-19)

**When:** adding or changing a managed model (`LLM_GATEWAY_MANAGED_MODELS`,
`@kortix/llm-catalog` MANAGED_MODELS), or touching how the sandbox daemon
builds OpenCode's `kortix` provider (`apps/kortix-sandbox-agent-server/src/opencode.ts`).
The web picker reads the API (`/model-picker`, `/v1/llm/models`); OpenCode in the
guest accepts only the ids in the provider map it BOOTED with, built from the
image-baked `/opt/kortix/llm-catalog.json`. That file is frozen at template-build
time and nothing rebuilds a template for a catalog change, so every managed
model added after the bake is offered by the picker and rejected by the guest
(`ModelNotFound: kortix/<id>`, 2 ms after the user message, before any gateway
call). Rules: (1) the guest must fetch the managed set from the API on EVERY boot
(`GET /models?scope=managed`, ~3 KB) and overlay it — never trust a baked list
for anything deployment-config decides; (2) a boot-path fetch gets its own small
budget and a bundled fallback, and is started in parallel with the clone, never
awaited on the critical path beyond a cap; (3) a catalog "refresh" that can
silently fall back (here 2.5 s/4 s for a 3.3 MB body) is not a refresh — size the
payload to the budget; (4) a `session.error` with no assistant message must be
rendered under the turn that failed, or the user sees nothing at all.
*Incident:* prod 2026-08-19, `grok-4.6` and `deepseek-v4-pro-0813` (added
2026-08-12/13) returned no reply in every session on templates built before
then; 0 gateway log rows ever. PR #6576.
*Enforcer:* `managed-fallback-sync.test.ts` (bundled table vs `MANAGED_MODELS`
drift — cited here since 2026-08-19 but ABSENT on `main` until 2026-08-27, when
adding `glm-5.3-flash` found the gap; it now lives in
`apps/kortix-sandbox-agent-server/src/__tests__/` and fails on a missing,
misnamed, mis-sized, or mis-priced bundled entry), `managed-model-overlay.test.ts` (stale file + live overlay; failed
fetch → bundled floor; await cap), `managed-scope.test.ts`; web: sync-store
per-turn `session.error` tests. Not enforced: a live "picker ⊆ guest provider
map" assertion after deploy — run the dev sweep by hand until it exists.

### `KORTIX_SELF_HOST_CONFIG_DIR` isolates the config, NOT the containers (2026-08-19)

**When:** exercising `kortix self-host` locally on a machine that already runs a
self-host instance. Pointing `KORTIX_SELF_HOST_CONFIG_DIR` at a temp directory
looks like a sandbox — `init` writes a fresh `.env` + compose there and touches
nothing else. But `composeProject(instance)` derives the Docker Compose project
name from the INSTANCE NAME alone (`kortix-<instance>`), so any command that
reaches `docker compose` — `env set`, `start`, `update`, `configure` — applies
the temp config to the containers of the REAL instance of the same name.
`env set EMAIL_URL=…` against a temp dir recreated the live instance's
`kortix-api` (×2, from the temp `KORTIX_APP_REPLICAS`) and `supabase-auth` with
the temp instance's secrets.

The rule: when testing self-host CLI commands against a throwaway config dir,
**also pass `--instance <unique-name>`** — that is the only input that moves the
Compose project. Verify with `docker ps --filter name=kortix-<instance>` BEFORE
running anything that restarts services, and prefer `--no-start` plus reading
the rendered `.env`/`docker-compose.yml` when you only need to inspect
derivation.

Recovery: re-apply the real instance's own files —
`docker compose --project-name kortix-<instance> --env-file <real>/.env -f
<real>/docker-compose.yml up -d --no-build` — then prove identity by diffing a
secret from the real `.env` against `docker exec … printenv`, not by health
alone (a container started from foreign config is perfectly healthy).
*Incident:* 2026-08-19 near-miss during the EMAIL_URL work — the local
`kortix-default` instance (16 containers, up 16 h) had 3 containers recreated
with a temp instance's secrets; restored in ~4 min, all 16 healthy after.
*Enforcer:* none — the CLI should either namespace the Compose project by the
config dir or refuse when the resolved project already exists under a different
instance directory. Until then this rule is the only guard.
### A request/response log must never cap what it captures (2026-08-18)

**When:** persisting or rendering a captured request/response body (gateway
traces, debug logs, any "what was actually sent/received" viewer). Do not add
a byte/char cap that silently swaps in `{truncated, bytes, preview}` or a
"...(truncated)" marker — a capped log lies about what happened and there is
no way for the reader to know how much is missing. If two layers each cap
independently (backend storage, then frontend syntax highlighting), the
combination is even harder to notice.
*Incident:* the gateway's `capture()` (256 KiB) and `relayStream`'s response
preview (256 KiB) both truncated request/response bodies before storage, and
the web Logs viewer then ran the residue through Shiki's highlighter, which
separately clamps at 50,000 chars. A 1.66 MB request showed as a
`{bytes, preview}` stub cut a second time. Fixed in #6523: full capture,
uncapped; `HighlightedCode` takes an `unbounded` flag for viewers whose whole
purpose is showing complete content, keeping the clamp elsewhere as a perf
guard for live-streamed re-highlighting.
*Enforcer:* `packages/llm-gateway` handler/streaming tests assert full-length
capture; `shiki-highlighter.test.ts` pins `unbounded` bypassing the clamp.

### A shared connector catalog needs one canonical credential scope (2026-08-18)

**When:** rematerializing a credential-dependent connector catalog. Only the
project-default credential may write project-wide `connectorActions`. Never use
a member-owned or non-default connection credential. Store catalogs per
connection before supporting credential-specific action sets.
*Incident:* Strix found that PR #6507 let a member MCP credential overwrite the
shared project catalog and expose tenant-specific tool metadata before merge.
*Enforcer:* `sync-mcp.test.ts` rejects member and non-default rematerialization.

### Catalog discovery must use execution credentials and fail on upstream errors (2026-08-18)

**When:** materializing a remote connector catalog, especially MCP
`tools/list`. Resolve the same effective connection credential and static
headers used by tool execution, including OAuth refresh. Reject non-2xx,
protocol-error, and malformed responses; persist a safe error instead of an
apparently healthy empty catalog. Re-run discovery after credentials change,
and never include raw or encoded credential material in diagnostics.
*Incident:* Essentia Dev Sage Intacct authenticated successfully and exposed
four MCP tools, while Kortix sent no credential, parsed an empty HTTP 401 body,
and materialized zero actions without an error.
*Enforcer:* `sync-mcp.test.ts`, `unit-connector-call.test.ts`, and
`oauth2.test.ts` cover authenticated discovery, refresh/rematerialization,
HTTP/JSON-RPC failures, and credential redaction.

### A reused speculative resource needs a consumption signal every holder can see (2026-08-17)

**When:** caching a server-side find-or-create resource client-side (the warm
session ready-store; any pre-provisioned handle). `POST /sessions/warm` reuses
ONE still-unused session per user+project, so every tab, browser and device of
that user holds the SAME id — and a per-tab in-memory store then trusts its
held copy for its whole dwell. The moment ANY holder uses the resource, every
other copy silently points at a session with a conversation in it; the next
project-home send navigates there and auto-sends into it. Holding is not
owning: consult a synchronous cross-holder registry at take time (localStorage
is the only sync cross-tab channel), record every take AND every navigation
into a session, and revalidate a held copy on visibility regain (scopes
localStorage cannot cross). Corollary that let it ship: every session e2e flow
`requires: ['daytona']`, so NO warm contract runs in local CI — green local
gates proved nothing about this feature.
*Incident:* 2026-08-17, dev, night before a customer release — home prompts
delivered into previous sessions; newest session missing from the list (list
seed wiped by refetches racing the `/start` marker drop; adoption stamped no
activity or `updated_at`).
*Enforcer:* `warm-session-taken-registry.test.ts` +
`use-warm-project-session.test.ts` (cross-tab takes, navigation consumption,
revalidation); SESS-18 pins `/start` adoption, list order and
`exclude_session_id` — but only at staging gates (daytona-gated locally:
still a gap).

### Active-turn renewal cadence must stay below the shortest provider backstop (2026-08-17)

**When:** changing sandbox maintenance cadence, provider lifecycle timers, or active-turn renewal. Run exact-turn renewal in a separate leader-owned loop capped at 30 seconds. Do not couple it to the five-minute project-maintenance sweep. Scope the fast lane to durable `activeTurn` or `activeTurns` authority only.
*Incident:* Dev Daytona renewed once, then stopped an exact active OpenCode turn 68 seconds later because the next project-maintenance pass was scheduled five minutes later than the one-minute deterministic provider timeout.
*Enforcer:* `active-turn-renewal.test.ts` caps the loop at 30 seconds and requires `activeTurnsOnly`; `sandbox-reaper.test.ts` excludes idle rows from the fast lane; the live provider harness uses a one-minute native timer.

### Every sandbox stop must revoke all persisted turn authority (2026-08-17)

**When:** changing provider webhooks, idle reaping, manual stop, or the shared stopped-state writer. Remove `activeTurn`, `activeTurns`, and `lifecycleStopClaim` in the same transaction that sets `status='stopped'`. Do not rely on the reaper to clear tokens first; a provider-native timer or webhook can win that race.
*Incident:* the one-minute Dev Platinum proof stopped after `deadline_at`, but the provider webhook committed `status='stopped'` with a synthetic unknown `activeTurns` token still present.
*Enforcer:* `sandbox-state-sync.test.ts` requires `applyStoppedState()` to remove every turn-authority key atomically for all stop paths. The live provider harness verifies the stopped row has zero active turns.

### Presigned uploads must suppress runtime-inferred content types (2026-08-17)

**When:** sending a body to a provider-generated signed upload URL. Send the exact signed headers. Set an explicit empty `Content-Type` when the signature omits it. Do not let Bun infer a MIME type from `Bun.file()`.
*Incident:* E2B template uploads returned GCS `403 SignatureDoesNotMatch` because Bun added `application/gzip` to a URL signed with an empty content type. Template creation succeeded, but every new immutable image remained unbuildable.
*Enforcer:* `unit-e2b-bun-upload-patch.test.ts` requires the E2B dependency patch to use `Bun.file()` and an explicit empty `Content-Type` in both bundles. A real E2B template build verifies the signed upload.

### Provider lifecycle renewal must use the provider activity primitive (2026-08-17)

**When:** implementing provider-neutral lifecycle renewal. Use the provider's native activity or deadline API. Do not assume a guest command updates the provider lifecycle clock. Reject renewal unless the provider reports the sandbox as running.
*Incident:* Daytona accepted repeated `true` guest commands while its one-minute native autostop clock continued unchanged. The sandbox stopped 21 seconds before Kortix `deadline_at` during deterministic lifecycle testing.
*Enforcer:* `daytona.test.ts` requires `refreshActivity()`, rejects stopped sandboxes, propagates failures, and bounds a hung refresh. The live provider harness forces a one-minute native timer.

### A persisted user message is not proof that its OpenCode turn is active (2026-08-17)

**When:** changing exact-turn lifecycle probes. Treat a user-only or incomplete assistant message as active only when `/session/status` reports that exact session as `busy` or `retry`. Treat an idle session as terminal. Treat an unreadable or unknown status as unknown and non-renewing.
*Incident:* a native OpenCode prompt persisted its user message but created no assistant message; the exact-message probe returned active for 198 seconds and would have renewed an idle Platinum sandbox indefinitely.
*Enforcer:* `orphaned-turn-finalize.test.ts` covers busy, retry, idle, and unreadable session status.

### A sandbox lifecycle grant requires exact active-turn evidence (2026-08-17)

**When:** changing session prompt delivery, sandbox reaping, or any sandbox provider lifecycle adapter. Persist token-bound `delivering` authority before upstream delivery. Promote only after OpenCode exposes the exact user `messageID`. Renew both `deadline_at` and the provider-native timer only from a fresh exact-turn probe. Treat unknown evidence as non-renewing. Linearize idle stop against prompt delivery with one database claim, and never let renewal wake a stopped sandbox.
*Incident:* long OpenCode image analyses outlived E2B's absolute timeout and provider idle timers; Kortix displayed “Your session will be restored” while the agent still worked.
*Enforcer:* `sandbox-turn-lifecycle.test.ts`, `integration-sandbox-turn-lifecycle.test.ts`, `sandbox-reaper.test.ts`, `initial-turn-lifecycle.test.ts`, and all three provider lifecycle suites.

### A platform-injected principal must never have its authority re-derived from user config (2026-08-13)

**When:** touching code that RE-resolves an already-minted credential —
`remintGrantForAgentSwitch` / `reconcileStoredSessionAgentGrant`
(`apps/api/src/projects/lib/session-token-grant.ts`), which run on EVERY prompt
and every connector call. The `meta` coordinator is injected by
`addPlatformMetaAgent` and appears in no `kortix.yaml`, so resolving it through
the manifest returns "unlisted agent": deny-all on a governed project,
UNRESTRICTED on an ungoverned one. Both are destructive — the deny-all was
WRITTEN over the coordinator's real grant on its first turn, and the null made
the re-mint refuse the turn outright. Branch for the platform-owned principal in
the ONE pure resolver every path shares (`grantFromLoadedAgents`); a special case
at the mint alone is exactly what the re-mint then erases.
Two traps cost hours here. A comment asserting a fast path is not evidence the
fast path exists — `preview.ts:1144` says an ordinary turn "skips the manifest
read entirely" while the callee has no early return at all; read the callee. And
`authorizeV2` returns `super_admin` BEFORE the agent-grant fold, while a personal
account's primary owner has `is_super_admin = true` — so this entire bug class is
invisible on a laptop until you clear that flag.
*Incident:* the meta coordinator could not list or spawn sessions for the account
owner running it; `kortix sessions ls` / `new` 403'd from turn one onward, and
the 403 blamed their role (that misdiagnosis fixed separately in #6443).
*Enforcer:* `apps/api/src/__tests__/unit-meta-agent-grant-resolution.test.ts`
pins resolution for governed / ungoverned / unreadable manifests, the `skip`
re-mint decision, and the old destructive `write` as a regression guard. Nothing
enforces the comment-vs-callee or super-admin traps — those are prose only.

### Anything created per-deploy needs a reaper, and the reaper needs a namespace (2026-08-12)

**When:** adding or reviewing code that creates a named provider-side artifact
— a snapshot, image, template, volume. Ask two questions: *what deletes the
previous one*, and *whose is it*. `ensureMetaSandboxImage` answered neither: it
deleted a snapshot only when its OWN build failed, never when a newer one
superseded it, and its name carried no environment. The meta fingerprint hashes
the agent/CLI/SDK/shared/starter source trees, so it moves on nearly every
commit — one permanent snapshot per deploy, forever.
Namespace the name by `INTERNAL_KORTIX_ENV`: dev, staging and prod share ONE
Daytona organisation (same API key in all four env profiles), so an
un-namespaced reap on dev deletes the image prod boots from. And make the
"is it still in use" lookup fail **closed** — `recentlyBuiltSnapshotNames`
returns an empty set on a DB error, which a reaper reads as "nothing is
protected, delete everything".
Before writing any reaper, find who still reads the thing: the sibling
`kortix-app-*` snapshots look equally abandoned but are the targets of
`POST /apps/{appId}/rollback`, so reaping them on supersession would have
broken rollback. Unbounded-but-needed means bounded retention, not deletion.
*Incident:* the Daytona organisation hit its 200-snapshot quota (226, of which
118 meta at ~8/day). `POST /snapshots` then 400s, which fails every CI run and
every NEW-project build. Existing projects survived only because
`canServeLastKnownGoodRuntime` lets a session-start boot the previous image —
so the visible symptom was "CI is broken", while the quieter one was that
runtime updates silently stopped reaching sandboxes.

### A deployed API is not a deployed daemon (2026-08-12)

**When:** shipping any change to `apps/kortix-sandbox-agent-server`, or turning
on something that depends on one. `/health` reporting your commit proves the API
rolled; it says nothing about the sandbox. The daemon is gzipped into the
snapshot build context (`apps/api/src/snapshots/build-context.ts:185`) and
reaches a session only after that snapshot is rebuilt or agent-swapped
(`snapshots/templates.ts:613`) AND the warm pool has cycled off the old one.
Prove it in the guest, not from the API:
`grep -aoE "<expected literal>" /usr/local/bin/kortix-agent` in a session
created after the deploy — the Bun-compiled binary embeds its source strings.
Sequence any dependent flag flip AFTER that probe passes.
*Incident:* near-miss, same day as the MCP-argv fix below. Deploy Dev went green
and `dev-api` reported `66b6148d`, but two sandboxes created ~15 min later both
still had the pre-fix `"connector"` spelling. Merging the flag that enables the
MCP face on that evidence would have given every session a server whose command
exits 2 — a broken MCP entry where there had been none.

### A cross-process command string needs a test that RUNS it (2026-08-12)

**When:** one component spawns another by a hardcoded argv — the daemon's
OpenCode MCP entry (`apps/kortix-sandbox-agent-server/src/opencode.ts`), an
entrypoint script, a CronJob command. Asserting the literal proves only that
the string is what you just typed. Spawn it and require a real response.
Pinning both sides to the same literal is worse than no test: it makes the
typo look deliberate and survives review. Where the two packages cannot share
a constant (the daemon is standalone by design — hono + zod, no workspace
deps), read the argv from the producer and execute it in the consumer's test
(`apps/cli/src/__tests__/connectors-mcp-handshake.test.ts`).
*Incident:* e868be1d6c renamed the CLI command `executor` → `connectors` but
pointed the daemon at `connector`, singular. Every sandbox got `unknown
command` + exit 2, so the `kortix-connectors` MCP server never started for six
days. Both daemon unit tests were updated to assert the typo and stayed green;
the e2e tests that really spawn the server used the plural and also stayed
green, testing a path production never took. Blast radius was zero only because
`KORTIX_CONNECTORS_MCP_ENABLED` is off everywhere — the flag, not the tests, is
what contained it.

### A per-turn hot path must not contain an unbounded third-party round-trip (2026-08-11)

**When:** adding an `await` to the prompt path — `syncSandboxEnvForPrompt`
(`apps/api/src/projects/lib/sandbox-env-sync.ts`) and everything it calls. The
network-boundary sync ran a FULL provider re-arm before every turn: manifest
resolve, GET/PUT sandbox secrets, `ensureSecret` per binding, then
`waitUntilArmed` at 40 × 250 ms — up to ~10 s, past the proxy budget. One egress
secret therefore broke every agent turn in the project. Arm once at session
start or in the background, bound the wait, and fail soft ONLY where a skipped
call cannot widen access (a boundary value never enters the guest, so the worst
case is a 401 upstream, not a leak). It also ran before `postEnvToDaemon`, so its
failure skipped the ordinary runtime-secret push too.
*Incident:* 2026-08-11 — same session, same sandbox: egress secret active →
`prompt_async` 502 in 5.2 s, disabled → 200 in 1.2 s. Found only when the product
owner said "I cannot test this on dev"; the symptom was a spinner stuck on
"Considering next steps…", naming neither secrets nor the provider.
*Enforcer:* none — build it.

### A deploy workflow must not cancel a build it cannot outrun (2026-08-10)

**When:** setting `concurrency.cancel-in-progress` on any
`.github/workflows/deploy-*`. A workflow-wide group with `true` starves the
SLOWEST surface, because every surface shares the group: a frontend-only push
kills an in-flight multi-arch API build (~23 min) whenever `main` lands faster
than that build takes (~10–20 min by day). Queue instead — GitHub holds one
pending run and cancels the previous pending one, so a burst still collapses to a
single deploy and the newest commit still wins. `true` also lets an unrelated
push kill `migrate-db` mid-migration.
*Incident:* 2026-08-10 — 19 of 30 Deploy Dev runs cancelled, `dev-api` pinned to
`d1ed3589` for 3.5 h with 5 API commits stranded; it landed only once the trunk
went quiet that evening.
*Enforcer:* none — and `deploy-staging` is still `true`, where a cancelled
`migrate-db` would hit `STAGING_DATABASE_URL`. Build the guard.

### One CREATE INDEX CONCURRENTLY per table at a time (2026-08-10)

**When:** building indexes on a live table (runbooks, .concurrent.ts migrations).
Two concurrent CIC builds on the same table starve each other's
lock-acquisition points — every acquisition 55P03s until one finishes. Build
strictly serially. If a builder's client process dies, its CIC keeps running
SERVER-side, holds ShareUpdateExclusive, and its final commit is unreliable —
find it in `pg_stat_progress_create_index`, `pg_terminate_backend` it, and
`DROP INDEX CONCURRENTLY` the INVALID shell before rebuilding (`IF NOT EXISTS`
silently keeps invalid shells).
*Incident:* v0.12.7 audit-v2 index pass — parallel lanes 55P03-thrashed, a
killed lane left an orphaned build that starved the retry run.

### The Vercel prod build must be handed the release version (2026-08-10)

**When:** touching deploy-prod's Vercel deploy or apps/web/next.config version
resolution. The Vercel build (rootDirectory apps/web) cannot reliably read the
repo-root VERSION file, so runtime-config reports "dev" and
frontend-auth-proof's `VERSION === X.Y.Z` check fails. Pass
`--build-env NEXT_PUBLIC_KORTIX_VERSION=<version>` on every prod deploy (the
`deploy-web-vercel` job does); the project env `NEXT_PUBLIC_KORTIX_VERSION` is
a static fallback that goes stale — the build-env override wins.
*Incident:* v0.12.7 frontend served VERSION "dev"; gate exhausted 30 attempts;
fixed by `vercel redeploy` after setting the env.

### An audit reconstruction trigger is only safe with its dedup index (2026-08-10)

**When:** installing triggers that INSERT INTO audit_events with
source_ledger/source_record_id set. The prepare-trigger's duplicate check needs
`idx_audit_events_source_phase`; without it every triggered insert seq-scans
the whole table and times out the OUTER statement — cron trigger dispatch
failed prod-wide for ~80 min. Order in any reconcile: dedup index BEFORE (or
immediately after) trigger install, never "later with the other indexes."
*Incident:* v0.12.7 reconcile installed triggers at 17:56, index landed 19:29.

### Never backfill data inside a single-transaction migration (2026-08-10)

**When:** writing any `.sql` migration under `packages/db/migrations/`.
A plain `.sql` migration runs in ONE transaction, so its `ALTER TABLE`s hold
ACCESS EXCLUSIVE until COMMIT — top-level `UPDATE`/`INSERT INTO`/`DELETE
FROM`/data-modifying `WITH` in the same file turns milliseconds of lock into the
full backfill duration, blocking every writer on the table. Write data moves as
batched, incrementally-committed `.concurrent.ts` passes or a supervised
out-of-band runbook (short-tx DDL → triggers → chunked updates → CONCURRENTLY
indexes → ledger rows).
*Incident:* v0.12.7 promote — `centralized_audit_v2` rewrote 30.5M rows of
`audit_events` under lock; prod down ~30 min.
*Enforcer:* `lint-migrations.ts` backfill-DML guard (`-- backfill-safe:`
sign-off escape hatch; `backfill-grandfathered-migrations.json` snapshot).

### Cost every pending prod migration before promoting (2026-08-10)

**When:** preparing a release/promote.
Ordering-correct is not enough. Diff `kortix_migrations.pgmigrations` on prod
against the promoted tree, and for each pending migration ask what it does at
prod data volume. A tag tree containing a migration file is NOT proof the
migration ran — only the ledger is.
*Incident:* same v0.12.7 outage — the dangerous migration had been "shipped" in
v0.12.6's tag but never applied; nobody costed it before the promote.
*Enforcer:* kortix-release skill Step 3.6 (checklist); this rule is the reason.

### The prod frontend must never deploy before the API serves the release (2026-08-10)

**When:** touching `vercel.json`, `vercel-ignore.sh`, or `deploy-prod.yml`.
A push to `prod` must not auto-deploy kortix.com; the frontend deploys only from
deploy-prod's `deploy-web-vercel` job after `verify-live-version` proves the API
is on the release. A new frontend against an old API calls routes that do not
exist — every project load fails "before we could check your access".
*Incident:* v0.12.7 — Vercel auto-promoted the new frontend while the API stayed
back after its migration failed; second occurrence of the class (v0.10).
*Enforcer:* `deploymentEnabled.prod:false` + `deploy-web-vercel` job, pinned by
`tests/unit/web-ecs-workflow.test.ts`.

### node-pg-migrate checkOrder is index-wise on ledger run order (2026-08-10)

**When:** doing any out-of-band migration apply or ledger surgery.
`checkOrder` compares the ledger's run order (`ORDER BY run_on, id`) position by
position against filename order — appending an older-named migration to the end
of the ledger fails the NEXT migrate even though "everything is applied". Place
reconciled rows' `run_on` so ledger order matches file order.
*Incident:* staging deploy failed post-reconcile until the 7 audit-v2 rows were
re-timestamped before the two later migrations.

### Cancel the CI run before killing its DB backend (2026-08-10)

**When:** a deploy's migration step is wedging prod and you terminate it.
The migrate step (and `withMigrationDeadlockRetry`) retries: killing only the
Postgres backend re-locks the table minutes later. Order: cancel the workflow
run, then `pg_terminate_backend`, then verify no reconnect.
*Incident:* v0.12.7 — first kill was undone by a retry; prod degraded a second
time before the run was cancelled.

### Bot-pushed release PRs and repo Actions approval policy (2026-08-10)

**When:** a required check sits in `action_required`, or changing repo Actions
settings. `fork-pr-contributor-approval: all_external_contributors` holds EVERY
PR workflow whose actor lacks write access — including `github-actions[bot]` on
promote-created release PRs — stalling releases behind a manual approve click.
Keep it at `first_time_contributors` (org default) unless there is a concrete
reason, and never quietly stricter than the org.
*Incident:* v0.12.7 release gate stalled in `action_required`.

### Verify CI assertions against the real artifact format on the CI OS (2026-08-10)

**When:** writing shell assertions in workflows (grep/awk over curl output,
cookie jars, headers). curl's Netscape cookie-jar puts the domain in the FIRST
field with an `#HttpOnly_` prefix — a tab-anchored grep can never match; and GNU
grep -E treats `\t` in single quotes as a literal `t` while macOS grep interprets
it, so a locally-green pattern can be dead on ubuntu runners. Use ANSI-C
quoting (`$'\t'`) and test the exact pattern in an ubuntu container.
*Incident:* staging web verify failed twice on the same one-line assertion.

### A TLS/proxy component is only as correct as the third-party clients that accept it (2026-08-14)

**When:** shipping anything that terminates TLS, mints certificates, or sits in
front of other people's HTTP clients (the in-guest egress shim, any MITM proxy).
Unit tests and a `curl` probe are NOT evidence. Three separate bugs in this one
component passed every in-process test and every curl check, and each was found
only by running a real heterogeneous client in a real guest:

- `git` sends CONNECT, gets a 407, and retries **on the same socket**. Without
  `Content-Length: 0` + `Connection: close` on the challenge the retry vanishes
  and every clone fails, while curl is unaffected because it reconnects.
- Python's OpenSSL refuses a chain whose leaf carries no **Authority Key
  Identifier** (`CERTIFICATE_VERIFY_FAILED ... Missing Authority Key
  Identifier`); curl accepts the identical certificate. An AKI also needs a
  **Subject Key Identifier** on the issuer to point at, and node-forge's PARSED
  `subjectKeyIdentifier` is a hex string — feeding it back yields an AKI naming
  an issuer that does not exist and breaks every handshake. Use
  `caCert.generateSubjectKeyIdentifier().getBytes()`.
- `curl` offers `Accept-Encoding: gzip` by default. Any redaction that scans
  response BYTES is silently defeated by a compressed body, so a credential
  echoed back returns intact. Force `identity` on the relayed request.

Run the real clients — `curl`, `python3 -m requests`, `git`, `node fetch` — in a
real sandbox before claiming a proxy works, and assert on what the UPSTREAM
received, not on the absence of an error.
*Incident:* the Daytona network-boundary shim shipped to dev broken for every
Python client; caught by a live probe, not by 27 green tests.

### Bun diverges from Node in three load-bearing ways around raw sockets and TLS (2026-08-14)

**When:** writing socket/TLS code that runs under Bun (the API and the sandbox
daemon both do). Measured, bun 1.3.14 vs node v22.22.0:

- `http.Server.emit('connection', socket)` is a **no-op** — the request event
  never fires and the connection hangs with nothing in any log. Use a real
  loopback listener and pipe into it.
- `SNICallback` **never fires** — the handshake completes against a default
  certificate. Bind one static-cert listener per terminated host instead.
- The `'upgrade'` event fires, but a write from that handler **never reaches the
  client**; Node delivers the same bytes. Destroy the socket rather than trying
  to answer.

All three fail SILENTLY (a hang, or the wrong certificate), never an exception.
*Incident:* each cost a debugging cycle in the egress proxy/shim.

### A path allowlist that gates non-idempotency must list EVERY turn-creating endpoint (2026-08-11)

**When:** touching the sandbox proxy's retry loop, or adding an OpenCode endpoint
that starts an agent turn.
`routes/preview.ts` derived "is this safe to retry?" from
`shouldSyncProjectEnvBeforeProxy`, a predicate named after env sync whose regex
listed only `/session/:id/{message,prompt_async}`. `POST /session/:id/command` —
what every `/` slash-command posts to — matched neither that nor
`isLongTurnCompletionRequest`. One omission silently disabled FOUR independent
safeguards at once: no dedupe claim, retry-on-5xx allowed, retry-on-ambiguous-
timeout allowed, and a 15s connect cap applied to an endpoint that blocks for the
whole turn. `MAX_RETRIES = 3` then re-POSTed the non-idempotent body, so one user
submit ran the agent four times and billed four turns.
**Rules:** (1) a predicate that answers "may I send this twice?" gets its OWN
name and its own list — never reuse one written for a different question, because
adding an endpoint to one concern silently opts it into or out of the other;
(2) any new turn-creating path must be added to `isNonIdempotentSessionWrite`
(`sandbox-proxy/prompt-dedupe.ts`) AND `isLongTurnCompletionRequest`
(`sandbox-proxy/preview-retry-budget.ts`) in the same commit.
**Enforcement:** both predicates are unit-tested per endpoint in
`prompt-dedupe.test.ts` / `preview-retry-budget.test.ts`. Black-box proof: two
identical `/command` POSTs must yield exactly one new user message.
*Incident:* session `9f6b0d87`, one `/webapp` submit recorded as 4 identical user
messages 11.0s / 11.8s / 13.7s apart (attempt timeout + `RETRY_DELAYS_MS`
[250, 1000, 3000]).

### Two proxy layers must agree on which upstream calls legitimately block (2026-08-11)

**When:** changing a timeout in `kortix-sandbox-agent-server/src/proxy.ts` or
`apps/api/src/sandbox-proxy/`, or adding an OpenCode endpoint that withholds
headers until its work completes.
The daemon bounded EVERY proxied header wait at `UPSTREAM_RESPONSE_TIMEOUT_MS =
10_000`, reasoning only about SSE (headers arrive fast) and a wedged opencode.
`POST /session/:id/command` emits nothing until the whole turn finishes, so
every command over 10s was aborted and answered `502 {"error":"upstream
unreachable"}` — the banner users saw in chat, on a healthy turn. Its own
comment said the 502 exists so "apps/api's retry+auto-wake loop can act on it
immediately" — and that loop assumed idempotency. **A fail-fast designed to
trigger a retry met a retry loop that assumed it was safe to repeat.** One
`/webapp` submit ran the agent four times, each retry aborting the turn the
previous one started, which is where the "Interrupted" labels came from.
**Rules:** (1) a header-wait timeout is only valid for endpoints that ANSWER
fast — blocking-turn endpoints need their own generous bound
(`isBlockingTurnRequest` / `LONG_TURN_RESPONSE_TIMEOUT_MS`); (2) when one layer
fails fast *expecting* another to retry, the retry decision must be written down
in both layers, never inferred; (3) a client must not render a
delivered-then-disconnected prompt as a failed send — the retry it invites is
what aborts the live turn (`delivered-but-disconnected.ts`).
**Enforcement:** `blocking-turn-timeout.test.ts` drives BOTH layers' predicates
with the same inputs and requires identical verdicts (verified falsifiable — it
goes red when either side drifts).
**Deployment trap:** the daemon ships inside the sandbox image, so this fix
reaches only sandboxes created from a NEW snapshot. Existing sessions keep the
10s bound; the web-side classifier is what covers them.
*Incident:* session `9f6b0d87`.

### A control split across API and daemon is only live when BOTH halves are (2026-08-14)

**When:** shipping any security control whose two halves live in `apps/api` and
`apps/kortix-sandbox-agent-server`. The API half goes live the moment Deploy Dev
finishes. The daemon half does NOT: it is baked into the sandbox image, reaches
a guest only through a new meta-snapshot build, and the fingerprint that
triggers that build hashes `apps/kortix-sandbox-agent-server/src`. Until an
image carrying the new daemon exists, the API half is running against old
guests and the control does nothing.

The sandbox egress pin hit this exactly: the API mount was verifiably live
(boot-timeline went 403 → 401 on the same request), but a real exfiltrated-token
attack still SUCCEEDED because the box's baked daemon still sent the wrong
token, so nothing wrote a pin. The identical test passed later, unchanged, once
a sandbox with the new daemon existed.

Two rules:

- **Never conclude "the control does not work" from one post-deploy run.** Prove
  which half is live first. An API-side before/after on the same request is
  cheap and decisive (`403 handler-guard` → `401 middleware`).
- **A control that fails OPEN is the right default while it propagates** — the
  pin allows `unpinned`, so old guests kept working and nothing regressed
  during the lag. A fail-closed control shipped this way is an outage.

Do not read a fast `session_start_timeline.totalMs` as proof of a warm-pool box
either: `KORTIX_WARM_SNAPSHOT_ENABLED` defaults false, and ~2s is also what
creating a container from an ALREADY-BUILT image costs.
*Incident:* the token-binding verification failed twice before the image landed.

### A resource-scaled timeout moves the cliff, it never removes it (2026-08-16)

**When:** sizing any timeout whose budget you are tempted to scale by how big
the work is — prompt bytes, file size, row count, payload length.

The LLM gateway gave a new upstream stream a first-byte budget of
`30_000 + ceil((requestBytes - 64KiB) / 1MiB) * 15_000`, capped at `120_000`.
Four size steps land on `90_000` exactly, so every request body between
3,211,776 and 4,259,840 bytes got a 90-second budget and then died with
`upstream stream probe timeout exceeded (90000ms with no bytes)` on a
completely healthy upstream. Users saw a Claude Fable 5 turn fail identically
on every retry once an analysis step pushed the context past ~3 MiB.

The scaling was the bug, not an insufficient constant. Growing the context
raises the budget linearly but raises the model's prefill + thinking time by
more, so the cliff is reachable at every size — it just relocates. **Scale the
budget and you have chosen which inputs fail, not whether they fail.**

Three rules:

- **A slow dependency is not a broken one.** Reserve timeouts for detecting
  *death*. Where "slow" and "dead" are locally indistinguishable — which is
  always, for a model that is prefilling — the deadline must pick a
  *degradation*, not a failure. Here it became a COMMIT point: the stream is
  handed to the relay, which sends headers and heartbeats while the model
  works. Failing over is what silently downgraded users to a fallback model.
- **A timeout you cannot observe from the outside will fire on healthy work.**
  The transport emitted nothing for the AI SDK's `start` / `start-step` parts,
  so a live prefill was byte-identical to a dead socket. One keep-alive byte at
  stream open is what separates them.
- **Check the edge before raising any budget.** Nothing is written downstream
  while a pre-header probe runs, and the live `kortix.com` zone reports
  `proxy_read_timeout = 125` with `editable: false` (Free plan). Raising the
  probe past ~125s cannot work — Cloudflare 524s first. Measured, not assumed:
  `GET /zones/$ZONE/settings/proxy_read_timeout`.

**Enforcement:** `streaming.test.ts` sweeps request sizes 0–16 MiB and asserts
the resolver returns one constant, so no size can reproduce 90,000 again.
**Dead-telemetry corollary:** when a failure stops being reachable, delete the
metric that counted it. `kortix.probe_timeout` was left pinned to false on
every span — a dashboard built on it looks healthy by construction.
*Incident:* PR #6473, merged `7e8a56badaef80374a189e0e427a08eb06b44697`.

### A user-visible string is a shared resource; file ownership cuts through it (2026-08-18)

**When:** any change that renames a label, error message, remedy or flag name —
especially work split across parallel agents by file ownership.

Renaming the network-boundary flag from "Network boundary without Platinum" to
"Network boundary in-guest shim" touched EIGHT files: the feature-flag registry
(which is what the Feature-flags screen actually renders), two route error
bodies, a provisioning-error remedy, its test, two docs pages and the web
constant. An agent that owned only the web file renamed it there and nowhere
else. Nothing failed — no typecheck, no test, no lint — and the result would
have shipped a UI telling users to turn on a flag by a name the screen never
displays. The one guard that existed was a source-text assertion in a file the
agent did not own, which is what eventually caught a sibling change.

The rule: before renaming any user-visible string, grep the OLD string across
the whole repo (`--include='*.ts' --include='*.tsx' --include='*.md'
--include='*.mdx' --include='*.json'`) and change every hit in ONE commit. Then
grep it again and expect zero. A partial rename is worse than no rename: the old
name at least matched the UI.

Corollary for parallel agents: **file ownership is the wrong boundary for a
shared string.** Assign the whole rename to one agent, or do it yourself after
the fan-out lands. Two other same-shaped catches in the same batch — a test
pinning the exact `networkBoundaryEchoNotice(...)` call site, and one pinning
the exact `sudo -u kortix --` invocation — both lived in files the changing
agent did not own, and both only surfaced in CI. Reproducing CI's own command
locally (`pnpm --filter ./packages/** --filter ./apps/** … test`) found them in
one pass instead of one CI round-trip each.
*Incident:* PR #6511, caught in review before merge; two CI round-trips spent.

### `tests-release`'s own load can knock staging over, then the edge worker hides it as "maintenance" (2026-08-18)

**When:** running `pnpm test -- --target-full` (the `full suite + quality
gates` release gate) shortly after a fresh `main` → `staging` promotion.

Two consecutive attempts of the v0.13.0 release gate failed the same way, not
with flaky test assertions but with real `MAINTENANCE_MODE` 503s: 36
occurrences across a 40-minute window (15:11–15:51) in attempt 1, cascading
into unrelated failures across accounts, billing, admin-console and
sandbox-template journeys. `target-browser-full` finished in 2394.0s and
failed; `target-api-full` (439 flows, 1681 cases) never finished at all before
the 90-minute cap killed the job. `staging-api`'s own `/health` showed
`started_at` 21 minutes after the instability began — i.e. the backend task
itself went unhealthy and ECS replaced it mid-run.

The `MAINTENANCE_MODE` response is not a real maintenance flag — it is
`infra/cloudflare/workers/api-router/worker.mjs`'s `AUTOMATIC_MAINTENANCE`
fallback (`worker.mjs:251-273`): on ANY single fetch failure or 502/503/504
from the real origin, the edge worker rewrites that one response into a
generic "Kortix is temporarily unavailable... maintenance" 503, per request.
It is a reasonable UX choice for real end-user traffic, but it means a genuine
backend capacity problem during a test run is invisible in the log as "backend
overloaded" — it reads as "scheduled maintenance," which sent this
investigation looking for a deploy or a flag before the real cause (a single
staging ECS task under-provisioned for the full release suite's own real
concurrent traffic) was found.

**The rule: don't diagnose `MAINTENANCE_MODE` at face value.** Check whether
`X-Maintenance-Mode: blocking` correlates with the backend's own health/restart
timestamps before assuming an intentional maintenance window — it is far more
likely the edge worker masking a real origin failure. And: running the full
release suite immediately after redeploying the target it tests is a
self-inflicted-outage risk on a single-task environment — the fresh task has no
warm connection pools and no capacity headroom, and the suite's own real load
is enough to tip it over. Give staging-api real headroom (task count/size) for
release runs, or the gate keeps eating its own tail.
*Incident:* v0.13.0 release (PR #6520). Correction 2026-08-19: this entry was
written during attempt 5 of run 32151213430; **no attempt of that run has
passed** (attempts 3–6 and 8–10 failed, 2 and 7 were cancelled). The
maintenance-mode 503s were real but were not the dominant cause of the later
attempts (4 occurrences in attempt 10 vs 36 in attempt 1) — see the next entry.
Capacity fix not yet made — staging still runs this gate at capacity risk.

**Addendum (2026-08-19) — what the capacity audit found, and the durable fix.**
Three facts, none of them visible from the symptom:

- **Staging was smaller than dev.** `environments/staging/main.tf:98-103` ran
  the API at `512/1024`, `desired/min/max = 1/1/3`; dev runs `2/2/6` and carries
  no load. The environment that absorbs the heaviest load in the company had the
  smallest box, and its autoscaling ceiling was 3 × 0.5 vCPU = 1.5 vCPU total.
- **The single task was Spot with `base = 0`** (`modules/ecs-api/main.tf:506`)
  behind `deployment_minimum_healthy_percent = 100` (`:521`). One Spot reclaim
  empties the service and ECS cannot place the replacement until Spot capacity
  returns. Some of the "cascading failures" chased that night may have been
  reclaims, not load — and the edge laundered both into the same 503. **Any Spot
  service whose total unavailability is a real cost needs an on-demand base.**
- **The database tier lives outside Terraform.** The staging DB is hosted
  Supabase (`ujzsbwvurfyeuerxxeaz`), injected as `STAGING_DATABASE_URL`; a
  repo-wide grep for RDS/ElastiCache returns zero hits. The `ci_micro` →
  `ci_medium` resize therefore survives every apply AND is recorded by nothing.
  **A resource no plan can show is a resource only a runbook can hold** —
  `docs/runbooks/staging-sizing.md` now does.

**The Terraform trap this exposed, which generalises past staging:** the ecs-api
service carries `ignore_changes = [task_definition, desired_count]` and the
task-def carries `ignore_changes = [container_definitions]`, by design so CI
image rolls do not fight Terraform. `infra/scripts/ecs-deploy.sh` then renders
each new revision from the service's CURRENT one. So **changing `task_cpu` /
`task_memory` in Terraform registers a revision the service never adopts — the
apply is green and the live task never resizes.** Writing a size into Terraform
is not the same as a task running at that size; verify with
`describe-task-definition` on the service's live revision, never from the plan.
Fixed durably by having `ecs-deploy.sh` take ONLY `cpu`/`memory` from the
family's latest ACTIVE revision (Terraform's, right after an apply; its own
previous one otherwise) and everything else from the service's current revision
— so a resize propagates on the next deploy and is a no-op on every other one.
*Enforcer:* `worker.test.mjs` pins staging >= dev on cpu/memory/min_capacity,
pins `fargate_base_on_demand = 1` on both staging services, and pins the new
module variable's default at `0` so dev/prod strategies cannot move.

### A frontend deploy job that `needs:` an unrelated edge job ships a half-deployed staging, and the release gate then blames the code (2026-08-19)

**When:** `deploy-staging.yml` for `044d99480d` (v0.13.0 candidate),
run 32149212400, 2026-08-18 14:34 UTC.

The job `Wire Cloudflare staging DNS and Worker` failed at
`Deploy staging API router Worker`: Cloudflare returned **403** on
`PUT …/workers/scripts/staging-api-kortix-router` (credential rejected; the
same step passed on 2026-08-12 run 31635834664). Because `deploy-web-vercel`,
`verify` and `promote-staging-channel` all `needs:` that job, they were
**skipped** — while `Apply DB migrations`, `Deploy API + gateway (ECS)` and
`Deploy staging web to ECS` had already succeeded. Staging ended up with the
new API and the OLD Vercel frontend, and nothing failed loudly: the workflow
was red, but the API `/health` reported the right SHA and the release PR kept
re-running `tests-release` against it. Every attempt then lost 15/21 browser
journeys to "heading/control not found" (`Admin overview`, `Billing`,
`Sandbox templates`, `Apps`, `Feature flags`, `Switch workspace`, …) — strings
that all exist on `staging` — plus `LOGIN-2`, which drives `$WEB/cli/authorize`.
Ten attempts and two learnings entries were spent reading those as
capacity/flake before anyone opened the deploy-staging run.

**The rule:** before re-running a release gate, open the *deploy* run for the
`RELEASE_SOURCE_SHA` and confirm every job is green — an API `/health` SHA
match proves the API only. When a gate fails with many "element not found"
browser assertions at once and the API lane is mostly green, suspect a stale
frontend deploy first. Structurally: the Vercel/frontend deploy must not
`needs:` the Cloudflare DNS/Worker job (they are independent), and `verify`
must fail loudly on a frontend/API SHA mismatch instead of being skipped along
with its dependency. And rotate the Cloudflare credential used by
`deploy-staging.yml`; it stopped working between 2026-08-12 and 2026-08-18.
*Incident:* v0.13.0 release (PR #6520), run 32151213430 ×10; frontend deploy
skipped since 2026-08-18 14:34 UTC.


### One OAuth provider per concern; and shape-validating a redirect is not authorizing it (2026-08-18)

**When:** wiring any OAuth/identity flow, reusing an existing provider for a
second purpose, or writing any route that redirects somewhere a caller named.

"Link a GitHub account" died on dev with Supabase's
`{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}`.
Nothing had changed in the code. Linking a GitHub **App installation** to a
Kortix account was minting its identity proof through Supabase's
general-purpose "Sign in with GitHub" **login** provider — so an account/org
feature's uptime hung on a per-Supabase-project dashboard toggle that exists
for unrelated product login and that no IaC in this repo manages. Supabase
never authenticated anyone's org; it was an incidental token-minting detour.
Meanwhile the GitHub App's OWN OAuth client — whose `client_id`/`client_secret`
the manifest flow already captured and stored — sat unread in the codebase.

The rule: **one integration per concern.** Before reusing an auth provider for
a second purpose, ask what a failure of the first purpose does to the second.
If the answer is "takes it down," they must not share. Prefer the credential
the feature already owns over the one that happens to be nearby.

**The expensive part was the replacement, not the diagnosis.** The new route
took a `frontend_origin` query param, signed it into the OAuth state, and had
the callback redirect the exchanged GitHub user token to it. Validation was
`normalizeGitHubFrontendOrigin` — which checks the *shape* (https, or http on
localhost) and NOT that the origin is ours. Every attacker HTTPS origin
passed, so `?frontend_origin=https://attacker.example` exfiltrated a victim's
user-to-server token, replayable against the installation-linking endpoints
(CWE-601, HIGH — found by strix-security in review).

**Shape validation is not authorization.** That sentence is the learning. A
URL being well-formed, https, and parseable says nothing about whether you are
allowed to send a credential to it. An allowlist — or better, no parameter at
all — is the check.

And the near-miss inside the near-miss: an earlier commit in the same PR
"fixed the open redirect" by normalizing that param before an early
`oauth_not_configured` return. That closed the *smaller* hole and left the
primary exfiltration path fully open, while reading like a completed security
fix in the diff and the commit message. **When you fix a redirect bug, enumerate
every branch that emits a Location header and every value that can reach one**
— fixing the branch you happened to be looking at is how a HIGH survives a
"security fix" commit. The final fix deleted the parameter entirely: the state
now carries only `{nonce, exp}` and both routes always land on `frontendUrl()`,
so there is no caller-influenced redirect target left to re-trust later.

Corollaries, all paid for in this same change:

- **Config that lives only in a vendor dashboard will drift and nobody will
  know.** Grep proved no Terraform anywhere manages Supabase Auth providers;
  each environment is hand-toggled. A feature depending on such config has no
  gate that can catch its absence — the first signal is a user hitting a 400.
- **Assert the negative.** The ke2e flow that earned its keep asserts where the
  redirect must NOT go ("never contains the attacker origin"), not which reason
  code came back. A happy-path assertion passes an open redirect; only the
  negative one fails it. It also has to cover every branch separately — the
  unconfigured-OAuth branch needed its own case because which branch fires
  depends on deployment state.
- **A branch no test configuration reaches is untested, however green the run.**
  The open-redirect branch only fires when OAuth is unconfigured; unit tests,
  tsc, lint and hand-run curl (against a *configured* API) were all green on it.
- An App's OAuth callback is `callback_urls` in the manifest, a different field
  from `redirect_url` (post-creation only); and binding new state to
  `SUPABASE_JWT_SECRET` broke instantly because hosted deployments set
  `KORTIX_GITHUB_APP_STATE_SECRET` and no Supabase JWT secret. Reuse the
  resolver the neighbouring feature already uses rather than a same-shaped one.
*Incident:* dev "Link a GitHub account" down; fixed in PR #6526. Four defects
were introduced and caught inside that one PR — an open redirect, a token
exfiltration (CWE-601), a signing secret unset in this deployment, and a
missing manifest field — none by a static gate.

### A test lane that rewrites tracked files is a concurrent writer; never `git add -A` beside it (2026-08-18)

**When:** committing while any background job runs — especially a publish,
release, codegen, or packaging check.

Every CI job on PR #6526 suddenly failed in setup: API typecheck in 11s,
Frontend build in 20s, all three test workers under 70s, none of them running
a single test. The error was `ERR_PNPM_OUTDATED_LOCKFILE — pnpm-lock.yaml is
not up to date with packages/sdk/package.json`. Local runs stayed green
throughout, because the local tree was fine.

The cause: `pnpm test -- --packages-only` was running in the background while
a commit was made with `git add -A`. That lane's publish check temporarily
rewrites every publishable `package.json` — version to `0.0.0-local-test`,
and it strips fields such as `keywords` — then restores them when it finishes.
The blanket add captured that mutated state mid-run and committed four
packages pinned to `0.0.0-local-test` with no matching lockfile.

The rule: **stage explicit paths, never `git add -A`, when anything else could
be writing the tree.** Treat a test lane that mutates tracked files as a
concurrent writer with the same care as a parallel agent (see
[[shared-worktree-parallel-agent-wipe]] and
[[primary-checkout-may-be-parallel-work]]).

Two diagnostics worth keeping: **a whole-matrix failure in well under the
usual runtime is a setup failure, not a test failure** — read the install step,
not the test output. And **reproduce the exact CI step** (`pnpm install
--frozen-lockfile`) rather than the lane it belongs to; it fails in one second
and names the file.
*Incident:* PR #6526, one full CI cycle lost; caught by reading the install
step after the failure pattern (fast + everything) ruled out the tests.

### `CREATE INDEX CONCURRENTLY` under a 5-second `lock_timeout` cannot land on live prod (2026-08-19)

**When:** writing or applying any `.concurrent` migration; responding to a `55P03`
("canceling statement due to lock timeout") during `Apply DB migrations to prod`.

v0.13.0's deploy-prod (run 32248002434) failed its migration job twice, both times
on a `.concurrent` migration that did `set lock_timeout = '5s'` then
`create index concurrently …` — first on `kortix.iam_roles` (6 rows, 80 kB),
then on `kortix.account_tokens` (30k rows). The table size is irrelevant:
`CREATE INDEX CONCURRENTLY` has to wait for EVERY transaction in the database
that started before it (it takes a ShareLock on each one's virtual transaction
id), and `lock_timeout` governs that wait. On live prod — audit_events writers
on every request, multi-second session-turn transactions — some transaction
outlives a 5-second budget almost every time, so the CIC is cancelled and leaves
an INVALID index behind, which makes a plain re-run fail with "already exists".
The 2–5 s house value exists to keep DDL from blocking prod; CIC's wait blocks
nobody, so that rationale does not apply to it.

The rule: **in a `.concurrent` migration, set `lock_timeout` long enough for a
live system — 2–3 minutes — and note why in the file.** The one lock a CIC
holds (ShareUpdateExclusive on the table) only excludes other DDL/VACUUM; a long
wait on virtual transaction ids hurts no user.

Recovery when it has already failed (used twice tonight, ~2 min each):
1. `select indexrelname from pg_stat_user_indexes s join pg_index i on
   i.indexrelid=s.indexrelid where not i.indisvalid` — find the INVALID leftover.
2. `drop index concurrently if exists <it>`.
3. Hand-run the migration's exact statements in `psql` with
   `set lock_timeout='180s'; set statement_timeout='30min'`; confirm `indisvalid`.
4. `insert into kortix_migrations.pgmigrations (name, run_on) values ('<file
   basename without extension>', now())` — the ledger must match what is live.
5. `gh run rerun <deploy-prod run> --failed` — the migrate step sees nothing
   pending and the roll proceeds.
Migration files are immutable once merged (CI enforces it), so do not edit the
failing file; fix the template/house rule for the next one.
*Incident:* v0.13.0 deploy-prod run 32248002434, migrations
`20260819015724600_rbac_canonical_indexes.concurrent` and
`20260819015726000_account_tokens_session_id_index.concurrent`; ~30 min of
release delay. Prod also carries four pre-existing INVALID legacy indexes
(`public.idx_messages_*`, old Suna table) that predate this and were left alone.

### A redirect URI, a protocol handshake, and a cached catalog all break silently the first time a third party is real (2026-08-19)

**When:** integrating any third-party OAuth provider or remote MCP server;
building any flow whose success depends on what an external server accepts.

Kortix's generic OAuth2 connector surface passed its unit tests, its ke2e flow,
and a full local run. It had never completed one authorization against a real
provider. Three defects were sitting in it, and each one is invisible until a
third party refuses you.

**1. A redirect URI derived from the request is the wrong origin.** The
authorize route built the callback with
`new URL('/v1/connectors/oauth2/callback', c.req.url)`. Behind the load
balancer the API sees the *internal* origin, so dev emitted
`http://dev-api-ecs-fargate.kortix.com/v1/connectors/oauth2/callback` — plain
http, internal hostname. An authorization server byte-compares `redirect_uri`
against the registered value, so every real authorization would have been
rejected. Locally it looked perfect, because locally `c.req.url` *is* the
public origin. **A value a third party will compare against must come from
configuration (`KORTIX_URL`), never from the incoming request.** The same rule
covers webhook URLs, issuer strings, and audience values. Anything derived from
`req.url` is correct exactly until a proxy is in front of you.

**2. "Optional" in a spec means "mandatory" for some implementations.** MCP's
streamable-HTTP transport describes `initialize` → `notifications/initialized`
→ `Mcp-Session-Id`. Kortix posted a bare `tools/call`, which every *stateless*
server accepts — so it worked against the servers we happened to try. Servers
built on the official MCP SDKs default to **stateful** and answer anything
without a session id with `400 Bad Request: Server not initialized`. Read as a
generic 400, that looks like a malformed request, not a missing handshake.
**When a protocol describes a handshake, implement the handshake, even if your
first three test servers do not need it.** Two details that are easy to get
wrong and are load-bearing: the session cache key must include the
*credential* (or two principals share one server session), and `401`/`403` must
never be treated as a handshake failure and retried — those are credential
problems and belong to the caller untouched.

**3. A credential-dependent cache computed before the credential exists is
poison, and nothing recomputes it.** An MCP tool catalog is fetched *with* the
connector credential. Creating the connector before authorizing it therefore
recorded `status: 'error'`, `last_error: "MCP tools/list failed: HTTP 401"`.
Completing OAuth wrote the token and stopped. The user finished the flow, saw
"connected", and the connector still read **Error** with zero tools — the exact
failure the feature existed to remove, now with a success toast on top of it.
**Whenever a credential starts to exist, re-run everything that failed for want
of it.** Ask of any cache: which inputs can arrive *after* this was computed,
and what re-runs it when they do? Here the repo already had the helper
(`rematerializeCatalogAfterCredentialUpdate`); only the OAuth completion paths
never called it.

The meta-rule tying all three together: **an integration is unverified until it
has completed once against the real third party.** Not a mock, not a fixture,
not a conformant test double — the actual server. All three defects survived a
green suite; all three fell out within minutes of pointing the flow at
`api.read.ai`. Budget for one live end-to-end run before calling any
third-party integration done, and prefer a provider that implements the spec
strictly (dynamic registration, stateful sessions) as the one you test against.

*Incident:* found and fixed while building one-click OAuth 2.1 for MCP
connectors, PR #6579. No production outage — the surface had never been used
against a real provider, which is precisely why all three shipped unnoticed.

## Transcript shape alone may never end a turn — and every turn needs a record, whoever started it

Session/turn truth rules paid for on Essentia, 2026-08-20 (session `d1b74954`:
composer flapped "not running" over a visibly streaming session; a user prompt
delivered mid-turn was silently swallowed; PR #6657):

**1. A verdict that a turn is DEAD must be gated on the runtime's own busy
signal, not inferred from the transcript.** "A newer user message follows it"
and "its latest assistant message is completed" both read as terminal and both
occur mid-turn (prompts forwarded into a live turn; the step boundary while
tools run). The reaper cleared a streaming turn's authority at 12:48:51Z; its
step completed at 12:48:54Z. Rule: no terminal verdict while the root reports
`busy`/`retry`; an unreadable status is `unknown`, never terminal.

**2. Every runtime-initiated turn must be announced to the control plane.**
OpenCode starts turns nobody delivered (synthetic `<pty_exited>` wake-ups).
Anything keyed on "a control-plane prompt opened this turn" — `GET .../turn`,
the deadline grant, Stop — silently misses them. The daemon's `turn_begin`
relay + `adoptRuntimeSandboxTurn` close this; the general rule: when a new way
for work to START appears, audit every consumer of "is work running".

**3. A safety floor that DELETES its own retry state is a one-shot race.** The
orphan-redelivery age floor (30s) was checked once, and losing the check
cleared the record that was the only possible trigger — the user's prompt died
at age 27s. A guard that defers must leave the state it will need standing.

**4. An unnamed lifecycle event breaks every consumer keyed on the name.**
`readRootTurnState` bailed on a trailing user message, so turn-end relays
carried no `turn_message_id`: dedup vanished (double finalizes) and the strand
reconciler lost its key. When an identity read has a "give up" branch, list
what downstream keys on the identity before taking it.

*Automation:* flipped-expectation tests in `orphaned-turn-finalize.test.ts` and
`sandbox-reaper.test.ts` pin the incident timeline; `turn-begin-relay.test.ts`
and `integration-sandbox-turn-lifecycle.test.ts` pin the adoption contract.

## A release pipeline is only as green as its quietest dependency

Rules paid for during the v0.13.1 release-gate campaign, 2026-08-19/20 (the
gate had passed 0 of 18 runs in its history; 13 instrumented staging dry-runs
converted every hidden cause into a named fix; v0.13.1 then shipped through
the genuinely green gate — PRs #6622–#6648, release PR #6654):

**1. A failing job in a `needs:` chain silently freezes every dependent
deploy — probe credentials, and never let a janitor gate the payload.** The
`wire-cloudflare` job's Cloudflare key died on 2026-08-18 (403). Three jobs
`needs:`-depended on it, so every staging WEB deploy was skipped for a week —
the release gate drove an Aug-12 frontend against the current API, and the
resulting browser failures read as product bugs. Fix (#6626, #6639): the
non-essential job is `continue-on-error`, and the deploy step probes each
credential with a cheap authenticated read and uses the first one that works.
Rule: when a job fails REPEATEDLY and everything still "works", find out what
its `needs:` dependents silently stopped doing.

**2. Never replay a non-idempotent POST through an edge-laundered 5xx — the
origin may have committed.** The edge Worker turns any origin 5xx into a
synthetic 503 with no `x-request-id`. The ke2e client retried creates through
it, and the second send collided with the first send's committed row: 10
distinct gate failures reading `409 already exists` were the client fighting
itself (run 32306385663). Fix (#6628): POST is never replayed through an
ambiguous 5xx; bounded retries stay for reads; world-bootstrap creates retry
only with per-attempt-fresh identities (#6636, attempt-scoped run ids #6638).
*Automation:* `tests/unit/create-replay-safety.test.ts` injects the exact
laundered 503 and pins POST to one send while GET still retries.

**3. Never put a credential in a browser's global header set.** The Vercel
deployment-protection bypass secret sat in Playwright `use.extraHTTPHeaders`,
which Chromium attaches to EVERY request: it was transmitted to 16 third-party
hosts (Google, Facebook, DoubleClick…) on every run, persisted inside public
workflow trace artifacts, AND its presence in cross-origin preflights made the
API's CORS allow-list reject every browser API call — one line caused both a
credential leak and the entire 11-spec browser failure class (#6632). Fix: the
bypass is exchanged ONCE for a scoped `_vercel_jwt` cookie against the
deployment origin. Rule: scope every credential to the one origin that needs
it; treat `extraHTTPHeaders`/default-header config as a broadcast channel.

*Incident:* no production outage — the cost was ~22 hours of release paralysis
and one leaked secret (rotated). The meta-rule: a gate that has NEVER been
green is not protecting anything; each red must convert one hidden cause into
a named, enforced fix until green is the steady state.

## A relay that authenticates with the wrong credential fails silently, forever

Follow-up rule from the same 2026-08-20 turn-truth work (PR #6664), found only
because the merged fix was verified on deployed dev:

**A non-2xx that the caller merely retries-and-gives-up is indistinguishable
from a feature that was never built.** The new `turn_begin` relay used the
daemon's default token chain (`sandboxRelayContext()`), which prefers
`KORTIX_CLI_TOKEN` — a user/agent PAT — while the route it calls is
sandbox-identity-only. Every relay 403'd, twice, then gave up. On dev the
symptoms were a perfect alibi: opencode emitted the frames, the deployed
binary carried the new symbols, the env was complete, the root check passed,
and a hand-made POST with the sandbox credential returned
`{ok:true,outcome:'adopted'}` — while the ledger held zero rows. This is the
same failure class as the Essentia turn-end 403s that `r4.ts`'s kind-gate
comment already records; the sibling relay (`relayInitialTurnAcceptedToApi`)
had already established the correct pattern.

**Rules.**
1. When adding a sandbox→API relay, copy the CREDENTIAL choice from the
   nearest sibling of the same kind class, not the generic context helper.
   Sandbox-identity kinds (`turn_accepted`, `turn_abandoned`, `turn_begin`)
   resolve `KORTIX_SANDBOX_TOKEN || KORTIX_TOKEN` explicitly.
2. Never relay a credential you know the route will refuse — skip instead. A
   guaranteed 403 loop is worse than an absent feature: it looks like traffic.
3. **Test the wire, not the call count.** The tests that shipped this asserted
   "a POST happened" against a stubbed server. The test that catches it asserts
   the `Authorization` header. Any test that stubs HTTP must assert the
   credential and the URL, or it is only testing itself.
4. Pin the EVENT WIRING separately from the handler's behavior. A unit test
   that calls the relay directly proves nothing about whether the event that
   should trigger it is dispatched — capture a real frame from the deployed
   runtime and feed it through the real dispatcher.

*Incident:* no outage — the fix was simply inert in production for ~25 minutes
between merge and detection, which is exactly what dev verification is for.

## "Positive" is only half of what DER asks of an INTEGER — it must also be minimal

Found 2026-08-21 while chasing a ~4% flake in
`apps/kortix-sandbox-agent-server/src/egress-shim/shim.test.ts`, which turned
out to be a latent production defect in the egress shim's certificate authority
(`egress-shim/ca.ts`).

The serial number was built as `'00' + randomBytes(16)`, with a comment
explaining the leading zero: a first byte `>= 0x80` is read as two's-complement
NEGATIVE and the certificate is rejected. That is true, and it is not
sufficient. **DER requires an INTEGER to be minimal as well as correctly
signed: a `0x00` prefix is legal only when the byte after it is `>= 0x80`.**
When the first random byte came in below that, the zero was redundant and the
certificate was malformed — `BoringSSL … ASN.1 … INVALID_INTEGER` on the
handshake, and `openssl x509` unable to load the file at all.

It fired once in ~256 — the odds of `randomBytes()[0] === 0x00`, the case where
even node-forge's own normalization leaves a redundant zero behind. Every
sandbox mints its own CA and a leaf per terminated host, so roughly one sandbox
in 256 got an egress CA no client could parse, and every HTTPS call the agent
made through the shim failed.

**Rules.**
1. When hand-encoding an ASN.1 INTEGER, satisfy BOTH rules or neither is
   satisfied. Clamping a random leading byte into `0x01..0x7f` answers both by
   construction — never `>= 0x80` so no prefix is needed, never `0x00` so no
   prefix is redundant — at a cost of one bit out of 128.
2. **A 1-in-256 fault sampled probabilistically is a test that passes while the
   bug ships.** Export the encoding rule and pin it directly over the whole
   `0x00..0xff` leading-byte range. The bug survived a suite that minted a
   certificate on every run for months.
3. Filler bytes in a fixture can hide the fault. `00 00 ab …` is VALID (forge
   re-adds a zero `0xab` genuinely needs); `00 00 16 …` is not. Build the
   regression case from the bytes actually captured off the failure, not from a
   convenient repeated byte.
4. `tls.createSecureContext({ cert })` is lenient where `{ ca }` is strict — a
   probe that only passes `cert` will report a malformed certificate as fine.
   Diagnose with `openssl asn1parse`, which names the offending field
   (`prim: INTEGER :BAD INTEGER:[…]`) instead of failing the whole parse.
5. Treat a flaky test in a security-path suite as a defect report until proven
   otherwise. This one was dismissible as "TLS socket timing" for as long as
   nobody read the error text.

*Incident:* no outage reported — the defect was found through CI flake, not
through a customer. Roughly 0.4% of sandboxes would have had non-functional
agent egress with no diagnostic pointing at the CA.

## A browser must never be handed a 5xx for an expected state — an intermediary will replace it

Found 2026-08-20 while shipping per-port preview origins (PR #6681 + follow-ups).
A preview URL whose app had not yet bound its port returned Cloudflare's branded
"Error 502 Bad gateway" page after ~12s. The API was innocent of the *page*: it
had carefully built a friendly "port isn't responding" HTML body — and returned
it with status **502**, so Cloudflare discarded body and all and substituted its
own interstitial.

**The tell:** our `x-kortix-proxy-hop` header was absent from what reached the
client. A response of yours that arrives without a header you always set was not
passed through — it was swapped. Check for one of your own headers before
believing the status you see came from your code.

**The error was semantic, not numeric.** "The dev server has not bound the port
yet" and "the box is waking" are the ordinary first seconds of a preview, not
gateway failures. A 5xx is an invitation every proxy in the chain accepts.

**Rules.**
1. For a top-level browser navigation, an expected/transient state answers **200
   with a page that explains itself and retries**. Reserve 5xx for genuine
   failure. Identity states (401/403/404) are safe — intermediaries pass those
   through, and a monitor should see them.
2. Keep the truth machine-readable: non-navigation requests keep the accurate
   status, and the state travels in a header (`x-kortix-preview-state`) set on
   the HTML too, so probes lose nothing.
3. Decide by `Sec-Fetch-Dest`, not by status — an app's own `fetch('/api')` must
   never receive HTML.

**Corollary paid for in the same session — a mock that weakens a production
constant asserts an unreachable branch.** A file-share test mocked
`PUBLIC_SHARE_BLOCKED_PORTS` as EMPTY. The real constant contains the
static-file port, so the shipped code refused the very case the test "proved"
worked. When mocking a module for its collaborators, carry its CONSTANTS
verbatim; a constant is the production behaviour, not a fixture.

*Incident:* no outage — dev only, reported by the product owner and fixed the
same session. Both the path proxy and the new origin were affected, so the 502
had been reachable long before preview origins existed.

## OpenCode model references must name the runtime provider

Found 2026-08-24 while diagnosing prompts that failed after session startup.
The model catalog registered every gateway model under OpenCode provider
`kortix`. Session creation stored nested model IDs such as
`codex/gpt-5.6-sol` without that provider. OpenCode interpreted `codex` as the
provider and returned `ProviderModelNotFoundError`.

**Rules.**
1. Store every gateway-backed OpenCode model as `kortix/<wire-model>`.
2. Preserve nested provider paths. `codex/gpt-5.6-sol` becomes
   `kortix/codex/gpt-5.6-sol`.
3. Strip exactly one `kortix/` prefix before gateway routing.
4. Test managed, BYOK, nested Codex, and already-prefixed references together.

*Incident:* new sessions reached runtime readiness but their first prompt
failed because the stored model named a provider that OpenCode did not expose.

## A comment saying "this was tried and reverted" is a decision record — read it before you overrule it

Found 2026-08-21. PR #6692 "the inbox owns the queue" made the prompt-queue
admission gate HOLD every queued prompt for as long as the session held turn
authority, instead of forwarding it into the running turn. It shipped to dev at
03:10 UTC and was reported broken by the product owner the same day: an agent
working 9m21s sat on two prompts queued 8 minutes earlier, delivering neither.

**The change was made to fix Remove.** Forwarding into a live turn made
`DELETE .../prompts/:id` answer 409 within ~1s of a send, because OpenCode
parents each STEP on the newest user message, so the running turn adopted the
prompt almost immediately. Holding did fix that — and removed the reason the
queue exists: what you type while the agent works being WITH the agent, picked
up the moment the turn ends.

**The codebase had already said so.** `inbox-admission.ts` carried, in its file
header, *"Holding was tried and reverted: the user wants what they typed to be
WITH the agent immediately"*, and the delivery test asserted the same. The PR
noted that line and overruled it, and described the cost as losing *batch
answering* rather than as losing the queue's whole point.

**Rules.**
1. A comment that records a REVERT is prior art with an owner and an outcome.
   Overruling it needs the same evidence the original decision had — ask the
   person, or reproduce the failure it describes. A one-line acknowledgement in
   a commit body is not that.
2. State the cost in the user's terms, not the implementation's. "A batch is no
   longer folded into one model step" and "the queue no longer sends between
   turns" are the same change; only the second one is reviewable.
3. When a fix for control (Remove) costs behaviour (delivery), fix the control
   on its own terms. Here that is `reachedPlacement` calling a prompt "answered"
   as soon as any step parents on it — `cancel-forwarded.ts` can already take an
   unread prompt back out of the runtime.

**Verification that settles it, on deployed dev:** post prompt A (long task),
wait for `GET .../turn` to report a non-empty `turns` array — that array IS
`sessionHoldsTurnAuthority`, the predicate the hold read — then post prompt B and
sample `GET .../prompts`. Held looks like `{state:'waiting',
reason:'turn_active'}` for the whole turn. Correct looks like `delivering` inside
2s and gone from the inbox while `turns` is still non-empty. Measured on
`acce6fbe22`: `delivering` at t+1.8s, gone at t+9.5s, turn still open.

*Incident:* dev only, ~14h from merge to revert. Reverted by PR #6699
(`acce6fbe22`), which restores the six queue files byte-for-byte to the
pre-#6692 tree and keeps only the two changes that touch no queue behaviour —
the non-transitive `compareMessagesForDisplay` fix, and the Remove toast reading
`error.status` instead of regexing `/409/` against `error.message` (that regex
could never match, so a 409 and a 404 rendered the same dead-end string, which is
why Remove looked like it simply never worked).

## A limit larger than the thing it protects is not a limit — and a rendered file is not a deploy

2026-08-21. The dev API was OOM-killed three times in eleven minutes (`exit 137`,
"OutOfMemoryError: container killed due to memory usage") during an image-heavy
agent session. Cloudflare answered the dead origin with its own page, so the
product showed **"Bad Gateway · Retrying in 53s"** and everyone — including me —
went looking for a code regression in the LLM gateway. There wasn't one.

**Diagnosis, in the order that worked.** `/v1/health` was failing 10–40% with
`server: cloudflare` and NO `x-kortix-*` or `x-amzn-*` header, so the response
never came from our code. That route runs no database query and no gateway
logic, which eliminated every application-level suspect at once. ECS then named
it outright: `exit 137`, three times.

**The metric that proved it was provisioning, not a regression.** Daily maximum
memory held a 65–70% band for ten consecutive days and broke it only that day
(85.5%) — while the AVERAGE stayed at ~37%, unchanged all month. *Peak without
drift is a few large allocations, never a leak and never load growth.* Learn to
read that pair; it is the whole diagnosis in two numbers.

**Three compounding causes, each its own rule.**

1. **A ceiling above the container is decoration.** `DEFAULT_MAX_REQUEST_BYTES`
   was 1 GiB inside a 1024 MiB task and a 640 MiB self-host container — a single
   *permitted* request could exceed all the memory there was. A request-size cap
   is only meaningful as a FRACTION of process memory.

2. **Bounding one request is not bounding memory.** Per-request caps with
   unbounded concurrency still OOM; the crash just arrives later. Memory must be
   `O(concurrency)`, because concurrency is the only term a scaling policy
   controls. Shed with `503 + Retry-After` — a refusal costs one request, an OOM
   costs every request in flight plus the container. And a 503 is a pressure
   signal the autoscaler can SEE; an OOM looks like a task that stopped existing.

3. **Autoscaling on averages cannot see a single-task peak.** All three policies
   (average memory 70%, average CPU 60%, requests/target 600) sat idle through
   all three kills: the mean never moved, and requests peaked at 461 of 600.
   Alarm on `MemoryUtilization / Maximum`, never only `Average`.

**A rendered file is not a deploy.** A self-host `docker-compose.yml` is written
ONCE. `kortix self-host update` re-renders it, but the background
`kortix-updater` container only pulls images — so a box kept current by the
updater freezes its memory limits at the original render. Measured: a box
rendered while `llm-gateway` was a literal `512m` still had 512m months later,
straight through the update that raised the default to 2048m. **The fix shipped
and could not land.** `kortix-api` escaped only because it happened to be
`${KORTIX_API_MEMORY_LIMIT:-640m}` and could be moved from `.env`.

**The rule that follows: derive limits from reality, don't write them down.**
The process now reads its own cgroup limit at boot and takes a fraction. A stale
render becomes harmless, and more container memory becomes more throughput with
nothing to re-render.

**Corollary — parity is a safety property.** Dev ran `task_memory 1024` while
prod and staging ran `4096`, unchanged since at least Aug 15. Dev was the only
place this could surface first, and it surfaced in a founder's live session.

*Incident:* dev + one self-host box; no production impact (prod predated the
change). Fixed by #6705 (ceilings), #6708 (bounded memory + admission control),
#6712 (self-sizing). Verification that settles it: drive 60 concurrent 8 MiB
bodies at the REAL mounted routes and assert most are shed, every response is a
real status, no `unhandledRejection`/`uncaughtException`, and the process still
serves afterwards with the budget released.

## Size database pools for the rolling fleet, not the steady fleet

2026-08-22. A production API deployment overlapped 10 old ECS tasks with 10 new
tasks. PostgreSQL returned SQLSTATE `53300` because the tasks could request more
connections than the server exposed. Authorization, audit ingestion, project
reads, turn streams, webhooks, and lifecycle settlement then failed together.
The queries were collateral failures. They were not six separate defects.

**The arithmetic that failed.** PostgreSQL exposed 240 connections and reserved
3 for superusers. Each task allowed 15 main-pool connections, 3 audit-pool
connections, and 1 leader-election connection. Twenty overlapping tasks could
therefore request 380 long-lived connections against 237 usable slots. The old
comment counted only 10 steady-state main pools. It excluded the rolling overlap
and every secondary pool.

**The rule.** Bound connections against the maximum rolling fleet. Count every
long-lived pool and every concurrent startup probe. Reserve explicit capacity
for Supabase, operators, migrations, and request-scoped clients. A steady-state
calculation is invalid for a service with `deployment_maximum_percent = 200`.

**The enforcement.** `apps/api/src/shared/database-capacity.test.ts` pins the
production server limit, ECS maximum capacity, rolling overlap, main pool,
audit pool, leader connection, startup probe, and non-API reserve. The test
fails when the API connection ceiling exceeds the available application budget.
Any change to pool size, task capacity, deployment overlap, or PostgreSQL size
must update and pass this invariant before deployment.

*Incident:* production, SQLSTATE `53300` from 01:15:10Z through 01:16:37Z.
Verification that settles it: deploy the bounded pools, confirm the exact
production SHA, exercise webhook and session traffic, then query Better Stack
for zero new SQLSTATE `53300` occurrences after the rollout completed.

## Admission after allocation is accounting, not admission

2026-08-22. A 28.37 MB multimodal request repeatedly OOM-killed a 512 MiB
standalone gateway. The existing in-flight budget did not protect the process.
Both gateway hosts called `readBoundedBody()` before `InflightBudget.admit()`.
Concurrent requests therefore allocated complete JavaScript strings before the
budget could reject them. The hosts also released the lease when the handler
returned a streaming `Response`. Parsed request data could remain reachable
until the response stream ended.

**The rule.** Reserve declared bytes before the first body read. Grow a chunked
request's reservation before retaining each chunk. Hold the lease until response
EOF, error, or cancellation. A test that asserts only `503` counts does not prove
a memory bound. It must assert allocation order and lease lifetime.

**Remove amplification sources before raising memory.** The same request existed
as HTTP chunks, a JavaScript string, a parsed object, an AI SDK request graph, a
serialized provider payload, and trace capture. The gateway now clears the raw
string after parsing, uses direct `fetch` for OpenAI-compatible providers, loads
protocol translators lazily, retains no response body, and stores metadata-only
traces. A container memory increase can raise throughput. It cannot repair an
unbounded allocation path.

*Incident:* Essentia standalone gateway, repeated cgroup OOM kills and Caddy
`502 Bad Gateway`. Enforcement: `readAdmittedBody` allocation-order tests,
response-lifetime lease tests, one-dispatch tests, and a mounted 28 MiB request
test that asserts one provider call and an intact response.

## A standalone service needs explicit caller wiring in every environment

2026-08-22. The API stopped hosting an in-process gateway and became a reverse
proxy. Self-host Compose configured `LLM_GATEWAY_PROXY_TARGET`. Dev ECS did not.
The gateway deployed healthy at the correct SHA, but the API returned
`gateway_unavailable` for every LLM route. The edge converted that origin `503`
into `MAINTENANCE_MODE`, which hid the missing environment variable.

**The rule.** A service extraction is incomplete until every caller in every
deployment topology has an explicit target. Configure local, self-host, dev,
staging, production, and shadow environments in the same change. Verify through
the caller route. A healthy callee does not prove that its caller can reach it.

**The enforcement.** Terraform now injects `LLM_GATEWAY_PROXY_TARGET` into each
cloud API task. The end-to-end verification calls `/v1/llm/health` through the
API origin and requires the standalone gateway health response.

*Incident:* dev API returned `gateway_unavailable` after gateway PR #6737.
The public edge surfaced it as blocking maintenance. Direct origin inspection
identified the missing target before user traffic resumed.

## Two dev stacks on one shared DB share one work queue

2026-08-22. A `timeline-parity` worktree session's first prompt died inside
OpenCode with `Cannot connect to API …
subdivision-marine-acne-shorter.trycloudflare.com/v1/llm-gateway/v1/chat/completions`.
That host belonged to a different worktree (`mw-perf`) whose quick tunnel had
rotted. Both worktrees reuse the primary local Supabase, so prompt-inbox
delivery, session-lifecycle commands, and sandbox env sync form ONE queue.
`mw-perf`'s API grabbed the job, pushed its `KORTIX_URL`-derived gateway URL
into the other worktree's sandbox, and forwarded the prompt. The owning
worktree's log showed no env sync and no prompt POST, so nothing local
explained the failure.

**The rule.** A sandbox's gateway URL and credentials must come from the
instance that owns the sandbox, never from whichever instance dequeues work.
In local development, run one stack against the shared DB, or create the
worktree with `--db`. When an OpenCode error names a host, grep EVERY stack
log on the machine for that host before suspecting the branch.

**Second incident, same night (~23:00 UTC).** Same worktree, same symptom,
different culprit: the PRIMARY `pnpm dev` stack on `:8008`. Its quick tunnel
(`patches-….trycloudflare.com`) had died; its 1 s lifecycle drain tick still
claimed the worktree's queued prompt, its env sync pushed the dead
`patches…/v1/llm-gateway` URL into the worktree's sandbox, and OpenCode failed
the turn with `Cannot connect to API`. The worktree's log again showed no env
sync and no prompt POST. Two instances in one evening proves this is the
default failure mode of a shared DB, not a one-off.

**The enforcement.** Two layers, both shipped:
1. `pnpm worktree start` (`scripts/worktree/cli.ts`, `warnOnSharedDbCrosstalk`)
   warns at start when another stack is live on the same database, names it,
   and states the remedy.
2. **Instance scoping is the product fix.** `KORTIX_INSTANCE_ID`
   (`apps/api/src/config.ts`, optional, unset in every deployed env) is set by
   the launchers only: `scripts/dev-local.sh` exports `primary`,
   `scripts/worktree/lib/launch-env.ts` exports the worktree name.
   `provisionSessionSandbox` stamps `session_sandboxes.metadata.instanceId`;
   `sandboxBelongsToThisInstance()` (`apps/api/src/projects/instance-scope.ts`)
   is consulted by the lifecycle drain (`drainSessionLifecycleQueue` RELEASES a
   claimed command whose sandbox another instance owns — `queued`, due in 2 s,
   attempt given back, never dead-lettered), by the env-sync project fan-out
   (`propagateProjectSecretsToActiveSandboxes` skips foreign boxes), by the box
   reaper (`reapAndReconcileSandboxes` skips them) and by Platinum's
   `listManagedRunningSandboxes` (`kortix.instance` marker beside `kortix.env`).
   Unset id, or a row with no stamp (legacy), means "mine" — a strict no-op in
   production and never a stranded sandbox. HTTP-path work (proxy, `/start`,
   `prompt_async`) is deliberately unscoped: the browser talks to one stack on
   purpose.

*Incidents:* session `b090016e…` on worktree `timeline-parity` (20:16 UTC,
`mw-perf`'s dead `subdivision-marine-acne-shorter` tunnel) and the same
worktree at ~23:00 UTC (primary `pnpm dev`'s dead `patches…` tunnel); in both,
prompts after the owning instance's own env sync succeeded.

## Every stack launcher needs the tunnel watchdog, not only `pnpm dev`

2026-08-22. The `timeline-parity` worktree's quick tunnel died three times in
one evening (30 min – 3 h after mint). The symptom in the session UI was
OpenCode `Retrying in 81s · #1 · <none>` — Cloudflare's HTML 530 carries no
message — or `Cannot connect to API …trycloudflare.com/v1/llm-gateway` on the
first prompt. The local API was healthy each time. `scripts/dev-local.sh` had
a watchdog that rotates a dead tunnel and bounces the API; the worktree
launcher (`scripts/worktree/cli.ts`) did not, so every death needed a hand
restart and a new `KORTIX_URL`.

**The rule.** A component that bakes a public callback URL at spawn must own
the liveness of that URL. Any launcher that mints a quick tunnel ships the
watchdog with it: probe the URL while the local API is healthy; on death,
mint a new tunnel and respawn the API with the new URL; say so in the log.
Diagnose a `<none>` retry row by `curl $KORTIX_URL/v1/health` (530 = dead
tunnel) and `pgrep -f 'cloudflared tunnel'`.

**The enforcement.** `pnpm worktree start` now runs `startTunnelWatchdog`
(60 s tick, two-probe confirmation, cloudflared exit detection, API respawn
with the new `KORTIX_URL`). The worktree launcher gets the same tunnel
watchdog as `pnpm dev`. Proven by killing cloudflared on a live stack and
watching the rotation (PR #6755).

*Incident:* session `b090016e…` / `cbde77cf…` on worktree `timeline-parity`,
three tunnel deaths, each surfaced as an OpenCode retry loop.

## A credential boundary cannot depend on a feature flag

2026-08-22. Session provisioning could advertise a direct upstream Git origin
when `KORTIX_GIT_PROXY` was false. The sandbox daemon then called
`/projects/:id/git/clone-credential`, which returned the raw upstream token.
The proxy path was secure, but an environment flag could restore credential
delivery into every sandbox.

**The rule.** A server-side credential boundary is unconditional. Runtime
clients receive one session credential and a Kortix proxy URL. No feature flag,
compatibility endpoint, or generic authorization-header helper may expose or
attach an upstream credential inside the sandbox.

**The enforcement.** Session provisioning and project serialization always use
`/v1/git/:project.git`. The clone-credential route no longer exists. The daemon
rejects direct network Git origins and builds auth headers only for `/v1/git/`.
Route coverage pins the endpoint removal. Daemon tests pin direct-origin denial.

*Incident:* a sandbox environment audit found four Kortix token aliases and
provider credentials. The Git compatibility path could also return a raw Git
provider token to the sandbox.

## Never resolve a merge inside a worktree whose API runs `--hot`

2026-08-22. `git merge origin/main` was run inside `suna-timeline-parity`, the
worktree that served the user's live test stack (`bun --hot` API, Next dev
web). The merge stopped on conflicts, the tree held conflict markers, and the
hot-reloading API picked them up (`tsc`: `TS1185: Merge conflict marker
encountered` in `r4.ts`) while the user was testing. `git merge --abort`
restored it within a minute; no sandbox was lost.

**The rule.** A worktree that serves a live stack is read-only to git
operations that can leave the tree in a non-compiling state: merges with
possible conflicts, rebases, cherry-picks, checkouts of other branches.
Resolve in a scratch worktree on a sibling branch, run the gates there, then
`git merge --ff-only` inside the live worktree so it only ever moves between
two consistent trees. Fast-forward is the only git write a live worktree
should see — and a fast-forward that moves `apps/kortix-sandbox-agent-server`,
`apps/cli`, or `apps/kortix-app-runtime` source must be followed by the same
artifact builds the launcher runs at start (`pnpm --filter` build for the
agent server and CLI, `bash apps/kortix-app-runtime/build.sh`), or every new
session fails provisioning with `kortix-agent dist binary … is older than its
source` (seen 2026-08-22 21:41 right after the ff; rebuilt, sessions booted
again).

**The enforcement.** The integration-branch memory note names the rule; the
scratch-worktree-then-ff sequence is the procedure
(`timeline-parity-main-merge` → `git merge --ff-only`). Candidate for a
`pnpm worktree` guard: refuse `merge`/`rebase` in a slot whose API port is
listening unless `--ff-only`.

*Incident:* `timeline-parity` worktree, 2026-08-22 ~21:35 UTC, ~60 s of
`tsc` errors on the live API; aborted, re-done in `tp-main-merge`, ff'd.

## A cancelled deploy-dev can advertise a SHA it never promoted, and the next run then skips that surface

2026-08-23. `deploy-dev` run 32605966965 (`e6c4ba0b62`, an `apps/web`-only
change) was cancelled by a newer merge while in flight. Its per-surface jobs
did not all die together: `Build frontend image` and `Deploy frontend to dev
(ECS Fargate)` both reported `success`, while `Move :dev → this build
(frontend)` and `Verify canonical Dev frontend on ECS` were cancelled. The next
run (32606271039, `dbe5999884`) resolved the deploy base and logged `Comparing
changed surfaces against deployed dev SHA e6c4ba0b62…` — the SHA the cancelled
run had advertised — concluded the frontend was current, and printed
`Build frontend image (amd64): skipped` / `Deploy frontend to dev: skipped`.
`https://dev.kortix.com/api/health` still reported `commit 2ff469ed`'s
predecessor at that moment. A later unrelated merge happened to touch the
frontend and carried the stranded change out; nothing in the pipeline would
have.

**The rule.** "The next push re-picks-up your still-stale surface" is only true
while the staleness probe reports what is actually SERVING. A cancelled run can
move the probe's answer past a surface it never promoted, and every later run
then reads that surface as fresh. After a cancelled `deploy-dev`, never assume
the next merge carries your surface — read the cancelled run's PER-JOB
conclusions, and if the `Move :dev` / `Verify canonical` step for your surface
was cancelled, force it: `gh workflow run deploy-dev.yml -f surface=all`.

**The enforcement.** Verify by ARTIFACT CONTENT, never by run conclusion or by
`/health` alone: fetch the deployed surface and grep it for a string only your
change introduces. For `apps/web`, load the route in a browser, collect
`performance.getEntriesByType('resource')` `/_next/*.js`, fetch each and assert
both the string your change ADDS and the absence of the one it REMOVES — the
pair is what distinguishes "deployed" from "an older bundle that happens to
contain a similar token". Candidate pipeline fix: make the deploy base come
from each surface's own live artifact, and never let a surface's SHA advance
past its `Move :dev` step.

*Incident:* PR #6764, merge `e6c4ba0b62`, 2026-08-22 23:43 UTC. No outage —
a frontend-only fix sat undeployed on dev for ~25 minutes while both the run
list and the deployed-SHA probe read as healthy.

## Update every generated Dockerfile when the sandbox runtime changes

2026-08-23. A fix changed the canonical sandbox Dockerfile, but self-hosted
template builds continued to fail. The live builder rendered its Dockerfile
from `packages/shared/src/sandbox/dockerfile-layer.ts`. The fast and meta
renderers also retained the failed command.

**The rule.** A sandbox runtime command change must update the canonical
Dockerfile and every generated Dockerfile. A passing canonical Dockerfile test
does not prove the remote template build path.

**The enforcement.** The layer, fast, and meta renderer tests assert
`pnpm root -g`. Each test rejects `pnpm list -g`. Golden snapshots make the
live layered Dockerfile change visible in review.

*Incident:* a self-hosted project template rebuild repeated the retired
OpenCode package lookup after the canonical image fix deployed.

## Resolve a pnpm global binary from its installed shim target

2026-08-23. `pnpm root -g` failed under pnpm 11.15.1 after a successful global
install. `PNPM_HOME` and pnpm's configured global-bin directory resolved to
different paths. The generated `opencode` shim still executed version 1.18.19,
but the following package-root lookup exited non-zero.

**The rule.** Runtime image builds must not infer pnpm's versioned global-store
layout. When a native binary must outlive its package-manager shim, read the
installed shim's `cmd-shim-target` metadata and validate that exact target.

**The enforcement.** The canonical, layer, fast, and meta Dockerfile tests pin
`cmd-shim-target` resolution. They reject both `pnpm root -g` and the older
`pnpm list -g` lookup.

*Incident:* the live E2B build installed OpenCode 1.18.19 and printed its
version, then failed before the native-binary assertion.

## Missing managed runtime binaries are recoverable drift, not an unreadable runtime

2026-08-23. Existing sandbox disks created before the managed OpenCode link
could update their CLI and agent, but never became ready. Runtime convergence
treated an unreadable OpenCode health endpoint as a busy or transient runtime.
The required managed binary did not exist, so the endpoint could never recover.

**The rule.** Distinguish a missing managed binary from a temporarily
unreadable process. Install and restart when the managed link is absent. Defer
when the managed link exists but the process cannot report its version.

**The enforcement.** Runtime convergence tests cover both states. A missing
managed link installs the manifest version and restarts OpenCode. An existing
link with unreadable health performs no install and no restart.

*Incident:* old session disks remained in `runtimeReady=false` after a runtime
upgrade because OpenCode convergence reported `opencode did not report its
version` on every start.

## A transcript list must never carry attachment bytes

2026-08-24. On a self-host, sessions with hundreds of agent image reads stopped
rendering. Every file part carried its whole file as a `data:` url, so
`GET /session/:id/message?limit=20` weighed 7–19 MB. The SDK's 30 s fetch
deadline killed the read at exactly 30.00 s, the tail retry re-issued it, and
the browser downloaded tens of megabytes for a screen that never painted. The
same read answered inside the sandbox in 276 ms; the bytes leaving the sandbox
were the entire cost.

**The rule.** The message list carries a *reference* to an attachment — type,
mime, filename, id — never its bytes. Bytes are served per part, on demand,
`immutable` with a strong ETag. Strip at the daemon (the source) AND at the
API proxy (for sandboxes on an older daemon image); a reference is not a
`data:` url, so the two passes compose.

**The enforcement.** `kortix-sandbox-agent-server/src/__tests__/attachment-strip.test.ts`
drives the real Hono app end to end: the list carries the reference, the part
endpoint returns the exact bytes, 304 on ETag, 404 on unknown, and the
single-message read is NOT stripped. `apps/api/src/sandbox-proxy/inline-attachments.test.ts`
pins the pure transform, including "unrecognised payload passes through
untouched" — the strip runs on every response on that path and must never be
the reason a read fails.

*Incident:* essentia `5306fd8d`, five consecutive reads at 29.23–30.08 s,
78 MB transferred, nothing rendered. PR #6829.

## A wake budget is a deadline, not an attempt count

2026-08-24. Auto-resume was three attempts spaced 1500 ms — about three
seconds — and a self-host's E2B resume takes 8.0–8.8 s. Every healthy sleeping
box ran out of budget mid-wake, and the page replaced its loader with
"session <id> is stopped — open a new session to continue" moments before the
same box came up. Users read it as "all my sessions are broken".

**The rule.** Anything that waits for a machine to boot is bounded by a
deadline measured from the first observation of the resumable box, never by
how many times we asked. A count describes our retry spacing, not the machine.

**The enforcement.** `apps/web/src/features/session/session-resume.test.ts`
asserts `AUTO_RESUME_WINDOW_MS >= 60_000` and that a null clock is
"just started", not "expired".

*Incident:* essentia, every stopped session, 2026-08-24. PR #6827.

## Sandbox-isolation guards read the agent binding, never the caller's session id

2026-08-24. 43 `backend`-origin sessions in one project were listed in the
sidebar and every `/start` answered 404. `isSessionTargetVisibleToCaller`
narrowed on `callerSessionId`, which `resolveSupabaseAuth` sets to the
Supabase LOGIN session id for every signed-in human — non-null, and never a
Kortix session id — so every human failed the sibling check meant for sandbox
credentials. The same regression had already been fixed for the
manager-override gate and documented in its test; the remedy was not carried
to this guard.

**The rule.** A guard that asks "is this caller a session-bound credential"
reads `boundCredentialSessionId` (`callerKortixSessionId(c)`: null for a
browser JWT, the real id for anything bound). `callerSessionId` cannot answer
that question.

**The enforcement.** `apps/api/src/__tests__/unit-connector-share.test.ts`
pins a human with a login session id passing, a sibling sandbox credential
still blocked, and the own-session credential still allowed.

*Incident:* essentia project `e7170bf8`, origin counts user 568 / backend 43.
PR #6828.
## Measure the amplification factor; never decode what you can forward

2026-08-24. The gateway's ai-sdk transport decoded every `data:` image with
`atob(raw).split('').map(c => c.charCodeAt(0))` — one JavaScript string per
byte, 89 MB resident for a 6.7 MB image — and then let provider-utils re-encode
the bytes through a `String.fromCodePoint` concat loop. The admission budget
charged 3x per wire byte on the assumption that the parsed graph was the only
copy. Both `@ai-sdk/anthropic` and `@ai-sdk/amazon-bedrock` accept a base64
STRING and serialize it through the identity `convertToBase64`.

**The rule.** A passthrough forwards bytes in the encoding it received them.
Before charging a memory budget, measure the real peak with a mounted request
through the real handler and write the number next to the constant
(`memory-envelope.test.ts`: 2.25x openai-compat, 2.9x anthropic, 0.61x steady
state on 2026-08-24). A budget factor without a measurement is a wish.

**Bound the inputs a client can grow without limit.** A screenshot-per-step
agent re-sends every screenshot on every turn. Providers already cap images
per request (Bedrock Converse: 20). The gateway keeps the newest 12 of >20 and
replaces older ones with a one-line notice, with hysteresis so the prefix
stays cache-stable for 8 turns.

*Incident:* Essentia 2026-08-22, 40-screenshot / 28 MB request, cgroup OOM.
Enforcement: `memory-envelope.test.ts` (peak factor < 6x, all 40 images
forwarded byte-for-byte on both routes), `image-window.test.ts`.

## A re-framed body must not carry the provider's framing headers

2026-08-24. The gateway forwarded `upstream.headers` unchanged on both response
paths. `fetch` had already gunzipped the provider body and the gateway
re-materialized it (a string, or a relayed stream), but the response still
said `content-encoding: gzip` with the compressed `content-length`. The API
reverse proxy's `fetch` threw `ZlibError` on every non-streaming completion
and answered `502 gateway_proxy_unreachable` while the gateway itself had
logged a 200. Caddy on a self-host box passes the same pair straight to the
client.

**The rule.** When a proxy decodes or re-frames a body, it owns the framing.
Strip `content-encoding`, `content-length`, `transfer-encoding` and the
hop-by-hop set (RFC 7230 §6.1) before forwarding; keep everything else.
`curl` without `--compressed` ignores `content-encoding`, so a curl-only
check passes while every `fetch`-based client fails — test through the real
next hop.

*Incident:* local stack, found during the passthrough e2e for the memory work
above; the same code is live on dev. Enforcement: `simple-handler.test.ts`
"drops wire-framing headers", `passthroughHeaders()` on all three response
paths.

## The edge never rewrites an origin error

2026-08-24. The `api-router` Worker replaced every origin 502/503/504 with a
synthetic `503 MAINTENANCE_MODE` "Service maintenance" page. On dev, 5 of 8
non-streaming completions were failing with a gateway content-encoding bug
(origin 502) and every user, log line and OpenCode retry classifier saw
"Kortix is temporarily unavailable" instead. The gateway's own health showed
`errors: 0` and 3.6 h of uptime: nothing was in maintenance and nothing had
crashed.

**The rule.** A proxy passes the origin's status, body and headers through
unchanged. The only synthetic error it may produce is for an origin it could
not reach at all, and that response names itself (`502 origin_unreachable`,
`X-Origin-Status: fetch-error`, `Retry-After`). A maintenance page comes only
from an explicit admin state. When a proxy catches an exception, the response
carries the exception class and message (`gateway_proxy_error` with `cause`
and `detail`), not a generic "unreachable".

*Incident:* dev, found while verifying the gateway passthrough work above.
Enforcement: `worker.test.mjs` origin-passthrough tests; `wire.ts` proxy
error envelope.

## Shedding load only works if you also stop the upload

2026-08-24, found by stress-testing the gateway in its real container. Three
separate defects, each of which alone breaks the "never OOM, never 502"
promise, and none of which unit tests could see:

1. **A refused request keeps arriving.** Admission correctly returned 503 for
   60 concurrent 27 MiB uploads and the 2 GiB container was OOM-killed anyway:
   ~1.3 GB of refused body was still buffered on the way in. A rejection must
   `cancel()` the request body, not just answer.
2. **A client that vanishes mid-upload strands its reservation.** Bun never
   settles a pending `reader.read()` on abort, so the read awaited forever
   holding the lease. One aborted 2.8 MB upload leaked 8,521,827 reserved
   bytes permanently; enough of them and an idle process 503s everything.
   Cancel the reader from an `abort` listener.
3. **An amplification constant measured on ONE request is wrong.** Isolated, a
   27 MiB request peaks at 2.3x. Under concurrency the transients overlap and
   GC lags, and 3x OOMs. The default is now 6x.

**The rule.** Test admission control with a real container under a real memory
limit and hostile clients — overload, abort storms, slow consumers. A unit test
that asserts "returns 503" proves nothing about survival: all three defects
above passed every unit test in the suite. Assert the process afterwards:
`OOMKilled=false`, `RestartCount=0`, and the admission counter back at zero.

*Evidence:* 1074/1074 200s at 12 rps mixed (p99 0.32s, peak 322 MiB/2048, no
leak); the 60x27 MiB overload that killed the container now peaks at 827 MiB
and stays healthy. Enforcement: `read-bounded-body.test.ts` abort cases,
`memory-envelope.test.ts` backpressure case.

## A sandbox model failure is a version question before it is a code question

Found 2026-08-25 on the Essentia box. Native-mode sessions on
`amazon-bedrock/global.openai.gpt-5.6-sol` failed every reasoning stream:
`Type validation failed` on `contentBlockDelta.delta.reasoningContent.redactedContent`.
The first diagnosis blamed an "old SDK in the opencode fork" and planned a
fork patch. `github.com/sst/opencode` redirects to `anomalyco/opencode`; it is
upstream. Upstream had already fixed the crash (anomalyco/opencode#43686 →
#43909, `@ai-sdk/amazon-bedrock` 4.0.112 → 4.0.158, first release v1.18.22).
Our pin in `packages/shared/src/runtime-versions.json` was 1.18.19.

**Rules.**
1. For any failure inside the sandbox runtime, read the pinned OpenCode
   version first, then the dependency pins of that exact tag
   (`raw.githubusercontent.com/anomalyco/opencode/v<tag>/packages/opencode/package.json`)
   and the upstream issue tracker. Diagnose code only after the pin is current.
2. Bump OpenCode through the lockstep sites only: `runtime-versions.json`
   (`opencode` + `opencodeSdk`), `packages/sdk/package.json`
   (`@opencode-ai/sdk`), and the shared Dockerfile goldens. The Dockerfile,
   the runtime-assets manifest, and the plugin pin read the JSON.
3. Audit the upstream diff between the two tags for `packages/opencode/src`
   before merging; record behavior changes that touch the daemon (turn
   termination, retry classification, provider transforms).
4. Do not rebuild sandboxes to propagate. The manifest states the version;
   the daemon converges idle-only and restarts opencode. Verify on one old box:
   `GET <sandbox_url>/global/health` reports the new version and
   `/opt/kortix/runtime-assets-state.json` records it.

*Automation:* `apps/api/src/snapshots/__tests__/config-deps-version.test.ts`
guards the lockstep pins; the shared sandbox goldens fail on a pin drift.

*Incident:* no outage. Essentia's Bedrock model was unusable in native mode
until PR #6873 (1.18.23) deployed and the box updated with
`kortix self-host update --version dev`.

## A provider's 204 is not a renewal; read the deadline back

*Incident (2026-08-25, Essentia self-host):* four agent turns died mid-work,
each exactly one hour after the sandbox was created or resumed. The last
assistant message of each was `tokens 0/0/0, parts: []` — an LLM call that was
in flight when the VM froze. Kortix had renewed every box every 20 s
(`[active-turn-renewal]`, `errors:0`; E2B API log: 375 × `POST
/sandboxes/<id>/timeout → 204`). E2B's `KeepAliveFor` clamps every renewal to
the team's `max_length_hours`; the Essentia team sat on tier `base_v1`
(`max_length_hours = 1`, the upstream migration default) with a matching
`project_limits` row, so `endAt` never moved past `startedAt + 1h` and E2B
paused the box (`sandbox_pause_initiated pause_reason=timeout`).

**Rules.**
1. `renewLifecycle` (`apps/api/src/platform/providers/e2b.ts`) reads `endAt`
   back after `setTimeout` and throws `E2BLifecycleRenewalIgnoredError` when the
   deadline did not advance to within `KORTIX_E2B_RENEWAL_TOLERANCE_MS` of the
   backstop. The reaper and the active-turn renewal loop count it as an error
   and the log names `max_length_hours`.
2. A self-hosted E2B cluster must run its Kortix team at
   `max_length_hours ≥ 24` (`tiers` and `project_limits`; the `team_limits`
   view prefers `project_limits`). The cap is a ceiling on continuous running
   time, not a lifetime: Kortix's own `deadline_at` still stops idle boxes.
3. Existing sandboxes keep the cap they were created with. After raising it,
   pause+resume (or restart) the live boxes; a fresh `POST /timeout` must move
   `endAt`.
4. The fingerprint of this class of failure: an assistant message with
   `tokens 0/0/0` and no parts, created seconds before a provider pause; the
   OpenCode log ends at `llm runtime selected` with no stream line after it.

*Automation:* `apps/api/src/platform/providers/e2b.test.ts` — "refuses to
report a renewal the provider clamped".

## The runtime's body limit is the one that logs, never the one that is silent

*Incident (2026-08-25, Essentia):* three empty assistant messages in two
sessions were `413 Request Entity Too Large` on image-heavy turns (381k input
tokens, 118 inline screenshots). Nothing in the gateway log explained them:
Bun's own `maxRequestBodySize` default (128 MiB) equals
`DEFAULT_MAX_REQUEST_BYTES`, so Bun refused the body before `fetch()` ran —
plain-text 413, no `request_too_large` step, and a mid-upload socket close on
the first attempt (`Cannot connect to API: The socket…`).

**Rules.**
1. `Bun.serve` in `apps/llm-gateway/src/main.ts` sets `maxRequestBodySize`
   strictly above the pipeline's per-request cap
   (`bunRequestBodyCeilingBytes`), so an over-limit body is refused by the
   pipeline with its logged, digit-free 413.
2. Any host runtime that enforces a body limit of its own (Bun, Caddy, an
   ALB) must be configured above the application's cap, or the application's
   limit is decoration.
3. Raise a self-host gateway's cap through `GATEWAY_MAX_REQUEST_BYTES`; the
   in-flight memory budget clamps it to what the process can hold.

*Automation:* `apps/llm-gateway/src/request-body-ceiling.test.ts`.

## The daemon owns the OpenCode binary; OpenCode must never upgrade itself

*Incident (2026-08-22 and again 2026-08-25, Essentia):* a human ran `opencode`
in the Session terminal. OpenCode's autoupdate (`autoupdate` unset = on)
installed the newer version with plain `pnpm add -g` — no postinstall — leaving
a 479-byte launcher stub, deleting the old global dir and dangling
`/opt/kortix/opencode.current`. The running server survived on a deleted
inode; the next restart booted the stub ("Still waking this session up").

**Rules.**
1. `buildOpencodeConfigContent` always emits `autoupdate: false`; a base
   config cannot turn it back on. The composed Kortix config is never
   `undefined` any more.
2. Version changes reach a box only through the runtime-assets manifest and
   `installOpencodeVersion` (`pnpm add -g --allow-build=opencode-ai`).

*Automation:* `connector-mcp-config.test.ts` — "always disables OpenCode
autoupdate".

## A boot budget measures lack of progress, not wall-clock

*Incident (2026-08-25 17:23–17:25, Essentia):* both reopened sessions failed
to wake. The resume converged OpenCode 1.18.19 → 1.18.23 (manifest bump live
since the updater restarted the API) and then sat through the new version's
53 s first init. `/start` polled `starting` for 83 s and the fixed
`STALE_OPENCODE_NOT_READY_MS = 90 s` budget parked both boxes as
`runtime_boot_failed`; the automatic restart then booted in 20 s because the
install had already landed.

**Rules.**
1. Every not-ready 503 from the daemon carries `X-Kortix-Boot-Phase`
   (`boot-phase.ts`: last boot mark, OpenCode state, runtime-assets activity
   such as `installing-opencode@<v>`, and the not-ready reason).
2. The API restarts the per-reason clock whenever that phase changes
   (`opencodeReadyWaitPatch`); `STALE_OPENCODE_NOT_READY_MS` now bounds time
   without progress. `STALE_OPENCODE_BOOT_HARD_MS` (10 min from first
   observation) bounds a boot that changes phase forever. A stub launcher
   respawning in a loop never changes phase and is still caught at 90 s.
3. Do not "fix" a slow legitimate boot by raising the fixed budget; expose the
   progress and budget that.

*Automation:* `unit-session-restart-url-contract.test.ts` ("progress-aware
OpenCode boot budget"), `boot-phase.test.ts`, `proxy-auth.test.ts` ("names the
boot phase").

## A runtime started from `stopped` owns no turn; settle and redeliver on the wake

*Incident (2026-08-25, Essentia):* the provider paused two boxes mid-turn. One
was woken by the UI through the proxy before the reaper confirmed the stop:
the fresh runtime answered `idle`, the open turn closed `completed`, and the
user saw the agent "just stop" with nothing to resume. The other closed
`runtime_gone` but its accepted prompt was never redelivered (only
never-accepted deliveries were), so the user typed "go on".

**Rules.**
1. Every path that starts a provider-`stopped` box (`wakeSandbox` in the
   preview proxy, the `/start` wake finalize) calls
   `recoverTurnsAfterRuntimeRestart`: open ledger rows → `runtime_gone`,
   turn authority dropped, each prompt redelivered DUE (`hold:false`).
2. A stop the PROVIDER originated (`stopReason: provider_reconcile`) requeues
   accepted prompts too (held); a stop Kortix chose keeps the old rule.
3. A turn's verdict is never derived from a runtime that did not run it.

*Automation:* `runtime-restart-recovery.test.ts`.

## A refresh never converges a booting runtime; a stub launcher is never spawned

*Incident (2026-08-25, Essentia):* the session-open refresh (env-sync) ran the
runtime-assets pass during a resume, installing OpenCode 1.18.23 and
restarting it under the boot; and the PATH launcher on two boxes was the
479-byte pnpm postinstall stub, one restart away from a dead session.

**Rules.**
1. `refreshMayConvergeRuntime`: the refresh route schedules a reconcile only
   when OpenCode is serving (`ok`); main.ts owns the post-boot pass.
2. `isStubOpencodeLauncher`: the PATH launcher is skipped when it is (or shims
   to) the postinstall stub; resolution falls through to the managed links.
   Conservative: anything unreadable is not a stub.

*Automation:* `refresh-converge-guard.test.ts`, `opencode-binary.test.ts`.

## Window inline images inside the sandbox; the edge is too late

*Incident (2026-08-25, Essentia):* vision-heavy turns accumulated 118 inline
screenshots (>128 MiB per request). The gateway's image window keeps 12, but
only after the body has crossed the wire; the runtime's body ceiling refused it
first and the turn died with an empty assistant message.

**Rules.**
1. Every gateway session routes OpenCode through the daemon's localhost LLM
   proxy (`main.ts`, not only warm hot-swap forks). The proxy applies the same
   window (`llm-image-window.ts`, default keep 12 of ≤20) to `chat/completions`,
   `messages` and `responses` bodies BEFORE they leave the box, and lifts its
   own body ceiling so a large body can be shrunk rather than refused.
2. Kill switch `KORTIX_LLM_PROXY_DISABLE=1` (direct provider config);
   `KORTIX_LLM_MAX_INLINE_IMAGES=0` disables the window only.
3. A live gateway enable/disable (`/kortix/env`) keeps the proxy's upstream +
   token in step (`applyLlmGatewayMode`).

*Automation:* `llm-image-window.test.ts`, `llm-proxy.test.ts` ("in-sandbox
inline image window").

## A gateway may not refuse a request parameter the client sends by default

Found 2026-08-25 on dev, one hour after #6887 deployed. The bedrock adapter
answered `400 unsupported_param` for a `reasoning_effort` it could not map
(Nova, Grok, DeepSeek on Bedrock). The first turn of a fresh project — the
auto-seeded `amazon-bedrock/xai.grok-4.6`, no tier picked — failed with that
400. opencode attaches a default reasoning effort to every reasoning-capable
model, so refusing the parameter refused the model, managed Grok included.
Reverted in #6893 to a documented drop.

**Rules.**
1. Before a gateway refuses a request field, capture what opencode sends for a
   turn where the user set nothing. A field present by default is part of the
   model contract, not a user choice.
2. Verify a provider wire shape against the real provider before mapping it.
   The AI SDK's mapping is a hint: `@ai-sdk/amazon-bedrock` 5.0.59 emits
   `reasoning_effort` for OpenAI ids; Bedrock GPT-5.6 rejects it with
   `unknown_parameter` and accepts `reasoning: { effort }` (verified with the
   Essentia account, us-west-2, every published tier).
3. Prefer "drop and document" over "refuse" for a field with no verified
   mapping; log the drop so the gap is visible.
4. A dev verification with a fake provider key proves routing only. Use a real
   key (a short-lived Bedrock bearer token from `aws-bedrock-token-generator`
   on the provider account's profile) before calling a wire mapping verified.

*Automation:* `packages/llm-gateway/src/transports/ai-sdk/ai-sdk.test.ts`
pins the drop for Nova/Grok and the `reasoning.effort` shape for OpenAI ids.

*Incident:* dev only; every Grok-on-Bedrock turn 400'd between the #6887
deploy (`2635791cf1`) and the #6893 deploy (`77ec6b2307`), about 70 minutes.
Prod was not promoted in that window. No data loss.

## A 400 that names one parameter is never the turn's final answer

*Incident (2026-08-25 19:40Z, Essentia session 58da74d4):* the gateway
forwarded a reasoning field in a shape Bedrock's GPT-5.6 profile rejects
(`400 unknown_parameter: reasoning_effort`); every turn on the model died with
an empty assistant message until the wire shape was verified and corrected
(#6893). The project's configured default was the trigger; the live mitigation
was stripping it from `project_llm_routing_policies.model_generation_config`.

**Rules.**
1. `isUnknownParameterRejection(err, param)` (errors.ts) recognises an
   upstream refusing ONE field. The chat handler re-dispatches a Bedrock
   candidate once without `reasoning_effort` and remembers the model
   (`noteBedrockOpenAiRejectsReasoningEffort`); the adapter never attaches the
   field for a remembered model again. One retry, never the turn.
2. The verified wire (#6893) stays the primary path; this is the backstop for
   the next unverified claim, not a substitute for verifying.

*Automation:* `errors.test.ts`, `simple-handler.test.ts`, `ai-sdk.test.ts`
("never receives it again").

## Regenerating a CA on every listener restart breaks trust and the CI clock

*Incident (2026-08-25):* the daemon egress shim minted a fresh RSA CA on every
rule change (`syncEgressShim` restart). Shells that had sourced the previous
trust bundle would fail TLS until re-sourced, and node-forge's keygen (1-4 s)
made the packages CI lane time out on the restart tests.

**Rules.** One CA per daemon process (`sessionCa` in `egress-shim/index.ts`),
reused across restarts; tests reset it via `__resetEgressShimForTests`.
Timing tests keep at least a 5× margin between the paced event and the budget
they assert (relay-transport "measures SILENCE").

## Every blocking OpenCode endpoint must be exempted in BOTH proxy timeout layers

Found 2026-08-26. `POST /session/:id/summarize` (the /compact flow) failed
100% of the time with `503 {"error":"upstream unreachable","details":"The
operation was aborted."}`. OpenCode holds the summarize response open until
the whole summary turn completes (30s+ on a large model), but both proxy
layers only exempted `message|command` from their short response timeouts:
the in-sandbox daemon (`apps/kortix-sandbox-agent-server/src/proxy.ts`,
`isBlockingTurnRequest`, 10s generic bound — the layer that actually emitted
the error) and apps/api (`sandbox-proxy/preview-retry-budget.ts`,
`isLongTurnCompletionRequest`, 15s bound). Because summarize was also absent
from `isNonIdempotentSessionWrite` (`prompt-dedupe.ts`), the apps/api retry
loop re-POSTed the non-idempotent summarize on each abort, stacking failed
summary-attempt turns into the transcript. This is the THIRD instance of the
same shape: `/message` (original), `/command` (2026-08-11, 4x duplicate
sends), now `/summarize`.

**Rules.**
1. Any OpenCode endpoint that withholds response headers until a model turn
   finishes must be listed in BOTH predicates (`isBlockingTurnRequest` in the
   daemon, `isLongTurnCompletionRequest` in apps/api) AND in
   `isNonIdempotentSessionWrite` so the retry loop never re-sends it.
2. If the endpoint's request body is byte-identical between two deliberate
   user retries (command: `{command,arguments}`, summarize:
   `{providerID,modelID}`), it must be key-gated in
   `shouldClaimPromptDelivery` — a keyless content-hash claim silently
   swallows the user's own retry as `{"deduplicated":true}`.
3. The daemon fix reaches only NEW sandboxes (the daemon is baked into the
   snapshot); apps/api fixes apply on API restart. Verify on a session
   created AFTER the snapshot rebuild, not on the box that reproduced it.

*Automation:* the cross-layer drift test
(`apps/kortix-sandbox-agent-server/src/__tests__/blocking-turn-timeout.test.ts`,
"the two proxy layers agree on which calls block") drives both predicates
with the same paths and fails on any drift, and now covers `summarize`;
`preview-retry-budget.test.ts` + `prompt-dedupe.test.ts` pin the apps/api
side.

*Incident:* no prod outage — caught on local dev, but the identical code
paths ship to prod, where every /compact would have 503'd the same way.

## A turn probe never lists the whole root — the list is unbounded, the budget is not

*Incident (2026-08-25, Essentia sessions 9c8749ac and 9df2a873):* the reaper
asks the daemon `GET /kortix/health?turn=1&turn_session_id&turn_message_id`
and acts on `turn_in_flight`. The daemon answered it by fetching the root's
ENTIRE OpenCode message list inside a 5 s budget. On 9c8749ac that list was
276.7 MB (inline base64 image parts; `?limit=20` alone was 26 MB). The read
never fit, the daemon answered `turn_in_flight: null` ("could not tell") on
every visit, the reaper drip-extended the box on that non-answer for 2.5 h
after OpenCode had finished the turn (`exiting loop` 21:00:18Z, probe still
null at 22:10Z), and the session rendered "working" until the ledger row was
settled by hand.

**Rules.**
1. `observeOpencodeDelivery` / `inspectOpencodeRoot` read the newest
   `TURN_PROBE_WINDOW` (12) messages via `?limit=` — the newest N in
   chronological order (verified on OpenCode 1.18.23) — with a 20 s budget.
   A prompt older than the window is proved by `GET /session/:id/message/:id`
   (~400 bytes; 404 `NotFoundError` when absent). Only a proven absence is
   `abandoned`; a failed by-id read stays `null`.
2. Any new daemon read of a session transcript states its bound in the
   request. Roots grow for hours; "the list" is never small.
3. The live opencode port is a property of the PROCESS (`childPorts`,
   `livePort()` in opencode.ts), never a variable beside it. Same box, same
   day: the daemon reported `starting` on 4096 for 2 h while its own child
   (pid 2423) served on 4097 — every prompt 503'd and no turn end was ever
   observed. The verified reload (two opencodes, promote the proven one) is
   by design; a bookkeeping variable that can drift from the process is not.
   The verifier also declines when the candidate half already answers: the
   incumbent would otherwise "prove" a candidate that died on EADDRINUSE and
   promotion would kill the only opencode the box has.
4. The daemon log is on the box: every logger line also lands in
   `KORTIX_DAEMON_LOG_FILE` (default `/opt/kortix/logs/daemon.log`, rotated at
   32 MiB to `.1`), readable with `GET /kortix/logs?source=daemon|opencode|all&tail=N`
   through the sandbox proxy (`/v1/p/<external_id>/8000/kortix/logs`). A
   daemon whose only log is a stream nobody keeps cannot be debugged after
   the fact — that is why this entry says "unproven".
5. Box telemetry is on record: `[resources]` every 60 s and on every OpenCode
   state change (memory, cgroup limit + oom_kill counter, load, disk on
   /workspace + /opt/kortix + /tmp, daemon + opencode RSS, duplicate
   `opencode serve` pids), `[resources] pressure` when a threshold is
   crossed, and `GET /kortix/diag` returns state + resources + runtime
   report + both log tails in one document. Ask the box before guessing.

*Cost of the old probe, measured (2026-08-25 23:12Z, session 9df2a873):* the
reaper visited that box 345 times in one hour; every visit made OpenCode
JSON-serialise its 140 MB root (~48 GB of serialisation per hour) for an
answer that never fit the budget. OpenCode reached 6.48 GB RSS on an 8 GB
box and the kernel OOM-killed it mid-turn (`dmesg`: `Killed process 1506
(opencode.exe) anon-rss:6484532kB`). An unbounded probe is not only blind,
it is a memory attack on the process it probes.

*Automation:* `orphaned-turn-finalize.test.ts` ("turn probes read a bounded
window, never the whole root"); the stub fetch there serves `?limit=` and
`/message/:id` the way 1.18.23 does.

## Bun's fetch has a hidden 300 s idle timeout — every model hop opts out

*Incident (2026-08-25 22:04Z, Essentia session 9c27242e):* a turn on
`codex/gpt-5.6-sol` at reasoning effort `max` died after 273.8 s with
`{"message":"The operation timed out.","code":"upstream_timeout"}`. Nothing in
this repo sets a 300 s timer; the gateway's own budgets are 90 s / 5 min for
response headers and 90 min for body inactivity. Measured on Bun 1.3.14 the
same night: `fetch` throws `TimeoutError: The operation timed out.` at 300.0 s
when the socket is idle (no headers, or headers then silence); a stream that
drips a byte every 60 s lives past 420 s; a caller `signal` does NOT disable
it; `timeout: false` (or `0`) does. The provider was still thinking.

**Rules.**
1. Every fetch on the model path passes `timeout: false`: gateway → provider
   (`upstreamFetch`, `packages/llm-gateway/src/upstream-fetch.ts`, used by
   both `callUpstream` and the AI-SDK transport), API relay → gateway
   (`apps/api/src/llm-gateway/wire.ts`), box llm-proxy → API
   (`kortix-sandbox-agent-server/src/llm-proxy.ts`). The gateway's explicit
   timeouts are the only ones on that path.
2. A timeout you did not write is still yours to know about. When an error
   message is not in the repo, measure the runtime before blaming the
   provider: `bun-idle.ts` (headers-then-silence, no-headers, drip, option
   variants) took 12 minutes and settled it.

*Automation:* `packages/llm-gateway/src/upstream-fetch.test.ts` (option is
forwarded; Bun accepts it on a real request).

## Image bytes never live in the transcript; memory is guarded before the kernel; an unknown probe backs off

*Incident (2026-08-25 23:12Z, Essentia session 9df2a873):* the kernel OOM-killed
OpenCode at 6.48 GB RSS on an 8 GB box (`dmesg`: `Killed process 1506
(opencode.exe) anon-rss:6484532kB`), mid-turn, leaving an empty assistant
husk. Two forces met: the transcript held 275 MB of base64 tool screenshots in
`part.state.attachments[].url` (352 of 538 tool parts) which every LLM step
and every list re-serialised, and the reaper re-probed the box 345 times in
one hour after `unknown` (two replicas, 20 s cadence), each probe forcing a
full-transcript serialisation. OpenCode's own compaction clears old tool
output text and stops SENDING old attachments, but never removes bytes from
storage (`session/compaction.ts`, `message-v2.ts`); there is no native
"store a path instead" for tool attachments (`tool/read.ts` writes `data:`).

**Rules.**
1. `attachment-offload.ts` (daemon): when idle, attachments older than the
   newest 12 per session (and every one OpenCode marked `compacted`) move
   to `~/.local/share/kortix/attachments/<id>`; the row keeps a 1×1 PNG
   `data:` placeholder (valid for OpenCode's model conversion, the AI SDK,
   the media-extraction path) plus `kortix:{offloaded,sidecar,bytes,mime}`.
   Optimistic UPDATE on `time_updated`; never the newest message; never
   during a turn. Verified on 1.18.23: OpenCode serves the rewritten row on
   the next read (7 ms UPDATE, no restart). `/kortix/part` serves sidecar
   bytes and searches nested `state.attachments` (tool screenshots 404'd
   before).
2. Memory guard (`resources.ts`): ≥80 % box/cgroup memory → 10 s sampling;
   ≥92 % with a turn in flight → `POST /session/:id/abort`, turn-stream
   `kind:end status:error error_name:SandboxMemoryGuard` with the numbers,
   then an offload pass. One action per crossing; re-armed below 80 %.
   `KORTIX_MEMORY_GUARD_PCT` overrides.
3. Reaper (`box-reaper.ts`): an `unknown` observation backs the PROBE off
   per sandbox (20 s → 5 min, per replica); the drip still extends.
   `probeBackoff` clears on the first readable answer.

*Automation:* `attachment-offload.test.ts` (real bun:sqlite fixture in the
1.18.23 row shape, optimistic-skip race), `part-route-attachments.test.ts`,
`resources.test.ts` ("memory guard"), `sandbox-reaper.test.ts` ("not
re-probed until its back-off elapses").

## A non-prod secrets profile must never hold a production-reaching credential

Found 2026-08-26 while scoping Dotenvx Armor access. `apps/api/.env` — the
local profile every Armor member decrypts daily — carried 22 secrets
byte-identical to `apps/api/.env.prod`. One of them, `SUPABASE_MGMT_TOKEN`,
was a personal Supabase management token that executed SQL on the Kortix
PROD project (`POST /v1/projects/<ref>/database/query` → 201) and was used
nowhere in the repository. Restricting the PROD keypair to the owner had
protected nothing, because the same credentials lived in the file everyone
had.

**Rules.**
1. Classify a profile by what its credentials can reach, not by which
   database URL it names. A local DB with production vendor keys is a
   production profile.
2. A secret-classed key in `.env`, `.env.dev`, or `.env.staging` must not
   equal its `.env.prod` value. Every exception is a listed debt with the
   rotation that removes it.
3. Delete a credential the code never reads. A dead key is pure exposure.
4. Personal tokens never belong in a shared profile. Use a service credential
   scoped to one environment.
5. A per-key access control (Armor FGAC) only works after the split above.
   Do the split first, then restrict the prod keypair.
6. Classify each environment's data explicitly. The dev Supabase project
   holds 2.7k signups that the owner classifies as synthetic; that decision
   is recorded, not assumed. Until the shared vendor keys are split, only
   `.env` qualifies for people without production clearance.

*Automation:* `pnpm test:envs` runs `scripts/secrets-envs-separation.py`,
which fails on any unlisted non-prod secret that equals its prod value;
`scripts/secrets-shared-with-prod.allowlist` is the tracked exception list.

*Incident:* no known misuse. The Armor audit log shows the PROD keypairs were
decrypted by 4 members and 1 former member before the restriction; the shared
vendor credentials remain to be rotated per the allowlist (PR #6910).

## A stamped failure is a cooldown, never a gravestone — and a negative is a claim

*Incident (2026-08-26, Essentia).* Two sessions could only be recovered by a
human pressing Restart.

- Session `e06ad0c4` answered `POST …/start` with `stage:"failed"` in **47 ms**,
  making **no provider call**. A wake had exceeded the FIXED
  `RUNTIME_WAKE_LEASE_MS = 240_000`, and maintenance stamped
  `stopReason:"runtime_wake_failed"`. The box was startable: the manual restart
  reached ready in **10 s**.
- Session `9c8749ac` (box `i67m4fhw2t3nesssgl4yf`) replayed
  `{"stage":"failed","retriable":false,…"stopReason":"runtime_boot_failed",
  "healthStatus":"unknown","lastInitError":null}` on **every open for 10+
  hours** from a stamp written at 03:37Z. Four fields from four different
  writes; none described the call, which touched nothing.

Both stamps were written by a budget that measured wall clock, and both were
consumed by a `/start` branch that returned before any provider call. Only
`POST …/restart` cleared them, which is why the human's one click always worked.

**The rules.**

1. **A stamped runtime failure suppresses re-attempts for a COOLDOWN, and for
   nothing longer.** After it lapses the next `/start` re-attempts by itself.
   The cooldown escalates with consecutive failures (2 / 5 / 10 min) so a broken
   provider is not hammered, and the verdict expires 30 min after the last
   failure: no verdict outlives its evidence.
2. **Cover every stamp that short-circuits the path**, not the one in the
   report. `runtime_wake_failed` AND `runtime_boot_failed` produced the same
   dead end from two different writers.
3. **`retriable` is derived on every call, never persisted.** Anything the
   server can still re-attempt must not answer `retriable:false` — that flag
   tells the client's escalation ladder to stop.
4. **A negative is a claim: carry its evidence.** Every `/start` failure now
   ships `failure.evidence` = which check, when it ran, the provider text, the
   attempt count, and `next_retry_at`. A `failed` payload with
   `lastInitError:null` tells a user nothing.
5. **The answer states what THIS call did and observed.** `action`,
   `observation` (with `known:false` meaning NOT CHECKED, never "checked and
   unknown"), `boot.actively_starting`, and one `observed_at`. A payload no live
   check supports is not a state worth naming.
6. **The wake budget measures lack of progress** — the same rule as
   "A boot budget measures lack of progress, not wall-clock". A provider-state
   change restarts the 90 s no-progress budget and refreshes the durable lease;
   `RUNTIME_WAKE_HARD_MS = 10 min` bounds the whole wake and never restarts, so
   the reconcile/billing exemption that lease grants can never be held open by a
   flapping provider.
7. **The observer that DEFERS a park owns the confirmation.** A mid-turn
   `stopped` read that waits for a second observation must schedule that second
   read itself, not assume someone polls again. Session `29861dfa` /
   `inqwpv4a1cc1kynlg46k8` read `running` for 5+ minutes while the provider said
   `not running (status: stopped)`, and the queued prompt burned against it.

*Automation:* `apps/api/src/projects/routes/stopped-wake-result.test.ts` (the
10-hour replay, both stamps, the ladder, the evidence),
`session-lifecycle/runtime-wake-fence.test.ts` (progress-aware budget, hard cap,
cooldown ladder), `session-lifecycle/runtime-wake-billing-invariant.test.ts`
(the 2026-08-17 mid-turn park and the compute-close exemption stay intact),
`session-lifecycle/stopped-observation-followup.test.ts` (bounded confirmation),
`session-lifecycle/start-envelope.test.ts` (one envelope per open state).

### A retry class is a claim about the FAILURE, not about the call that returned it (2026-08-26)

**When:** writing or reviewing any `retryable = <outcome> === …` line on a
delivery/queue path. `executeQueuedContinue` derived retryability from one
outcome value, and every producer of that value — a stopped box, a parked
session, a dead resolved target — was a DOWN RUNTIME, not a bad message. A
queued prompt delivered while its box was unreachable went `dead_lettered` on
attempt 1 (`state:failed, attempts:1, last_error:"delivery outcome: failed"`)
and was never re-tried when the box returned minutes later. Rule: **name the
unreachable-runtime class separately from the refusal class, keep the work
queued with a runtime-scaled backoff, spend no dead-letter budget on it, and
re-arm it on the event you are actually waiting for.** *Enforcer:*
`deliver.test.ts` (stopped/parked → `unreachable`, missing → `no-session`) and
`runtime-unreachable-park.test.ts` (bounded budget, backoff ladder, fresh
idempotency key, Stop survives as a hold).

### A provider's "resume" is not a promise that your processes come back (2026-08-26)

**When:** using any pause/resume sandbox lifecycle that persists the filesystem
only. E2B's `lifecycle.autoResume` requires a MEMORY snapshot; with
`keepMemory:false` the SDK documents the box as cold-booting and needing an
explicit `connect()`, and Kortix sets no template `startCmd` — so apps/api is
the only thing that starts the runtime. Resumes that came back with a dead
process tree burned the full 190 s health wait and handed back an unreachable
box; only a human restart (a NEW sandbox) healed it. Rule: **after a resume,
prove the daemon answers on a short bound; if it does not AND no supervisor
process is alive, clear the stale lock, relaunch once, re-verify, and log the
workaround under one greppable string so its rate is countable.** Never `rm` a
flock'd lock while a live holder exists — that does not free the lock, it lets a
second daemon win a different inode. *Enforcer:* `e2b.test.ts` — dead resume is
revived and re-verified, a healthy resume touches nothing, a merely-slow resume
is never double-started.

### An image is a cache; a boot that blocks on building one has confused it for the truth (2026-08-26)

**When:** touching `ensureSandboxImage` or any boot-path call that can reach a
provider build. Every `self-host update` bumps the runtime fingerprint and
starts a template rebuild (14 m 11 s measured); session starts inside that
window sat in `provisioning` for 10–34 minutes, polling the in-flight build for
up to 12 minutes or building inline. The daemon converges on the deploy's
runtime assets at boot and on every resume, so a box booted from the previous
ready image serves the same CLI, skills and OpenCode pin. Rule: **a session boot
serves the last image its template lineage actually shipped and lets the new one
bake behind it; only a genuinely FIRST build may block.** Bound the fallback to
the same lineage, same provider, recent — convergence does not rebuild the base
rootfs. *Enforcer:* `last-ready-image.test.ts` (predecessor served while the new
identity builds; first build still blocks) and `e2b.test.ts` (a resume never
consults a template at all).

## A retry that inherits the previous attempt's budget is not a retry

*Incident (2026-08-26, Essentia, session `29861dfa` / box `inqwpv4a`).* The
first production outing of the automatic wake-cooldown ladder (see "A stamped
failure is a cooldown, never a gravestone") defeated itself.

Attempt 1 failed at ~13:27 in a post-roll build storm. The cooldown rung
re-attempted at ~13:33: the resume launched the entrypoint, the daemon booted
through 13:34:48.8, authenticated to the gateway at 13:34:48.5–49.1 and claimed
its initial turn at **13:34:49.216** — and `/start` parked the box at
**13:34:49.202**. The boot lost by **14 ms**.

`opencodeBootWaitFirstSeenAt` was stamped during attempt 1 and cleared by
nothing: `parkEstablishedRuntime` copies the whole metadata object, the wake
claim stripped only four of the ten readiness-clock keys, and
`clearRuntimeReadinessClocks` stripped the first eight **by hardcoded index**.
Only a human Restart (`prepareInPlaceRestartMetadata`, which loops the whole
list) cleared it. So the 10-minute hard cap was ~7 minutes old before attempt 2
started booting, and **every automatic rung after the first five minutes was
deterministically doomed, regardless of progress.**

**The rules.**

1. **Every automatic retry re-baselines the same clocks a human retry does.** An
   attempt judged against a predecessor's budget is not an attempt. The only
   thing an automatic rung keeps that a human restart clears is the
   consecutive-failure accounting that drives its own escalation.
2. **Never write a key list twice.** The four/eight/ten split existed because
   three call sites hand-wrote `- 'key'` chains. Generate every chain from the
   single exported list; index-addressed subsets (`KEYS[0] … KEYS[7]`) silently
   stop covering a list that grows.
3. **Scope a budget to its attempt, causally.** `staleOpencodeReadyReason` now
   ignores any clock stamped before this attempt's boot epoch
   (`runtimeBootEpochMs` = newest of `runtimeWakeStartedAt`,
   `providerRunningConfirmedAt`, `initSucceededAt`). This is **not** a
   progress reset: a stub launcher that changes phase for ever is still caught
   at the cap, because only a NEW attempt moves the epoch. Do not "fix" an
   inherited budget by making the hard cap progress-aware — that undoes
   "A boot budget measures lack of progress, not wall-clock".
4. **`jsonb - $1` is ambiguous; strip keys as literals.** Postgres cannot
   choose between `jsonb - text` and `jsonb - integer` for an untyped
   parameter. A bind-parameter strip inside a `try/catch` that only
   `console.warn`s fails invisibly — which is the likeliest reason the
   ready-path clear never cleared anything in production.

*Automation:* `unit-session-restart-url-contract.test.ts` — "an automatic rung
never inherits the previous attempt boot budget" (8 tests, including "a stub
launcher that changes phase for ever is still caught at the cap" and
"who resets the retry accounting"); `e2e-project-session-contract.test.ts` —
"the automatic rung re-baselines the boot clocks but KEEPS the failure
accounting".

## An alarm on a metric the workload violates by design is noise, and noise trains you to delete the real page (2026-08-26)

**When:** adding or reviewing any CloudWatch/SNS alarm, especially compliance
alarms that exist to satisfy a control (Drata DCF-86) rather than an incident.
`TargetResponseTime` Average ≥ 2 s on the gateway and API ALBs fired on 6–11 s
averages — normal, because the gateway streams LLM completions and the API
holds SSE `/event` streams for minutes. The alarm flapped ALARM/OK every 5–10
min; each flap fanned out through **two** alarm sets on the same ALB (a
hand-made `compliance-*` set from the 2026-07-27 evidence pass, never in
Terraform, plus the `kortix-alb-*` set) × **three** email subscriptions on the
same person = ~300 emails in one day and zero incidents. The 5xx alarms in the
same inbox — the ones that page a real outage — had 3 messages each and were
being trashed with the rest. Rules: **(1) before adding a threshold alarm, name
the request shape that violates it in steady state; if streaming, long-poll or
SSE traffic crosses it by design, alarm on errors and host health instead.
(2) One alarm set per resource, and it lives in code — a console-made duplicate
is drift, and the reconciler that owns the family deletes it. (3) A reconciler
that can only create is half a reconciler: it must also delete what it retires,
or a deleted alarm is resurrected on the next tick and Terraform's forget/destroy
is undone.** `removed { lifecycle { destroy = false } }` lets the automatic
apply pass its no-delete guard while the Lambda does the real deletion.
*Enforcer:* `functions/test_alb_alarm_reconciler.py` — `ALARM_SPECS` contains no
`TargetResponseTime`; retired `kortix-alb-*-target-response-time` (including the
per-target-group variants Terraform never managed) and `compliance-*` alarms in
`AWS/ApplicationELB` are deleted; `compliance-*-cpu-high` and every desired
alarm survive.

## A scheduled control that crashes is a control that never ran — alarm on the reconciler itself (2026-08-26)

**When:** adding a boto3 call to any compliance Lambda
(`infra/terraform/compliance-monitoring/functions/*`), or trusting that a
scheduled reconciler "has been running". `fcf779ffb3` (2026-08-06) taught the
ALB alarm reconciler to call `describe_target_groups`; its role only allowed
`DescribeLoadBalancers`. Every 5-minute tick in 3 regions raised `AccessDenied`
for 20 days. The schedule was ENABLED, the function Active, the apply green —
and the alarms the reconciler exists to maintain silently stopped being
maintained. It surfaced only because #6919 needed the reconciler to delete
alarms and nothing was deleted. Rules: **(1) every AWS API a Lambda calls is
asserted against its IAM policy in CI, not discovered in prod.** **(2) a
scheduled control gets an `AWS/Lambda Errors ≥ 1` alarm to the same topic as
the alarms it maintains; a control's own failure is the loudest alarm in the
family.** **(3) "the apply succeeded" proves the code shipped, not that it ran
— read the function's log group or its result payload before calling the
change verified.** *Enforcer:*
`infra/terraform/scripts/test_reconciler_iam_coverage.py` (terraform-ci) and
`reconciler-health.tf` (`kortix-compliance-<function>-errors` alarms, 3
regions).

## Local Bun is not image Bun — feature-detect web APIs, and a green health gate proves only /health
- **Incident (2026-08-26):** compress middleware (round-7 perf PR) called `CompressionStream`. Local dev + CI run Bun 1.3.14 (has it); the API image is `oven/bun:1.2-slim` = Bun 1.2.23 (does not). Every response ≥1KB on a compressible type 500'd (`ReferenceError`) on dev-api and Essentia; `/health` is <1KB, skipped the path, stayed 200 — so the deploy verification gate passed while `GET /v1/projects/:id` 500'd and the project shell showed "This project didn't load".
- **Rule:** any Web/runtime global used in `apps/api` (or anything shipped in the Bun image) must exist in the image's Bun line (`ARG BUN_VERSION` in `apps/api/Dockerfile`), not just locally. Feature-detect (`typeof X !== 'undefined'`) with a `node:*` fallback, or bump and test the image's Bun. Deployed-SHA health checks do not exercise real routes — after a deploy that touches the response path, hit one real authenticated >1KB route.
- **Enforcement:** `compressedStream()` in `apps/api/src/middleware/compress.ts` feature-detects and falls back to `node:zlib`; `compress.test.ts` pins the forced-fallback path (`useNative:false`) so the image path is exercised by CI forever.

## Self-host update health-gate deadlock: the bug that sickens a replica blocks the update that fixes it
- **Incident (2026-08-27, Essentia):** the compress 500 bug made the scheduler-leader API replica fail its own docker healthcheck (`/health` JSON >1KB on the leader → gzip path → 500). `kortix self-host update` then aborted every roll with `dependency failed to start: container ... is unhealthy` — compose's health gate refused to replace the sick container with the image that cures it. The box stayed broken through three roll attempts that all reported the same abort.
- **Rule:** when a self-host update aborts on an unhealthy EXISTING container and the update contains the fix for that unhealthiness, `docker rm -f` the unhealthy replicas first, then re-run the update. Read the update's full output — an aborted roll leaves old containers running, so a later health probe answering does NOT mean the roll landed; verify the running commit, not liveness.
- **Enforcement:** none automated yet; candidate = updater flag to replace unhealthy replicas of the service being updated.

## A mocked-db unit test is not a real INSERT: a raw `sql` Date binding 500'd every real write
- **Incident (2026-08-27, WS-Z4 assembly of the Kortix Runtime API):** the daemon's runtime-projection push (`POST /v1/platform/runtime-projection`) 500'd on EVERY real request. `saveRuntimeProjection`'s out-of-order guard was `sql`${col} <= ${input.capturedAt}`` — a raw `sql` fragment binding a JS `Date`. postgres-js serializes a Date inside a raw fragment with its locale `toString()` ("Thu Aug 27 2026 03:01:29 GMT+0200 (CEST)"), which Postgres cannot parse as a timestamp. The `.values()`/`set` column bindings map a Date fine; only the raw fragment broke. The route's unit test mocked `db` wholesale, so the SQL never ran — the bug was invisible until a real daemon pushed to a real Postgres.
- **Rule:** inside a raw `sql`…`` fragment, never bind a JS `Date` for a timestamp column — bind `date.toISOString()` with an explicit `::timestamptz` cast. And a handler whose only test mocks the database has ZERO coverage of the SQL it emits: pin any raw `sql` fragment by compiling it (`new PgDialect().sqlToQuery(frag)`) and asserting the params are strings, not Dates — or exercise it against a real DB.
- **Enforcement:** `capturedAtNotNewerThan()` in `apps/api/src/projects/lib/session-runtime-projection.ts` is the extracted fragment; `session-runtime-projection.test.ts` compiles it and asserts the bound param is the ISO string + `::timestamptz`, never a Date. Verified live on a Platinum box: the push went 500 → `200 {"stored":"stored"}`.

## A session-bound sandbox PAT is default-denied by enforceTokenProjectScope: whitelist each new sandbox->API surface
- **Incident (2026-08-27, WS-Z4):** the same runtime-projection push ALSO 403'd before it ever reached its handler. The in-sandbox `KORTIX_TOKEN` is one project+SESSION-scoped PAT ("One sandbox, one session-scoped Kortix credential"), and `enforceTokenProjectScope` in `apps/api/src/middleware/auth.ts` is DEFAULT-DENY: any surface not explicitly allowed 403s with "Project-scoped token cannot call this surface". A new sandbox->API route (`/v1/platform/runtime-projection`, the boot-timeline sibling) had no allowance, so the daemon's push died at the gate on every environment. Same class as the earlier `/v1/skills` and `/v1/runtime-assets/` 403s that shipped for the same reason.
- **Rule:** whenever the sandbox daemon gains a new API route, add an explicit branch to `enforceTokenProjectScope` (gated on session-binding for a sandbox-only surface) AND a regression test in `auth.test.ts` — the route's own handler test does not mount `combinedAuth`, and the e2e flows exercise only ANON + a Supabase-JWT owner, so nothing else catches it.
- **Enforcement:** `enforceTokenProjectScope` now allows `/v1/platform/runtime-projection` for a session-bound PAT only; `auth.test.ts` pins both the allow (session-bound) and the deny (plain project PAT). The handler still re-verifies the sandbox↔session binding via `isSessionSandboxCredential`.

## A fire-and-forget scheduler must check its config BEFORE arming the timer, not inside the callback
- **Incident (2026-08-27):** the sandbox daemon's `scheduleRuntimeProjectionPush` (runtime-projection-relay.ts) always armed a 2s `unref()`d debounce timer, and only checked control-plane config (`KORTIX_SESSION_ID/TOKEN/API_URL`) inside the fired `doPush`. Every unconfigured daemon (self-host, local dev, and every daemon unit test that does not set those vars) armed a timer that fired later to do nothing. Bun runs a package's test files in ONE process, so the env-route test armed this relay and the unref'd timer fired mid a SIBLING test — flaking `env route — mid-session boundary rules arm the shim` intermittently in CI while the full suite passed 1098/0 locally. Re-running the lane never converged (3 attempts across #6950/#6953).
- **Rule:** a debounced/deferred fire-and-forget must no-op at the SCHEDULE call when there is nothing to do (no config, no sink), not only when the timer fires. An armed unref'd timer outlives its caller and leaks work into whatever runs next — a real production waste (self-host daemons scheduling pushes they can never send) and a test-order flake generator. Gate at entry: `if (!configured()) return` before `setTimeout`.
- **Enforcement:** `projectionConfigured()` guards the top of `scheduleRuntimeProjectionPush`; the relay's own test still sets the three env vars so the push path stays exercised (25/0).

## Under the gateway every model is `providerID: 'kortix'` — a "same provider" heuristic keyed on `providerID` spans the whole catalog
- **Incident (2026-08-27, Essentia self-host, web `39685da4`):** the composer model picker looked dead — every click left the chip on "Claude Opus 5 (Global)" and every prompt was sent with it. The click DID persist the pick; `healBedrockModelKey` (#6915, 2026-08-26) then replaced it at resolution time. The heal finds "the key's own provider" by `providerID` equality and detects Bedrock by any sibling ranking as an inference profile. On the gateway all 481 catalog models share `providerID: 'kortix'`, `bedrockInferenceProfileRank` strips the `amazon-bedrock/` prefix so `amazon-bedrock/global.anthropic.claude-opus-5` still ranks 2, and OpenRouter/Codex/bare-Bedrock picks (no `global.` twin) fell through to the auto-seed fallback = the newest profile in the whole catalog. The unit suite (16/0) was green because every fixture used native ids (`amazon-bedrock` / `xai.grok-4.6`); no test flattened a gateway catalog.
- **Rule:** any SDK/web logic that groups, filters, or "heals" models by provider must resolve the REAL provider (`FlatModel.provider`, or the modelID prefix under the gateway), never `providerID` alone — and must be tested against BOTH shapes: a native list and a `projectLlmCatalogToProviderList` gateway list. A native-only guard (the gateway already retries bare Bedrock ids after the 400, #6897) must short-circuit on `GATEWAY_PROVIDER_IDS`.
- **Enforcement:** `healBedrockModelKey` step 0 returns gateway keys untouched; `bedrock-invokable.test.ts` "under the gateway the heal is inert" builds the fixture through the real `projectLlmCatalogToProviderList` → `flattenModels` and pins OpenRouter, bare-Bedrock and Codex picks as untouched.

## Deployed configuration has one truth, and it is not the file in git

Found 2026-08-27 while auditing secret access. The git profiles
`apps/api/.env.{dev,staging,prod}` had drifted far from what the deployed
environments actually run: dev was missing 54 keys, staging 34, prod 90, and
`.env.prod` still declared `FRONTEND_URL=http://localhost:3000`. Runtime truth
is the AWS Secrets Manager blob `kortix-<env>-env`, injected by ECS as
`KORTIX_ENV_JSON`, plus the plain `environment` entries on the API task
definition. Nothing synchronized the two: the dev and prod blobs are edited by
operators, and the staging blob is rebuilt as existing-blob-plus-overrides on
each staging deploy. An operator reading the git file was reading fiction.

**Rules.**
1. Name the single runtime source for every deployed setting, and make a
   committed check assert the file equals it. Drift that nothing measures grows
   without bound.
2. Pull from the runtime source into the file. Push a file value into the
   runtime source only as a deliberate change with a rollout.
3. A file that mirrors a deployed environment must not receive a credential
   whose value is identical to production, when that file is readable by more
   people than production is. Keep it in the secret store and record the
   omission with its reason.
4. Every tool that reads or writes a dotenvx file must run the CLI with a bare
   environment. An exported shell variable makes `dotenvx get` return the shell
   value and `dotenvx set` a silent no-op that reports `○ no change`, so a
   comparison silently reads — and a write silently skips — the wrong value.
5. dotenvx writes `KEY="encrypted:…"` with quotes. A plaintext scan that matches
   `=encrypted:` reports every encrypted value as plaintext. Match
   `=["']?encrypted:`.
6. Verify a credential before treating it as sensitive. The three
   `AWS_SECRET_ACCESS_KEY` values in these files returned
   `SignatureDoesNotMatch`; they were dead keys, not live production access.

*Automation:* `pnpm test:envs --sm` runs `scripts/secrets-sm-parity.py check`,
which fails on any Secrets Manager or task-definition key that is missing or
different in the file. `scripts/secrets-file-only.allowlist` and
`scripts/secrets-sm-quarantine.allowlist` carry the two classes of deliberate
exception, each line with the rotation that removes it.

*Incident:* no outage. The audit found the drift; no deployed environment was
changed.

## A down box has TWO proxy responses; the SDK must treat BOTH as wakeable

Found 2026-08-27 on dev: clicking a session in the sidebar showed "Couldn't
load this conversation." with a Retry that never recovered. Root cause: when a
session's sandbox is down, the sandbox proxy answers a data read
(`/p/<box>/8000/kortix/opencode/messages/<sid>`) in one of two ways depending on
the box's status, and only one was handled:

- status `stopped` → **503 JSON** `sandbox not ready (status: stopped)` — the SDK
  classified this as `SandboxNotReadyError` (a waking state), kept the loader up,
  retried, and the box woke via the `/start` the app fires on open. Recovered.
- status `not-running` → **404 HTML** `This sandbox URL is not active. /
  not-running` — NOT matched by `SANDBOX_NOT_READY_PATTERNS`
  (`packages/sdk/src/core/http/opencode-errors.ts`), whose closest pattern was
  `sandbox is not running` (the literal word "is"). So `readSessionMessagePage`
  (`session-sync-registry.ts`) threw a HARD error →
  `transcriptFreshness='error'` → the dead-end "Couldn't load" with no wake, no
  retry.

The `own-the-surface` reads cutover (#6987) routed the transcript read through
this classifier, which is what exposed it — before, the same box-down 404 went
down a different read path.

**Rules.**
1. A sandbox that is stopped/parked/idle is a WAKEABLE state, never a terminal
   transcript failure. If a proxy can return more than one status/shape for
   "box is down" (503 JSON vs 404 HTML state page here), the classifier must
   accept EVERY one of them — enumerate them from the live wire, not from the
   one you happened to see.
2. Capture the real response BODY before writing the pattern. The fix strings
   (`sandbox url is not active`, `not-running`) came from a captured dev 404,
   not a guess — and they are specific enough to never match a genuine
   `{"message":"Not found"}` 404 (asserted by a test).
3. A control-plane status (`/start` said `ready`) can be stale against the data
   proxy's live view (`not-running`). Do not trust one as proof of the other;
   the read that actually failed is the truth.
4. Follow-up recorded, not yet done: the proxy should return the SAME 503 for
   `not-running` as it does for `stopped`, so there is one down-box response
   instead of two. Classifier breadth is the belt; proxy consistency is the
   suspenders.

*Automation:* `packages/sdk/src/browser/session-sync/session-sync-registry.test.ts`
pins that the `not-running` 404 throws `SandboxNotReadyError` while a genuine
404 stays a hard error; `opencode-errors.test.ts` guards the pattern set.

*Incident:* PR #6999 (`7060b2b2cc`), merged + dev-deployed 2026-08-27. TDD
fix, no code change beyond two regex patterns. No data loss — messages sent at a
dead composer were always durable inbox rows; only the transcript READ
dead-ended.

## Separate runtime principals require a separate RPC credential

Found 2026-09-03 on the `pi-worker` preview. Worker and environment PATs became
distinct runtime principals. `LazyKortixEnv` still signed environment RPC with
the worker PAT. The environment daemon still verified the signature with its
own PAT. Every Bash and file call therefore returned `401`, which the worker
rendered as a generic environment error. Unit tests used one shared token on
both sides and could not detect the broken boundary.

**Rules.**
1. A credential that identifies one runtime must not authenticate a different
   runtime's private endpoint.
2. Cross-runtime RPC must use a purpose-bound secret that grants no control-plane
   API access.
3. An integration test for two runtime principals must use different PAT values.
   A shared test token recreates the coupling that production removed.
4. A global project-scope gate and the route handler must accept the same runtime
   principal types. Handler support is unreachable when middleware denies first.

*Automation:* `env-rpc-worker-integration.test.ts` uses distinct worker PAT,
environment PAT, and RPC secret values across the real client and daemon router.
`env-rpc.test.ts` rejects an environment PAT as an RPC signature.
`project-audit-ingestion.test.ts` and `auth.test.ts` pin environment callbacks
and the session-bound boot-timeline middleware allowance.

*Incident:* The branch preview returned two environment tool errors before the
fix. No production or dev deployment received this branch. The affected preview
sessions were stopped after verification.
## OAuth loopback redirect URIs are protocol data, not perimeter SSRF attempts

- **Incident (2026-08-28, v0.13.7 release QA):** flow `OAU-8` received an HTML
  `403` before the API for `GET /v1/oauth/authorize` when `redirect_uri` used
  `http://localhost` or `http://127.0.0.1`. The same request reached the API
  when it used an HTTPS public origin. Dev, staging, and production reproduced
  the block. The AWS Common managed rule group classified the loopback query
  argument as SSRF, but OAuth public and native clients require loopback
  redirects.
- **Rule:** exclude loopback redirect values from the Common managed rule group
  only when the method is `GET`, the path is exactly `/v1/oauth/authorize`, and
  `redirect_uri` starts with `http://localhost` or `http://127.0.0.1`. Do not
  disable the managed rule or its query inspection globally. Keep
  KnownBadInputs and IP reputation inspection active. The API must validate the
  complete redirect URI against the registered client.
- **Enforcement:**
  `infra/terraform/scripts/test_web_waf_associations.py` pins the scoped
  Terraform statement. Deployed release flow `OAU-8` proves that a registered
  loopback redirect reaches the API and completes authorization.

## Release assertions must follow the named data source, not an obsolete availability bit

- **Incident (2026-08-29, v0.13.7 release QA):** `SESS-24` failed two exact-SHA
  staging attempts after a stopped session returned `available:true`. The API
  was correct. `buildSessionTranscriptDigest()` intentionally serves the
  durable transcript mirror for a stopped session. Its unit test already pinned
  `source:"mirror"`. The end-to-end contract still expected the deleted
  `available:false` behavior from before the mirror existed.
- **Rule:** when a response can come from live, mirror, or no source, assert the
  `source` discriminator and the required content. Do not use `available` alone
  as a proxy for runtime state. Update the natural-language contract in the same
  change that adds or removes a source.
- **Enforcement:** `SESS-24` now stops the sandbox, requires
  `available:true` plus `source:"mirror"`, and verifies session isolation in the
  mirrored content. `session-transcript.test.ts` separately pins the stopped
  session mirror and the no-mirror `available:false` path.
## A root-only package smoke can publish a broken optional entry point

- **Incident (2026-08-29, v0.13.7 npm release):** a fresh consumer could import
  `@kortix/sdk` and `@kortix/sdk/server`, but `@kortix/sdk/react` failed after
  installing its documented peers. The React graph reached
  `@kortix/llm-catalog/dist/index.js`, which exported `./enablement` without the
  `.js` extension required by plain Node ESM. Repository typechecks and the
  root-only packed-artifact smoke did not traverse that graph.
- **Rule:** a publish smoke must install every documented optional peer and
  import every public entry point that those peers enable. TypeScript
  `moduleResolution:"Bundler"` does not repair extensionless relative imports
  in emitted Node ESM. Source imports must name the emitted `.js` file.
- **Enforcement:** `packages/sdk/scripts/smoke-install.mjs` installs React and
  TanStack Query, imports `@kortix/sdk/react`, and asserts `useSession` exists.
  The `@kortix/llm-catalog` build runs `tsc-alias --resolve-full-paths` to turn
  its extensionless workspace import into `./enablement.js` after `tsc` emits.

---

## A guard nobody armed is not a guard, and a path-only allowlist is a hole (2026-08-29)

Audit of the plaintext-`.env` defenses, prompted by "are we sure a new dev
can't commit a plaintext .env?". Three defenses existed. Two did not do what
the docs claimed.

**1. The pre-commit hook was never armed.** `.githooks/pre-commit` is
version-controlled and good — it auto-*encrypts* every staged `.env`. But it
only runs after `git config core.hooksPath .githooks`, which nothing executed.
No `prepare`, no `postinstall`, not in `scripts/setup-env.sh`, not in README or
CONTRIBUTING. It was documented in the hook's own comment header and one line of
an agent skill file. A clone + `pnpm install` + `git commit` had **zero** local
protection. Proven in a throwaway repo: hooks unarmed → `sk_live_…` landed in
the commit; hooks armed → the same commit carried ciphertext, plaintext grep
count `0`.

**2. gitleaks was allowlisted over the exact leak surface.** `.gitleaks.toml`
allowlist #1 named the six encrypted profiles by `paths` with **no**
`condition = "AND"` and **no** `regexes`. A gitleaks allowlist that only
constrains paths exempts every finding in those files. A committed plaintext
`apps/api/.env` holding a Postgres password, an HMAC secret, and a
Stripe-shaped key scanned as `no leaks found`, exit `0`. The other three
allowlists in the same file were written correctly, with `condition = "AND"`
— the bug was one missing line in one block.

**3. The remaining net was thinner than assumed.** GitHub push protection is
enabled, but is provider-pattern based. After tightening the allowlist, gitleaks
caught `INTERNAL_HMAC_SECRET` (generic-api-key) and still missed the plaintext
`postgres://kortix:S3cr3tP4ssw0rd@host` URL.

**Rules.**
1. **A guard that requires a manual activation step is off.** Assume every
   optional setup line was skipped, because it was. Arm it from something the
   developer already runs — here, the root `package.json` `prepare` script,
   which `pnpm install` executes (verified: `core.hooksPath` = `.githooks`
   after a bare `pnpm install`).
2. **Never write a path-only gitleaks allowlist.** `paths` alone exempts the
   whole file. Pair it with `condition = "AND"` **and** `regexes` (plus
   `regexTarget = "line"` when exempting a file *format* rather than a value)
   so only the intended lines are exempt and a real secret still fails.
   `condition = "AND"` with no `regexes` is still path-only — the AND has
   nothing to intersect. The first version of the tripwire below checked only
   the condition and would have passed that shape; review caught it.
3. **Know each gate's shape before trusting it.** `dotenvx ext precommit`
   inspects only the **staged** diff — correct for a hook, a no-op in CI where
   nothing is staged. gitleaks runs on the **pull request** — after the commit,
   after the push, on a public repo. Only the hook runs before the commit
   exists. A gate list is not a defense unless you know when each one fires.
4. **Pattern matching is not a structural guarantee.** For a file format whose
   whole invariant is "every value is ciphertext", assert *that*, not a
   catalogue of secret shapes.
5. Test a security control in **both** directions. "It passes on the real repo"
   proves nothing about whether it fails on a leak.

*Automation:* root `prepare` arms the hooks on `pnpm install`;
`scripts/check-env-encrypted.sh` (`pnpm secrets:check`) structurally asserts
every value in a committed `.env` profile starts with `encrypted:`;
`.github/workflows/secrets-guard.yml` runs it on every PR **and** fails the
build if a path-only allowlist reappears in `.gitleaks.toml`.

*Incident:* No leak occurred. Found by audit, closed the same session. All
findings reproduced in throwaway repos with real gitleaks 8.30.1 and the repo's
own config; no real secret was ever written to disk in plaintext.

## Every build command must declare its executable in that package

- **Incident (2026-08-29, v0.13.8 production release):** the
  `@kortix/llm-catalog` publish job ran `tsc-alias` from its `build` script, but
  the package did not declare `tsc-alias`. Local builds found the executable
  through `@kortix/sdk`. The isolated production publish runner returned exit
  `127`. The workflow then skipped the dependent `@kortix/sdk` publish.
- **Rule:** each publishable package must directly declare every executable in
  its lifecycle scripts. A sibling package dependency does not satisfy this
  requirement.
- **Enforcement:** `packages/llm-catalog/package.json` declares `tsc-alias` in
  `devDependencies`. The package build now resolves the executable through its
  own `node_modules/.bin` directory.

## An action endpoint must refresh a replicated mirror before returning 404

- **Incident (2026-08-29, v0.13.9 release QA):** `CLI-TRG` created a trigger,
  then `triggers ls` and `triggers info` found it through refreshed API
  replicas. The subsequent `triggers fire` request reached a different replica
  whose Git mirror was still inside its 60-second cache interval. That replica
  returned `404 Not found` in two consecutive release-gate attempts.
- **Rule:** a mutable-resource action endpoint can use its replica cache for the
  first lookup. It must force one source refresh before it returns a definitive
  not-found response. A successful read through another replica does not prove
  fleet-wide cache convergence.
- **Enforcement:** `findProjectTriggerBySlug()` retries a missing cached trigger
  through `readManifest(..., { forceRefresh: true })`. A per-project cooldown
  limits forced fetches to one per Git refresh interval. The manual fire route
  uses this helper. Unit tests prove cached-hit, forced-refresh, and bounded-miss
  sequences.

## An explicit pathspec does not isolate concurrent agents — it commits file STATE, not your hunks

- **Incident (2026-08-31, `identity-boundary`):** three implementer agents ran
  in parallel in ONE worktree on verified-disjoint file sets, each instructed to
  commit only its own pathspec. One task's whole job was retiring a bare
  `['accounts']` query key across ~39 call sites, and
  `app/(app)/projects/start/page.tsx` was both on that list and owned by another
  task. The second agent's `git commit -- <its files>` captured the first
  agent's in-flight `useAccountsList` refactor of that shared file. HEAD stayed
  self-consistent only because the other agent later committed the module its
  import needed — but for three commits the branch **did not build**, and a
  commit whose subject says "scope the suppress-auto-project check" contains an
  unrelated key migration. Its `git log`-based reference count also came out
  wrong (43 vs 42), because it measured a worktree another agent was mutating.
- **Rule:** `git commit -- <path>` records that path's CURRENT CONTENT, not the
  hunks you authored, so it is not isolation. Before running implementers in
  parallel on one worktree, compute disjointness against **every task still
  capable of writing — including ones not yet dispatched** — and never run a
  task with a wide call-site surface (a key/API/rename migration) concurrently
  with anything. Otherwise give each agent its own worktree, or serialize. What
  saved this one was luck: both agents completed. Had the migration reported
  BLOCKED — which its brief explicitly invited — half a cutover would have been
  stranded inside another task's commit.
- **Enforcement:** none. A pre-commit check that refuses when a staged path
  carries unstaged changes from another process, or a `pnpm worktree` guard that
  refuses a second concurrent writer, is the TODO. Until then this rule is the
  only guard, alongside the existing `git stash` and shared-worktree entries.

## A pnpm override that pins one exact version forks the dependency graph the moment its dependent moves

- **Incident (2026-08-30..31, dev deploy outage):** three consecutive `main`
  deploys (`528ad10a`, `20027210`, `9bfc0685`) failed on `Waiter ServicesStable`
  for `kortix-dev-web`. The frontend container exited 1 at boot with
  `Cannot find module 'next'`. Root override `"next@>=15.0.0 <16.3.0": "16.3.0"`
  mapped `apps/whitelabel-demo`'s declared `next: 15.5.21` onto `16.3.0`. While
  `apps/web` was itself on 16.3.0 both apps shared one resolved package. PR
  #7067 moved `apps/web` to 16.3.3; the override kept whitelabel on 16.3.0, so
  the lockfile resolved TWO `next` packages. The `.next/standalone` trace then
  contained a partial 16.3.0 copy (a `dist/` without `package.json`), and the
  Dockerfile relink loop linked `node_modules/next` to it by sort order. Dev
  served the previous image (`95f60297`) for ~22 hours.
- **Rule:** an override that maps a range to one exact version must move in the
  same commit as the direct dependency it shadows. `--frozen-lockfile` cannot
  catch the drift: it compares the lockfile against post-override specs, so the
  divergence is green in CI and only fails at container boot.
- **Enforcement:** `apps/web/scripts/single-next-version.test.mjs` fails the web
  test suite whenever `pnpm-lock.yaml` resolves more than one version of
  `next`. The override now reads `"next@>=15.0.0 <16.3.3": "16.3.3"` and
  `apps/whitelabel-demo` declares `next: 16.3.3` explicitly.

## Renaming an applied migration requires a name-and-order ledger repair

- **Incident (2026-09-03, `pi-worker` preview):** two Pi migrations initially
  used timestamps before migrations already merged into `main`. Moving the Pi
  files after the merged migrations fixed fresh and sequential migration gates.
  The persistent preview database still recorded the old names and their old
  `run_on` order. `node-pg-migrate` rejected startup before the API bound port
  `8080`, and the preview hostname returned `502` during the failed cutover. A
  first repair tried to interpolate the renamed rows between adjacent `run_on`
  values. PostgreSQL preserved sub-millisecond precision, but the Node `Date`
  conversion collapsed both bounds to the same millisecond and rejected the
  second preview deployment.
- **Rule:** never rename an applied migration without a checksum-guarded ledger
  repair. The repair must update both `name` and `run_on` when the rename crosses
  other applied migrations. A fresh database cannot prove this upgrade path.
- **Enforcement:** `migration-ledger-repair.test.ts` pins both Pi name mappings.
  `migration-ledger-repair.integration.test.ts` builds a historical ledger with
  identical sub-millisecond timestamps, runs the locked repair, and requires
  strict `node-pg-migrate` order to report no pending migrations. The repair
  normalizes the affected ledger suffix inside PostgreSQL at microsecond
  precision; it never round-trips ordering bounds through JavaScript.

## A single-origin preview turns service base paths into part of the test contract

- **Incident (2026-09-03, `pi-worker` preview):** `target-full` configured the
  standalone gateway as `https://pi.kortix.com/_gateway`. The black-box client
  reduced every configured URL to its origin, so gateway `/health` reached the
  API `/health`, and gateway `/v1/*` calls reached API routes or 404 responses.
  The same preview disabled its landing page while the browser lane required
  the public `/` and `/pricing` contracts.
- **Rule:** preserve a deployed service's configured path prefix when requests
  use service-relative route templates. A preview runtime configuration must
  expose every public surface that its strict target suite exercises.
- **Enforcement:** `Client.forBaseUrl()` keeps the prefix through auth and retry
  clones while retaining the original coverage key. `client-resilience.test.ts`
  pins prefixed and root service URLs. `preview-stack.test.ts` requires preview
  marketing pages to remain enabled.
## A column declared in schema.ts but absent from the migration ledger passes every drift gate (2026-09-03)

*Incident (2026-09-03, ~16:30 UTC onward, every Kortix environment).* Every
session start failed with `The sandbox provider could not start this session.
Try again.` Platinum answered every `POST /v1/sandboxes` that carried an
`Idempotency-Key` with `500 {"error":"column \"expected\" does not exist"}`.
Kortix sends that header on every create (`KORTIX_PLATINUM_CREATE_DEDUP`,
default ON). Local, dev and prod share one Platinum org, so one Platinum
deploy took all three down at once.

Root cause in the Platinum repo: PR #759 (`f9e63339`) added `expected:
jsonb('expected')` to `sandboxIdempotencyKeys` in `apps/api/src/db/schema.ts`
and shipped no migration for it. The create handler does a full-row
`db.select().from(sandboxIdempotencyKeys)`, so the first request after the prod
deploy of `2d752cca` hit the missing column. The migrator printed `[migrate] up
to date`, the PR drift lane passed, and the nightly DB Drift Sentinel passed:
all three compare **migrations against the database**. None compares
**schema.ts against migrations**, which is the only comparison that could have
caught this.

Kortix-side signature, so the next reader recognises the class in one log
read: `[provision-timeline] deliver … total=6ms … outcome: "unreachable"` (a
delivery that never touched the network, because `continueSession` returns
`unreachable` on `project_sessions.status = 'failed'`), then `runtime
unreachable after 3 attempts` dead-letters ~10.5 min later (30 s + 120 s +
480 s ladder). A `POST /v1/sandboxes` WITHOUT the header returning 201 confirms
the class.

**The rules.**

1. **A schema change lands with its migration in the same commit, and CI proves
   the pair agree.** `drizzle-kit generate` (or `drizzle-kit check`) on the PR
   head must emit nothing; a non-empty diff fails the lane. A migrations-vs-DB
   comparison cannot see a column that exists only in code.
2. **A provider outage needs a Kortix-side lever that a person can flip in one
   place.** `KORTIX_PLATINUM_CREATE_DEDUP=0` in `apps/api/.env.local` (local)
   or the deploy env (dev/prod) drops the header and restores session starts
   while the provider ships its fix. Cost: create dedup is off while it is set.
3. **Restart the local API through its supervisor, never with a bare kill.**
   `dev-local.sh` relaunches the API only when `$TUNNEL_URL_FILE.rotated`
   exists; a bare `pkill` ends `pnpm dev`. Env changes need the relaunch
   because `dotenvx run` injects `.env.local` at process start.

*Fix:* Platinum migration `0068_sandbox_idempotency_keys_expected.sql`
(`ADD COLUMN IF NOT EXISTS "expected" jsonb`, expand-only) plus journal idx 68.
*Enforcer:* none yet in Platinum — rule 1 is the CI lane to add there.
