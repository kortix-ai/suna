# Pi worker verification — 2026-09-07

Branch: `pi-worker`. No merge to `main`, `staging`, or `prod`.
Draft PR: [#6998](https://github.com/kortix-ai/suna/pull/6998).
Preview: [pi.kortix.com](https://pi.kortix.com).
Architecture: [walkthrough, Q&A, and diagram](./PI_WORKER_WALKTHROUGH.md).

Latest UI and streaming checks: [runtime UI verification](./PI_RUNTIME_UI_VERIFICATION.md).

## Source and deployment

This session started at `0ea36cfd55483344184ab70080f75505547c4024` with extensive
uncommitted Pi compatibility work. Local working-tree results include that work.
Separate source snapshots verify the selected SDK, worker, composer, and daemon
changes without relying on the remaining worker/API changes.

The manual-stop fix deployed as `b67a248bea8bc5671d4b411c34869eff0c12c5ca`, from
[run 34110201077](https://github.com/kortix-ai/suna/actions/runs/34110201077).
Its health returned that exact SHA and `started_at: 2026-09-07T10:17:15.716Z`.

The earlier browser deployment is `5d619e7a8b322e778e8e198f0f2b7a04979b7901`, from
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


## Execution-only environment and web retrieval — 2026-09-08

YAML v3 selects Pi. YAML v2 selects OpenCode. An explicit contradictory runtime
or `runtime: null` fails validation. Pi session creation no longer depends on the
legacy `pi_worker` flag. Existing conversations retain their installed config SHA.

The Pi environment daemon serves files, shell, Git, PTY, and previews. It reports
`workload: environment` and `opencode: disabled`. Upgrades preserve workspace
bytes and the selected Git branch. The process matcher excludes provider PID 1.
The regression test includes a provider command containing the Kortix entrypoint.
Preview `a218bc6aa1a65a191d9bcd8ef59fc77632fcb0ca` verifies the upgrade on
Daytona environment `783c0301-be40-4f3e-a4d9-36fcf2f44779`. Native health reports
`runtimeReady: true`, `workload: environment`, and `opencode: disabled`.
The process inventory contains zero Pi workers and zero OpenCode servers.
The existing note retains SHA-256
`24c44e1096bfd8dc047e0991d24de9d1b74c707a9ebd8b49925017c45ecfdf79`.
The workspace retains its session branch and commit `7b0f812ede3a659d14249b2db1538b9f0cf992d9`.

The worker adds `webfetch` for public HTTP(S) pages. It returns Markdown, text,
or HTML. It does not start the environment. It validates DNS destinations and
redirects, pins the connection to the validated address, and retains TLS hostname
verification. URL permissions apply before the request and to redirect targets.
A redirect requiring approval returns its URL for a separate approved tool call.
The worker sends no session credential or browser cookie to a page.

Limits: five redirects, 30 seconds by default, a configurable maximum of 120
seconds, 5 MiB of received or decompressed data, and 128 KiB of returned text.
Stop cancels DNS, header waits, and streamed bodies. Binary downloads use the
environment. Custom tools cannot replace the built-in `webfetch` tool.

Local verification:

- `pnpm exec bun test apps/kortix-worker/src`: 614 pass, 0 fail, 3,173 assertions.
- `pnpm --filter @kortix/worker typecheck`: exit 0.
- Built worker artifact and Node permission tests: 7 pass, 0 fail, 71 assertions.
- Compiler, manifest, and provider bootstrap tests: 72 pass, 0 fail, 121 assertions.
- Node 22 with filesystem permissions denied reads `https://example.com`, verifies
  TLS, and returns `Example Domain` as Markdown. The same process cannot read
  `/etc/hosts` or write files.

Preview web retrieval passes through the real composer in the original reported
conversation. One `webfetch` call retrieves `https://example.com` as Markdown.
The completed tool envelope contains `Example Domain`. The response renders the
page title, its documentation sentence, and `WEBFETCH_PREVIEW_A218`. The composer
returns to idle. The environment remains stopped. Restarting the worker before
this test preserves all 22 existing message envelopes.

The remaining parity matrix and the full preview suite remain required.


## Manual context compaction and manifest grants — 2026-09-08

Pi implements `POST /session/:id/summarize` with the configured session model.
The existing composer, header, and command palette expose the compaction action.
The request joins the durable turn queue. Stop cancels the native Pi summary call.
The summary uses Pi's compaction preparation, retained context, and file-operation
summary. Compaction performs no environment call. It can use two model calls when
Pi splits a turn between older history and retained recent context.

One fenced native compaction entry stores the summary and its display messages.
The visible transcript remains complete. Later model calls use the summary and
retained context. Replacing the worker preserves both projections. A crash after
the compaction entry commits finishes the journal without another model call.
A crash before it commits records an interrupted attempt and retains the original
context. Oversized summaries fail before modifying the context.

Local coverage includes history fidelity, configured model validation, queued
prompts, idempotent retry, repeated compaction, Stop, oversized output, and both
crash boundaries. Preview `abda3f6557b30422e910c2dc77b8e9bb542473c9` passes the
real command-palette action. The UI shows progress, then an expandable summary.
All 25 earlier message envelopes remain identical. A subsequent prompt recalls
`PI_RESTART_OK_7D19` and `Blue`. Restart restores all 29 resulting envelopes
exactly. The control-plane turn and prompt queues are empty.
Automatic threshold-triggered compaction is not implemented by this change.

Runtime token minting resolves every agent through the shared manifest grant
resolver. A YAML v3 agent named `meta` does not gain the legacy coordinator grant.
Environment image, token grant, and secret grant resolution use the worker's
immutable configuration commit. Focused token/environment tests pass: 14 tests,
39 assertions. The API typecheck passes. The root suite passes all six lanes.


## Automatic compaction before prompts — 2026-09-08

Before a new reply-producing prompt, Pi checks the effective model context.
The estimate includes the incoming prompt, system instructions, and tool schemas.
It reserves 15% of the context window, with an 8,192-token minimum and 25% cap.
Provider usage and a conservative serialized estimate both inform the decision.
The larger estimate wins. Empty history and context-only inputs skip compaction.

The summary commits under the accepted prompt's owner lease. Its marker and
summary persist separately from the pending prompt. Stop or summary failure
prevents that prompt from executing. A later prompt can retry. A crash after the
summary commit preserves it and interrupts the pending prompt without replaying
its model call. Automatic summaries make no environment call.

Sixteen focused tests pass with 138 assertions. These include four threshold
tests and twelve HTTP compaction tests. Automatic compaction inside a running
tool loop and provider context-overflow recovery remain unimplemented.
The real automatic-compaction preview journey is blocked by the Platinum ingress upload failure described below.

The command palette now gates Pi model and agent changes in suggestions, search,
pages, and selection handlers. Manual and automatic summary cards use the neutral
label `Context compacted`. This gating does not implement live reconfiguration.

New Pi starter projects explicitly grant all project skills, matching the base
starter's behavior. Existing project grants remain unchanged. The starter prompt
explains worker web tools, pinned configuration commits, and environment file
persistence. The starter package passes 92 tests with 1,206 assertions.


## Gateway model context limits — 2026-09-08

The Pi fallback previously borrowed the first OpenRouter catalogue entry's limit.
For `gpt-5.6-luna`, that meant 131,072 instead of 1,050,000 tokens. The compiler
now carries the selected gateway model's context and output limits. Explicit
session model overrides carry their own limits through the worker environment.
Unknown aliases have no automatic-compaction threshold. They do not inherit
another model's context window. Health reports the effective limits.

Fifty-five focused tests pass with 195 assertions. Real subprocess tests check
the compiled default, an explicit override, and an unknown alias. API and worker
typechecks pass. Preview `dbcdf5762cca89909d90854382b16192710fccb2` reports
`model_context_window: 1050000` and `model_max_output: 128000` after a real
worker restart. Its native conversation ID remains unchanged.


## White-label runtime controls and streaming — 2026-09-08

The white-label reference app uses the SDK runtime identity to gate live model
and agent changes. The popovers state that these choices are fixed at session
creation. The scope dialog and SDK call examples follow the same rule. The
wrapper model route returns `409 SESSION_MODEL_FIXED_AT_START` before forwarding
a mutation. The API model route applies the same rejection before metadata writes.
This is explicit unsupported behavior; live switching remains outstanding.

The reference app ran with the real `pi.kortix.com` API behind a temporary,
authenticated HTTPS tunnel. Browser checks opened the existing custom `reviewer`
session, inspected both fixed-configuration popovers, and sent a 30-sentence
prompt. The DOM showed the partial answer ending at sentence 27 with Stop visible.
It then showed all 30 sentences and `WHITELABEL_PI_STREAM_B38A`, followed by Stop
clearing. Authenticated read-back found exactly the user and assistant messages,
no assistant error, empty turn/prompt queues, and `404` for the absent environment.
A direct wrapper `PUT /api/session-model` returned the expected 409. The temporary
app and tunnel stopped after verification. The preview API was at `dbcdf5762`.

## Full-preview upload failure — 2026-09-08

The exact `216bd67b174d88504008f0ebe04d96027f745087` target-full run
[34232894475](https://github.com/kortix-ai/suna/actions/runs/34232894475) reports
454/461 API/CLI flows passed, four failed, and three skipped (two quarantined).
All 19 browser journeys passed. `SHIP-1`, `SHIP-4`, `SHIP-6`, and `SHIP-9` fail
when Git uploads receive synthetic 502 responses from the sandbox ingress.

Authenticated probes isolate the boundary. A deliberately malformed 340,000-byte
Git request returns the API's expected 400 in 2 ms directly and 4 ms through the
internal Caddy proxy. The same request through the public origin returns 502 after
35.7 seconds. A 128-byte request returns 400 through both paths. Temporary scoped
PATs were revoked after the probes. These bodies cannot update repository refs.

The automatic-compaction fixture has the correct 1,050,000-token model limit.
Its first 120 KB context-only input also fails at ingress. No context batch was
confirmed accepted. Automatic threshold behavior therefore has local HTTP and
subprocess coverage, but no successful large-context preview journey yet.
The provider ingress failure remains unresolved. It must be fixed before large
prompts, large tool records, Git shipping, and the full preview gate are accepted.


## Storage-outage recovery and API model guard — 2026-09-08

An exhausted transient append now retains its exact JSON item and idempotency
key. The worker blocks unrelated writes while it retries that same item.
Recovery interrupts only its own abandoned lease, then restores durable state.
Permanent rejection and a conflicting fence remain closed. A replacement
worker's lease cannot be interrupted by this recovery path.

Focused tests cover committed and uncommitted responses, repeated outages,
concurrent recovery, permanent rejection, and a competing owner. Two real worker
process journeys cover 6.5-second read/write and write-only store outages. Both
settle the interrupted question, preserve one prior tool execution, and complete
the next prompt. The daemon startup test now holds its capability response until
after construction returns; it no longer uses a 300 ms wall-clock cutoff.

`pnpm test -- --id SESS-28` passes against the local HTTP API: 1/1 flows,
0 failed, 0 skipped. Anonymous/nonmember mutations return 401/403. Pi returns
`409 SESSION_MODEL_FIXED_AT_START` and preserves all metadata. A queued OpenCode
session accepts and stores a native model with `applied_live: false`.

## Resume ingress and product benchmark protocol — 2026-09-08

The benchmark now uses the SDK's readiness contract: create, poll `/start` until
ready with a persisted native conversation ID, then subscribe to `/global/event`
and send the message. Resume requires a stopped session with the specified agent,
base ref, and persisted conversation. Provider, runtime, and all observed models
must match the declaration. Region and allocation-cache outcomes remain declared.

The first live smoke missed `/start`; its timings are invalid product evidence.
After the correction, one new-session smoke reached runtime readiness at 3,909 ms,
connected to SSE in 287 ms, observed first text at 13,628 ms, and confirmed stop.
This is protocol verification, not a latency percentile or a runtime comparison.
The API artifact was `dbcdf5762cca89909d90854382b16192710fccb2`.

A resume exposed two defects. Daytona rotated its preview token after stop. The
old token returned 401; a fresh endpoint returned 502 while no worker listened.
The API now invalidates ingress after wake and retries a rejected session-list
credential once with fresh credentials. Pi process bootstrap runs after the
worker lease becomes active and its compute window reopens. OpenCode skips this
Pi bootstrap. The 100 related tests pass, including permanent auth rejection.
Preview `b1691678d847a075592c7f2698ec45b4d2eea85b` verifies the resume fix.
The same stopped session that failed before the fix becomes ready in 4,802 ms.
Its native conversation ID is unchanged. The SSE connection takes 323 ms;
first text arrives 5,114 ms after message submission. The reply is `READY`.
Cleanup returns 200 and confirms the session is stopped. This single sample
proves recovery and protocol behavior; it is not a runtime comparison.

The real API model guard also returns `409 SESSION_MODEL_FIXED_AT_START` on
that preview SHA. All metadata and the native conversation ID remain unchanged.
Deployment run 34244103153 succeeds on retry after GitHub's artifact service
returns an intermediary 403 during the first download attempt.

The latest local full run passes REST/CLI flows (396/396), SDK, worker, browser
(17 passed, 2 skipped), runner, route coverage, and worktree lanes. Its package
lane fails two snapshot tests after one times out. Those snapshot cases pass
11/11 in isolation after their filesystem-staging timeout is corrected.
A package rerun exposes separate snapshot cleanup, strict timing, and CLI status
failures. The full local gate is not green; focused passes do not replace it.

The exact `b1691678d847a075592c7f2698ec45b4d2eea85b` full-preview run
[34245603663](https://github.com/kortix-ai/suna/actions/runs/34245603663) reports
455/462 API/CLI flows passed, four failed, and three skipped (two quarantined).
The same four Git shipping flows fail at provider ingress. All 19 browser
journeys pass. The API/CLI lane takes 635.8 seconds; the browser lane takes 220.4 seconds.

## Reasoning settings and recovery projection — 2026-09-08

Pi agent Markdown now accepts supported reasoning effort names. The worker
applies the compiled default and accepts per-prompt `variant` values only from
the selected model's supported levels. Gateway model metadata supplies its
reasoning flag and effort list. Unknown aliases no longer clone an unrelated
model's capabilities. Per-prompt settings persist in admission and user-message
metadata. The worker restores its default after each turn.

Real local provider requests verify default, override, no-reasoning, and next-turn
behavior. A subprocess test kills a worker during a question, restores `max`,
executes each workspace action once, sends the next prompt with `none`, and
compares the complete transcript after another restart. The SDK's direct `send`
method forwards `variant` and stops injecting stored OpenCode defaults into Pi.
The React composer control remains gated.

The full worker suite also exposed a status/projection race during outage
recovery. Two controlled storage tests now block the first read after journal
completion. The worker must remain busy until the recovered transcript is
projected. The tests fail before the barrier and pass afterward.

The exact `6c7948ca4acbaf48e49c75dfe92283709c7cb0a4` preview deployment
[34247951847](https://github.com/kortix-ai/suna/actions/runs/34247951847) succeeds.
`/v1/health` reports that commit. A live custom `onPayload` hook confirms `low`
and `high` on actual `gpt-5.6-luna` requests through the SDK. The third prompt's
inspection tool fails with `permission denied: doom_loop`. This is a detected
regression, not a passing reasoning journey. The test session is stopped.

The latest full local run passes 396/396 REST/CLI flows, SDK, browser, route
coverage, runner, and worktree lanes. The worker lane exposes a short write-only
storage outage that cancels a question before its owner lease expires. The API
package lane fails to load two mocks missing `invalidateSandbox`. The CLI lane
also fails a service-account command, which passes in isolation. The full gate
remains red until rerun with the fixes.

## Short outages and repeated tools — 2026-09-08

Heartbeat recovery now retries only this owner's exact pending heartbeat.
A fresh heartbeat must commit before local lease renewal. Unknown transcript
mutations remain blocked. Both 4.2-second read/write and write-only outages
preserve the question under a 10-second lease. A reply completes both tools
once. Existing 6.5-second outages under a 200 ms lease still interrupt the turn.
The 63 focused storage, journal, and question tests pass before the added
heartbeat-specific unit cases.

Repeated-tool history now resets on a new prompt. Recovery reconstructs only
the current prompt's completed calls. A four-prompt HTTP test fails before the
fix and passes afterward. Each prompt executes the same custom environment
operation once. The guard still applies within a recovered prompt. The 47
focused custom-agent, tool-replay, permission-recovery, and journal tests pass.

`pnpm exec bun tests/bin/worker-quality.ts` passes: 670 tests across 78 files,
typecheck, build, and seven bundle/lockdown tests. The two corrected API mock
files pass three tests with nine assertions. The full local gate is rerunning.

## Command reasoning and React SDK transport — 2026-09-08

Command execution now validates reasoning against the compiled model. Precedence
is request variant, compiled command variant, then agent default. Admission stores
the effective value. A turn restores the agent default after completion.
The React SDK preserves a nonempty reasoning option for prompts and commands.
It still omits stale model, agent, and directory selections for Pi.

The new command transport tests fail before implementation. All 36 command and
generation tests pass afterward. The two React regression tests fail before
implementation; all 75 tests in those files pass afterward. The complete SDK
suite passes 2,862 tests with zero failures. SDK typecheck and packed-package
install verification pass. Live command verification is pending deployment.

The updated worker quality gate passes 672 tests, typecheck, build, and seven
bundle/lockdown tests. The full local rerun passes every lane except package
quality, which stalls in one API test worker after the artifact null-config
case. A macOS process sample records the worker consuming a CPU core without
advancing. The complete artifact test file passes 9/9 in isolation. The stalled
full run is not passing evidence.

## Live reasoning, repeated sends, and current gates — 2026-09-08

Preview deployment [34251633535](https://github.com/kortix-ai/suna/actions/runs/34251633535)
succeeds. Public API health reports `34e15f9166513a25a8a28913823e803333876583`.
The isolated fixture uses source `997a1e3091550f55a285acda09957d7fc3f991b5`
on `codex/pi-reasoning-verification`; the project's main branch is unchanged.

The first repeated SDK send returns 200 without creating a message. The SDK now
creates a submission key per send and preserves it through authentication retry.
Its regression test fails before the fix and passes afterward. The complete
SDK suite passes 2,863 tests. Typecheck and packed-package installation pass.

The rebuilt local SDK then completes eight real calls against that preview.
A custom `onPayload` hook observes `gpt-5.6-luna` reasoning efforts in order:
prompt `low`, `high`, `none`, `low`; command `high`, `none`, `max`; prompt `low`.
Each call creates exactly one user message and one completed inspection tool.
Unsupported prompt and command variants return 400 and 409 without history changes.
The real SSE stream contains 256 events, including 136 text deltas.
The browser displays the matching JSON tool results and completed responses.

Session `195b076a-dfc8-4a80-bb6e-7dcf327b6020` preserves all 33 messages and native
conversation `ses_pi8bafa25ab6ae6bcb70b06a69` through stop/resume. Its environment
route returns 404. Cleanup confirms the worker session is stopped. This proves
the local SDK fix against the deployed worker; the SDK fix still needs deployment.

The latest `pnpm test -- --full` run passes 396/396 REST/CLI flows, the SDK lane,
672 worker tests, seven bundle/lockdown tests, and 17 browser journeys (two skipped).
API package tests pass 9,144 with 82 skipped; CLI passes 1,257; daemon passes 1,185.
The package lane fails the agent-tunnel malformed-credentials test at 5,001.75 ms.
`pnpm exec bun test packages/agent-tunnel/src/agent/cli-device-auth.test.ts`
passes both tests with six assertions in 243 ms. The full gate remains red.
Its total duration is 684.5 seconds; package quality takes 450.2 seconds.
The prior artifact-test stall does not recur in this run.

## Worker reasoning choices in the web composer — 2026-09-08

The worker now projects its supported reasoning levels through `/config`,
`/global/config`, and the state config. Only its pinned model appears in this map.
The React SDK uses that map for Pi, even when the project catalog advertises
different levels. It preserves OpenCode's existing catalog behavior.

Pi selections persist per session and model. Auto clears the override. A stale
unsupported selection is omitted. Session reasoning storage retains 200 entries;
ordinary model preferences remain unchanged. The existing Thinking effort control
is enabled only after the worker publishes choices. Model, agent, and attachment
controls retain their separate gates.

Runtime config reads now use a cache key containing the runtime URL. A delayed
read retains its original URL. A failed config update rolls back its original
cache entry even after navigation. Both regression tests fail before the fix.
Worker quality passes 674 tests, typecheck, build, and seven bundle/lockdown tests.
Frontend typecheck passes. Focused host lint reports zero errors and 36 warnings.
The complete SDK suite passes 2,872 tests. SDK typecheck and packed-package
installation pass. The focused composer and selection run passes 27 tests.
The new composer control still needs verification on the deployed preview.

## Deployed reasoning picker and bounded test processes — 2026-09-08

Deployment [34255961347](https://github.com/kortix-ai/suna/actions/runs/34255961347)
succeeds at `95381603803b8269a4fd09a75927610d4e72c251`. Public API health and
the API, frontend, and gateway container tags all report that SHA.

The browser uses reviewer session `2abb0614-6641-4d24-bdf5-acb760d027a7` in
project `80b8142e-02b8-456d-8684-bff4d3e5718e`. Its source is the isolated
`997a1e3091550f55a285acda09957d7fc3f991b5` fixture. Its worker publishes
`none`, `low`, `medium`, `high`, `xhigh`, and `max` through the config response.
The browser menu displays exactly those choices plus Auto.

Three real composer submissions prove High → `high`, None → `none`, and
Auto → an omitted override with provider-observed `low`. Captured POST bodies
contain no model or agent override. Each turn executes one inspection tool.
High survives page reload. Auto also survives reload after clearing the choice.
The browser displays three completed responses and an idle Send control.
The final audit verifies three users, three tools, and six completed assistant
messages without errors. Stop/resume preserves all nine messages byte-for-byte
and retains native conversation `ses_pifb7963069397c158acb07293`.
The environment route returns 404. Temporary browser tabs close before cleanup;
both this session and the prior SDK reasoning session are confirmed stopped.

The local full gate passes REST/CLI 396/396, SDK, worker, browser, runner,
route coverage, and worktree lanes. The package lane stalls in the navigation
test worker. A native process sample and an unreaped child are recorded after
six minutes at approximately 99% CPU. Only that owned worker is terminated.
The full run fails at 905.4 seconds; it is not passing evidence.

The complete web package passes 9,466 tests across 739 files in 32.33 seconds
when run separately. Comparing test names isolates the full-run gap to all eight
navigation-contract tests. Their synchronous grep/ESLint subprocesses now use
awaited execution with timeouts. The previously stalled Pi artifact fixture's
Git setup uses the same mechanism. Assertions and input coverage are unchanged.
Focused checks pass eight navigation tests and nine artifact tests.
`pnpm test -- --full` then passes all eight lanes in 395.4 seconds.
The package lane finishes in 225.5 seconds, including all 9,466 web tests.
API and web `tsc --noEmit` both exit 0. Exact-SHA preview run
[34256972886](https://github.com/kortix-ai/suna/actions/runs/34256972886)
finishes with 455/462 API flows passing, four failures, and three skips.
SHIP-1, SHIP-4, SHIP-6, and SHIP-9 fail at the Platinum ingress.
All 19 browser journeys pass. Target-full fails in 681.5 seconds.

### Test the deployed picker

1. Open [the reviewer fixture](https://pi.kortix.com/projects/80b8142e-02b8-456d-8684-bff4d3e5718e/sessions/2abb0614-6641-4d24-bdf5-acb760d027a7).
2. Set Thinking effort to High. Reload; the control must still show High.
3. Send: `Call inspect_effort exactly once and report its JSON result.`
4. Confirm the result contains `"effort":"high"`. Repeat with None; expect `none`.
5. Select Auto and repeat; expect the reviewer's compiled `low` default.
6. Send the identical text again. A new user message and response must appear.
7. Ask the question tool for two multiple-choice questions. Answer the rendered cards.

This reviewer intentionally has no workspace permissions. Use the operator
fixture for file and shell tests. Opening Terminal or Files requests an environment.


## 2026-09-08 — Compaction between tool rounds

The worker checks the model context after completed tools and before the next
provider request. Its native loop retains the complete display transcript.
Pi's retained tool batches can exceed the requested retention budget. Those
batches now enter the summary instead of remaining in the next model context.
Their file-operation metadata remains present. Retained assistant usage from
before compaction no longer counts toward the reduced context estimate.

A worker replacement preserves a committed summary and completed tool results.
It appends an interruption to the original prompt without replaying those tools.
Incomplete tool batches still require a branch change before a later model call.
Stop and summary failures preserve completed tools and prevent another model round.

`pnpm exec bun tests/bin/worker-quality.ts` passes 684 worker tests, the worker
typecheck, the bundle build, and seven real Node artifact checks. New regression
tests fail before the changes for missing tool-round compaction, lost recovery
history, and stale retained usage.

A separate local worker calls the real preview gateway with `gpt-5.6-luna`.
The fixture explicitly uses an 8,192-token context window to exercise compaction
with a 30 KB tool result. It executes one tool, commits one summary, and sends
an 863-byte continuation context without the raw archive. Its five wire messages
survive worker restart exactly. The next real model call recalls `cobalt`.
The temporary gateway key is revoked. The worker and its local file-backed
session-log server are closed. No environment calls execute.

This proof uses real HTTP and provider responses with a reduced test window.
It does not prove full-size context behavior through the Platinum ingress.
Evidence: `/tmp/pi-tool-round-live.json` and `/tmp/pi-tool-round-live.log`.
