# Pi worker verification — 2026-09-07

Branch: `pi-worker`. No merge to `main`, `staging`, or `prod`.
Draft PR: [#6998](https://github.com/kortix-ai/suna/pull/6998).
Preview: [pi.kortix.com](https://pi.kortix.com).
Architecture: [walkthrough, Q&A, and diagram](./PI_WORKER_WALKTHROUGH.md).

## Source and deployment

This session started at `0ea36cfd55483344184ab70080f75505547c4024` with extensive
uncommitted Pi compatibility work. Local working-tree results include that work.
Separate source snapshots verify the selected SDK, worker, composer, and daemon
changes without relying on the remaining worker/API changes.

The manual-stop fix deployed as `b67a248bea8bc5671d4b411c34869eff0c12c5ca`, from
[run 34110201077](https://github.com/kortix-ai/suna/actions/runs/34110201077).
Its health returned that exact SHA and `started_at: 2026-09-07T10:17:15.716Z`.

The latest verified browser deployment is `5d619e7a8b322e778e8e198f0f2b7a04979b7901`, from
[run 34106940711](https://github.com/kortix-ai/suna/actions/runs/34106940711).
`GET /v1/health` returned `status: ok`, `environment: preview`, that exact commit,
and `started_at: 2026-09-07T09:41:45.170Z`.

The runtime image fixes deployed as `9070cfc35a98837d623d622fce5f4229e8521e7d`, from
[run 34108412024](https://github.com/kortix-ai/suna/actions/runs/34108412024).
Its health returned that exact SHA and `started_at: 2026-09-07T09:57:07.635Z`.

Earlier behavior checks used `a3772d7d19`, `48d887c641`, and `a800b78de9`, as identified
below. A deployment success is not a full-test pass. The strict target suite remains red.

## Fixes made during verification

| Change | Failure addressed |
|---|---|
| Lazy environment startup by default | Text-only prompts created full compute unnecessarily |
| Ripgrep in environment images | `glob` and `grep` failed with shell exit `127` |
| Environment's own proxy service credential | Workspace file requests returned `503` |
| Authenticated `/global/event` SSE | The installed client had no compatible global stream |
| SDK environment routing and readiness | Project, file, and Git requests reached the worker and returned `404` |
| Output viewer workspace resolution | Opening an output fetched before an environment URL existed |
| Fixed Pi composer choices | The UI offered model and agent changes the compiled worker ignored |
| Typed Bun test declaration | Web typechecking reported 17 parameterized-test errors |
| Persisted wire IDs and parent IDs | Restart reminted history; the API merged duplicate messages |
| Synchronized standalone Bun lockfile | The worker image's frozen dependency install failed |
| Inline file opening before availability probing | An absent environment was cached as a missing file |
| Native file readiness gate and SDK health proof | File reads returned `404` while checkout was still running |
| Decoded LLM response headers | OpenCode failed with `ZlibError` when the proxy retained gzip headers |
| Runtime layer v46 | First-request fixes could remain staged behind the daemon update grace period |
| Trigger assertions select by slug and read back | Seeded triggers changed the first list entry |
| Transcript assertion requires a completed assistant | The echoed user prompt satisfied the reply wait |
| Manual stop awaits durable capture | Completed replies disappeared from the API after runtime shutdown |

## Live Pi behavior

The test project was `80b8142e-02b8-456d-8684-bff4d3e5718e` (`pi-lab`).
The initial main test session was `9d32c115-8fcc-4c6d-b2dd-99f874d5ce67`.
Its worker was `36a8e473-3e04-4d95-b2c9-e1a47b9def1d`; its environment was
`e619d124-6aad-4160-a290-853a0c73aad5`. Those are distinct runtime identities.

1. **Text without compute.** `POST /session/:id/prompt_async` returned `204`.
   `/global/event` returned `200 text/event-stream` and message delta events.
   The reply was `PI_TEXT_ONLY_THIRD_20260907`. Worker health reported
   `environment.attached: false`, `rpcCalls: 0`, and `confined: true`.
   The environment read returned `404`.
2. **Six remote tools.** Bash returned `/workspace` and `rg --version` returned
   `14.1.0` without installation. Write, read, edit, glob, and grep completed in
   the environment. The file changed from `PI_NEW_ALPHA` to `PI_NEW_BETA`.
   Later calls reused the same environment.
3. **Browser output and files.** Outputs → `proof.txt` showed workspace startup,
   then `PI_NEW_BETA`. The Files panel loaded the repository tree. API logs recorded
   environment-scoped `200` requests for `/project/current`, `/file`,
   `/file/content`, `/file/status`, and `/vcs/diff` at 07:37–07:38 UTC.
4. **Browser terminal.** `printf 'PI_PTY_20260907\n'; pwd` returned the marker and
   `/workspace`. The shell prompt contained the environment ID.
5. **Stopped history and persisted files.** Session stop returned `200`. Session
   and environment reads reported `stopped`. `/open-bundle` returned the completed
   tool result in 155 ms. Resume preserved the native conversation ID. After
   environment readiness, `/file/content` returned `200` with `PI_NEW_BETA`.
   The identity defect found by counting these messages is described below.
6. **Shared filesystem CLI.** Real `kortix fs create`, `put`, `get`, `list`,
   `del`, and `rm` processes exited `0`. The 22-byte payload round-tripped exactly.
   Its SHA-256 was `3c2f4cedf6928d16fd16f3a9f70a70a78a80a37fa8785d0f3688b51b093c1fad`.
   File and filesystem deletion were verified.
7. **Negative requests.** Unauthenticated worker SSE, environment file reads,
   and shared-filesystem listing returned `401`. An unknown native conversation
   returned `404` through the authenticated worker proxy.

### Durable identity after restart

Before the fix, one session had 15 messages before stop. Resume and a new two-message
turn produced 32 API messages instead of 17. The worker restored old content with new
IDs, so the API merged the old and restored copies.

The regression first failed against the committed source. The fix persists wire IDs
and assistant parent IDs inside Pi messages. Legacy entries receive deterministic
fallback IDs. Identical text in separate turns remains separate conversation data.

Fresh session `b20f520f-3064-45a8-918c-96ad4933b38c` verified the fix on deployment
`48d887c641`. Its worker was `c0739908-2e39-47a7-9b62-c08bf8d8b4c7`, with native
conversation `ses_pif71d2ddc49041da6a276150e`.

- Two identical text prompts with distinct message IDs produced four messages.
- Two stop/resume cycles preserved message IDs, part IDs, and assistant parents.
- The API bundle retained four messages, with zero duplicates.
- A fresh six-tool turn completed in 18.8 seconds and ended `PI_DURABLE_SIX_VERIFIED`.
  It used environment `3a097cd6-94b1-406c-86da-305ceecff848`.
- A third stop/resume preserved all 16 messages, including the six-tool turn and
  browser prompts. Part identities and parents stayed equal. API duplicate count: zero.
- The last resume readiness poll completed in 3,061 ms. Worker-reported boot time
  was 647 ms. Those are separate measurements, not a latency percentile.

The worker health `sourceSha` identifies the project configuration commit. It is not
an API deployment SHA. The fix does not repair mirrors already duplicated by an older build.

### Opening a file before compute exists

The browser reproduced two distinct failures in the fresh session:

- Before `a800b78de9`, clicking inline `/workspace/kortix.yaml` removed its button.
  Availability probing treated the absent environment as a missing file.
- On `a800b78de9`, clicking it created an environment. The viewer's first read
  returned `404` during checkout. The same absolute and relative paths returned
  `200` after checkout finished.

Commit `cba7028373` moves the existing workspace readiness checks ahead of native
file, search, and presentation routes. Booting returns `503` so existing client
readiness retries remain active. A missing file returns `404` after startup.
This gate does not require a running OpenCode process.

The first retest still reached an older guest daemon with `agentSwapPending: true`.
The daemon intentionally waits five minutes before self-update. API deployment does
not prove that every guest already runs its replacement binary.

Commit `5d619e7a8b` adds an SDK readiness check before exposing an environment URL.
Both `useSessionWorkspace` and session-scoped file methods use it. Provisioning,
unknown health bodies, and transient failures remain pending. Boot and auth failures
are explicit. This also protects clients connected to older environment images.

Final browser session `46fcda95-8483-40bb-97d6-1dddfdf14478` opened inline
`/workspace/kortix.yaml` on that deployment. The pane showed the waking state and
then rendered the manifest automatically. API logs record, in order:

- 09:46:33 UTC: session `/environment/ensure` → `200`.
- 09:46:34 UTC: environment `/kortix/health` → `200`.
- 09:46:34 UTC: environment `/file/content` → `200`.

Those requests targeted environment `61363420-1525-4307-ae0d-1b59d884fbee`, not its
worker `a81a5e53-6d52-451f-a528-77c4810a30f3`. The browser assertion checked visible
`kortix_version: 3` and `default_agent: kortix`. A screenshot records the result.

The real SDK also resumed the earlier identity session, read `PI_NEW_BETA` in
7,476 ms, deleted the file, verified `File not found` on read-back, removed the empty
test directory, and stopped the session.

## Local gates

| Command or check | Result |
|---|---|
| `pnpm test` after wire identity and manual-stop fixes | 395/395 REST/CLI flows; root and companion lanes passed |
| `pnpm test -- --packages-only` | Passed in 209.2 s |
| `pnpm test -- --browser-only` | 16 passed, 2 skipped |
| Worker suite, selected committed source | 186 passed, 0 failed; 435 assertions |
| Worker suite, wider working tree before identity regression | 378 passed, 0 failed |
| SDK suite after workspace health gate | 2,843 passed, 0 failed; 196 files |
| Earlier SDK suite, selected source | 2,835 passed, 0 failed |
| SDK typecheck and `smoke:install` | Passed; packed SDK imported and constructed in Node ESM |
| Full web suite | 9,433 passed, 0 failed |
| Selected composer snapshot tests | 90 passed, 0 failed; 203 assertions |
| Inline Markdown, availability, and viewer tests | 37 passed, 0 failed; 119 assertions |
| `pnpm --filter kortixd test` after readiness fix | 1,175 passed, 0 failed; 3,635 assertions |
| File/proxy tests, selected committed source | 78 passed, 0 failed; 281 assertions |
| LLM proxy compressed SSE regression and suite | 12 passed, 0 failed; 45 assertions |
| Runtime fingerprint and image-layer checks | 31 passed, 0 failed; 129 assertions, 2 snapshots |
| `pnpm --filter kortixd typecheck` | Passed |
| Web `tsc --noEmit` | Passed |
| Focused inline-file ESLint | Passed |
| Composer ESLint | 0 errors, 53 existing warnings |
| API typecheck after manual-stop fix | Passed |
| Manual stop and transcript tests, working tree and selected source | 68 passed, 0 failed; 212 assertions |
| Worker standalone `bun install --frozen-lockfile --ignore-scripts` | Passed; 103 packages |

The SDK prompt, SDK workspace routing, worker SSE, durable identity, and native file
readiness regressions ran red before their implementations. One full web run hit a
Bun worker SIGSEGV; an unchanged rerun passed all 9,433 tests. Generated content
timestamps were refreshed before the successful run.

The brand audit reports existing findings in the large session components. The
composer change preserves those styles. This is not a clean audit of all legacy UI.

`pnpm test -- --id SESS-24` cannot select that flow locally: the deterministic profile
excludes its `funded, daytona` capabilities. Its valid target is the deployed preview.

## Full deployed suite and targeted reruns

[Run 34096179989](https://github.com/kortix-ai/suna/actions/runs/34096179989) ran
`pnpm test -- --target-full` against `a3772d7d19`. The browser lane passed 18 tests.
The API lane reported **445/461 passed, 13 failed, 3 skipped (2 quarantined)**.
The overall run failed. The report is `20260907074001-b8d35x/report.html` under
the preview's `tests/test-results` directory.

The nine-flow rerun against `48d887c641` passed **8/9** in 75.5 seconds:
`TRG-2`, `TRG-3`, `RUN-1`, `RUN-2`, `RUN-3`, `RUN-9`, `SESS-10`, and `SESS-25`.
`SESS-24` still failed its stopped-mirror assertion. Its wait accepted the echoed
user prompt as the assistant reply. The corrected assertion requires the assistant
role, completion timestamp, and exact reply.

The corrected flow ran against `782a18269a` as `20260907092001-nkcjf0`. Session A
completed its exact reply. Session B ended with an `APIError`: `Response decompression
failed`, with `ZlibError` from `http://127.0.0.1:4319/chat/completions`. The test
correctly failed. It did not reach the stopped-history assertion.

A real gzip SSE fixture reproduced that same exception through the local LLM proxy.
Commit `428589b9cc` removes stale response `Content-Encoding` and `Content-Length`
after fetch decodes the body. Its 12-test suite and typecheck pass. Runtime layer
v46 bakes this and the native readiness fix into new images, before deferred updates.
The rerun on `9070cfc35a`, `20260907100704-jn81pk`, completed both assistant replies.
It passed runtime identity, reply isolation, stop, and stable detail reads. The stopped
transcript still returned `available: false`; no turn-end capture had persisted it.

Commit `b67a248bea` makes manual stop await capture after abort and before provider
shutdown. The capture's existing runtime-read timeout remains eight seconds. Capture
failure does not prevent stopping an unreachable runtime. Its regression holds the
capture promise open and proves the provider receives no stop until persistence ends.
The 68 focused tests pass both in the working tree and a selected-source snapshot.
The final focused rerun on `b67a248bea`, `20260907101800-9ypn96`, passed **1/1**
in 30.5 seconds. SESS-24's eight steps completed, including exact assistant replies,
independent runtime identities, provider stop, and the durable mirror read.

A separate Pi check resumed session `b20f520f-3064-45a8-918c-96ad4933b38c` through
the real SDK. Manual stop returned `200`. The subsequent sync transcript returned
`source: mirror` with the same 16 message IDs and 16 part IDs. Stop plus mirror read
took 2,913 ms. The session finished stopped again.

These are separate runs against named revisions. They must not be combined into a
claim that the latest full suite passed.

### Final full run on b67a248bea

The final `pnpm test -- --target-full` verified the deployed API and gateway SHA
as `b67a248bea8bc5671d4b411c34869eff0c12c5ca`. Its API lane reported **452/461 passed,
6 failed, 3 skipped (2 quarantined)** in 548.2 seconds. The public
[API report](https://pi.kortix.com/_tests/20260907102219-8ywm5b/report.html)
records the complete requests and responses.

The manual browser launch initially searched `/.cache/ms-playwright`, while the
warm image stores Chromium in `/root/.cache/ms-playwright`. The first browser lane
failed before launch. With `PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright`,
`pnpm test -- --target-browser-full` ran all 18 journeys: **17 passed, 1 failed**
in 189.6 seconds. This is a separate rerun, not a green full gate.

Remaining failures on this revision:

| Flow | Observed failure |
|---|---|
| SHIP-1, SHIP-4, SHIP-6, SHIP-9 | Public provider ingress rejects the Git upload with 502 |
| SESS-13 | A ready file-share response contains `public_url: null`; the preview has no dedicated preview domain |
| RUN-9 | After abort, the second OpenCode prompt creates an empty assistant message that never completes within the test deadline |
| Browser admin console | `/admin` keeps rendering `Admin access required` after the test inserts its synthetic super-admin grant |

The API process confirms `KORTIX_PREVIEW_BASE_DOMAIN` is absent. No wildcard domain
or certificate was invented to satisfy the file-sharing test. The RUN-9 transcript
contains the distinct second user prompt and an unfinished assistant placeholder;
it contains no completed second reply and no reported API error. This flow passed
an earlier focused run but failed under the final full run. Its cause is unresolved.
The admin spec also failed when run alone after the API suite finished; its role
probe failure is not limited to overlap with the full API suite.

### Remaining Git upload failure

`SHIP-1`, `SHIP-4`, `SHIP-6`, and `SHIP-9` fail while pushing Git packs through the
Platinum preview ingress. The focused CLI repro traced a 338,374-byte POST returning
`502` after 32.6 seconds. Small Git discovery requests returned `200`.

A direct comparison isolates the failing boundary:

| Same unauthorized Git POST | Result |
|---|---|
| Public `pi.kortix.com`, 128 bytes | API `401`, request ID present |
| Public `pi.kortix.com`, 340,000 bytes | `502`, no API request ID |
| Direct Platinum public origin, 340,000 bytes | `502` after about 32–36 s |
| Direct Platinum origin, chunked 340,000 bytes | `502` after 34.6 s |
| Inside preview, `http://127.0.0.1:8080`, 340,000 bytes | API `401` in 3 ms |
| Inside preview, same endpoint, 1,048,576 bytes | API `401` in 4 ms |

The provider HTML reports `upstream-closed-before-headers`. Fixed-length and chunked
bodies both fail through its public origin. This is outside the API/Caddy request
path. No speculative Git API or Cloudflare forwarding change was applied.

## Cleanup and limits

- The two initial test sessions are stopped. Their dedicated `.pi-e2e-20260907`
  and `.pi-new-e2e-20260907` directories are removed. Other project sessions remain untouched.
- The identity session and both final file-test sessions are also stopped.
  The identity session's `.pi-identity-e2e-20260907` directory is removed.
- One older environment had stopped at the provider while its row was active.
  A prompt's environment sync returned `503`. Explicit environment ensure resumed it;
  cleanup then completed. Independent environment-stop recovery needs further coverage.
- A new environment image took 358 seconds in the first focused Pi probe. The default
  tool attachment deadline is 180 seconds. Retrying after image readiness passed.
- Absolute Markdown anchors remain blocked by the renderer. Inline code paths and
  Outputs use the file-preview flow described above.
- Durable turn ownership/recovery, compiled skills, questions, and permissions still
  include uncommitted worker/API changes. Local passes do not deploy them.
- Custom tools, plugins, hooks, MCP, subagents, compaction, rewind, and attachment
  parity are incomplete. The Pi preview is not a full OpenCode replacement.
- The blocking `/session/:id/message` compatibility path is not a verified submission
  contract. The asynchronous prompt path is the tested client contract.
- Worker allocation is 1 vCPU, 2 GiB RAM, and 8 GiB disk. These are not image-size
  measurements. No matched-provider Pi/OpenCode latency comparison ran here.
- Dev and production deployments remain outside this branch-only delivery.

Production readiness: **NOT YET**.
