# Pi worker verification — 2026-09-07

Branch: `pi-worker`. No merge to `main`, `staging`, or `prod`.
Draft PR: [#6998](https://github.com/kortix-ai/suna/pull/6998).
Preview: [pi.kortix.com](https://pi.kortix.com).
Architecture: [walkthrough, Q&A, and diagram](./PI_WORKER_WALKTHROUGH.md).

Latest UI and streaming checks: [runtime UI verification](./PI_RUNTIME_UI_VERIFICATION.md).

## MCP resources and prompts — 2026-09-09

Code commit: `48e1acb70fea51fc50b744336fb2ddae23d46b85`.
Deployment: [34345565828](https://github.com/kortix-ai/suna/actions/runs/34345565828).
The remote checkout, API/gateway/frontend image tags, and public health commit
match this SHA. This push deployment skips the complete target suite.

Local checks:

- `pnpm test`: all six lanes pass in 120.6 seconds. REST/CLI: 400/400;
  worker: 827 tests and seven real Node artifact cases. Benchmark `1788952963778`.
- `pnpm --filter kortix-api test`: 9,332 pass, 82 existing skips, zero failures;
  32,418 assertions across 821 files, 51.18 seconds.
- API and worker typechecks pass. SDK typecheck and packed-install smoke pass.
- New protocol, executor, worker, and HTTP tests cover malformed responses,
  credential redaction, pagination loops, initialization failure, header-based
  session isolation, exact-path policies, approval, and failed audit outcomes.

Live checks use the owned synthetic project
`adb8bd66-c6d2-41bd-bd1a-b0913754d7bb`:

1. Saving the existing connector name triggers a non-forced synchronization.
   Its connection settings remain equal. The catalog upgrades from three to
   eight actions. Repeating the save makes no initialization or tools-list request.
   A README-only Git push does not trigger connector synchronization; that probe
   is not counted as a passing upgrade test.
2. The SDK and real CLI execute all five resource/prompt operations. Every CLI
   process exits zero with empty stderr. Pagination follows `nextCursor`, and
   prompt arguments reach the server unchanged. Invalid arguments make zero
   upstream requests. Remote errors and malformed successful responses fail.
3. A block rule hides the resource action and prevents execution. An approval
   rule creates an inbox entry. Approval permits one exact retry. The original
   policy is restored and read back. PostgreSQL contains successful, failed,
   and denied audit records, with no unresolved approval from the probe.
4. Pi retrieves a prompt through the browser. Its role-marked messages remain
   tool content. The assistant returns the unique topic and reference marker.
5. Pi reads `fixture://image`, identifies `RESOURCE_9241`, the left purple
   triangle, and the right yellow circle. The private attachment bytes match
   the fixture. The browser thumbnail and full viewer load. Base64 does not
   appear in transcript or SSE payloads. The run records 47 text deltas.
6. Stop/resume restores all 63 messages exactly and does not repeat the resource
   read. The denied agent receives `connector_not_assigned`, with zero upstream
   requests for its unique URI. Neither session creates an environment.

The two sessions retain installed agent source
`30df2084e64241f5c293d464760ffeff502acf9f`. Runtime code upgrades do not replace
their pinned agent identity. API and Daytona both report stopped at
`2026-09-09T11:38:49.594Z`. The temporary fixture and tunnel are removed afterward.

Evidence: `/tmp/pi-mcp-catalog-settings-upgrade.json`,
`/tmp/pi-mcp-protocol-api-live.json`, `/tmp/pi-mcp-protocol-audit.json`,
`/tmp/pi-mcp-protocol-ui-live.json`, `/tmp/pi-mcp-protocol-ui-live.png`, and
`/tmp/pi-mcp-protocol-owned-state.json`.

### Manual test path

Use a remote MCP connector that advertises `resources` or `prompts`, and grant
it to the selected Pi agent. Synchronize it from the connector settings.

1. Ask Pi to list that connector's resources, templates, and reusable prompts.
2. Ask it to read a returned resource URI and retrieve a prompt with its named
   string arguments. Resource images should open in the existing image viewer.
3. Require approval for `<connector>.mcp.resources.read`, then retry a resource
   read. Verify that approval precedes execution.
4. Stop and resume the session. Verify that prior results remain and the
   resource is not fetched again until requested.

The exact SDK and CLI calls are documented in
`apps/web/content/docs/connect/connectors.mdx`. Stdio servers, subscriptions,
and the complete runtime MCP discovery UI remain outside this checkpoint.

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

## 2026-09-08 — Exact compaction transcript identities

Deployment [34260391976](https://github.com/kortix-ai/suna/actions/runs/34260391976)
serves `b5ddaa9ff1403546237c6b3feb38fac43b3743fc`. Public health and all three
service container tags match. `pnpm test -- --full` passes all eight local lanes
in 408.5 seconds: REST/CLI 396/396, SDK 2,872, worker 684, browser 17 passed
and two skipped, plus package, runner, route, and worktree gates.

Exact-SHA preview run
[34261314908](https://github.com/kortix-ai/suna/actions/runs/34261314908)
passes 455/462 API flows and all 19 browser journeys. SHIP-1, SHIP-4, SHIP-6,
and SHIP-9 receive synthetic Platinum ingress 502 responses during Git uploads.
Three flows are skipped, including two quarantined flows. Target-full fails
in 659.5 seconds. This remains an unresolved provider-boundary failure.

A separate deployed Luna browser check catches a transcript mismatch after
manual compaction. Session `a8c7a39b-edab-4053-99a4-399f02d510ad` emits an empty
reasoning part before `inspect_effort`. Luna omits that block from its final
native content. Restoration drops the placeholder and changes the tool part ID.
The test fails its exact-history assertion and stops its fixture session.

The worker now persists streamed text and reasoning parts separately from
model content. Compaction and restart retain their IDs, text, and reasoning
timing. Tool replay counts the same display parts before assigning tool IDs.
Legacy messages without this metadata retain their existing restoration path.
Two regression cases fail before the change. The HTTP regression exercises
compaction and worker replacement with a provider-omitted reasoning block.

The focused restoration checks pass 20 tests. The complete worker suite passes
687 tests. Worker typecheck, build, and seven real Node bundle/lockdown checks
pass. Deployed verification of the new fix follows below.

Deployment [34263718363](https://github.com/kortix-ai/suna/actions/runs/34263718363)
serves `9d911adc2cdfba068de79c1d6230688154a491b2`. Public health, remote Git HEAD,
and API/frontend/gateway image tags match. This push deployment skips target-full.

A real browser session, `a2a5e916-71a2-4b0a-bbdc-c3cc3ae6e3a9`, selects High,
sends `variant: high`, and receives `inspect_effort` with `effort: high`.
Manual compaction returns `200` and displays **Context compacted**. The entire
pre-compaction transcript remains byte-for-byte equal. The next answer recalls
`cobalt`. SSE delivers 19 text deltas. All seven messages survive stop/resume
unchanged, with native ID `ses_pi277167e3fa4b1c3345a7197c`.
The environment route remains `404`. The fixture session is stopped afterward.

## 2026-09-08 — Structured output and shutdown

`session.send(text, { format })` forwards the same OpenCode-compatible contract
for Pi and OpenCode. Pi validates the schema before admission. It persists
`info.format`, returns the validated value in `info.structured`, and retains
both across replacement. Schemas can use local references. Draft 7 and
2020-12 object schemas have real-provider coverage. Non-object root schemas
and providers outside the OpenAI-compatible gateway remain unverified.

The worker registers `StructuredOutput` for that prompt only. Custom modules
cannot replace it. Native lifecycle hooks still run. The model receives a
required tool choice while tools remain available. Validation defaults to
two retries; `retryCount: 0` permits only the first attempt. Exhaustion and
an early lifecycle stop return `StructuredOutputError`. Stop, provider errors,
and failed automatic compaction retain their original errors. A completed
formatter prevents later tools in the same batch from executing.

Question recovery restores the remaining validation budget. Cached failed
tool results do not consume that budget again. Recovery also recognizes a
saved structured result when the process dies before the turn journal commits
completion. An incomplete tool batch still interrupts instead of rerunning
unknown side effects.

Shutdown previously depended on an optional custom module. A worker without
that module could leave its provider request running. `close()` now aborts
the agent and drains the active turn before closing custom hooks and HTTP.
Queued requests cannot start during shutdown. They retain their durable
admission for the replacement worker.

The local real-gateway check returns `{ answer: 42 }` and `{ code: 'cobalt' }`.
The second schema uses a 2020-12 local reference. The next text prompt returns
`READY` without the formatter. Six messages survive exact restart, and the
next real-model reply recalls `42 cobalt`. No environment calls execute.
The temporary gateway key is revoked in cleanup.

SDK TDD records two failing forwarding tests before implementation. The final
SDK gates pass: typecheck, 2,874 tests, and packed-tarball Node import smoke.
The complete local and deployed checks for this change follow below.

`pnpm test -- --full` passes all eight lanes in 403.9 seconds. Worker quality
passes 716 tests, typecheck, bundle construction, and seven compiled Node
artifact/permission checks. REST/CLI passes 396/396 flows. Browser journeys
pass 17 tests and skip two. SDK, package, route-coverage, runner, and worktree
lanes pass. The package lane includes 9,466 passing web tests. The benchmark
record is `tests/test-results/local/benchmark-1788895269919.json`; it records
the pre-commit base `9d911adc2c` with this change applied in the worktree.

## 2026-09-08 — Platinum production upload revision identified

`GET https://api.platinum.dev/` reports `sourceVersion: git:fa2c5f91468e`.
The last successful production control-plane deployment is
[34142124853](https://github.com/kortix-ai/platinum/actions/runs/34142124853),
for full SHA `fa2c5f91468e539624cc90ff9e6b0ddef0048de1`.

Both raw TCP upload paths in that revision call `socket.write()` once for
headers and once for the body. They ignore partial writes. The existing fix,
[Platinum #923](https://github.com/kortix-ai/platinum/pull/923), is commit
`cd70810ee58834c7e45b11ea801d6bffc3d5d575`. Current Platinum main contains its
`createBackpressuredWriter`; production does not. Its documented failure
matches the preview probes: small bodies pass, larger bodies stall until an
upstream 502, while the same bytes reach the internal API immediately.

This identifies an unfixed production transport path and the existing release
candidate. The host-edge process revision remains unverified. No Platinum
production service, branch, or environment changes during this investigation.
Release the fix through Platinum's required main → staging → prod process,
then rerun the four Git shipping flows and large-context/upload checks.

## 2026-09-08 — Deployed structured output and attachment storage

Structured output checkpoint: `b5ba0a4828b9c679e0572340ce5fe919d7b0d802`.
Deploy `34268543172` succeeds. Public API health, remote Git, and all three
container image tags report that exact SHA. The real SDK validates `{answer:42}`
and a Draft 2020-12 local-reference schema producing `{code:"cobalt"}`. A later
plain prompt recalls both values without inheriting the output format. Invalid
schemas return `400` without changing history. SSE emits two structured message
updates. Six full message envelopes survive stop, PostgreSQL mirror reads, and
worker resume byte-for-byte. Environment reads return `404`. The fixture is
stopped after verification.

The real browser expands both `StructuredOutput` tool controls and asserts the
visible JSON values. Its runtime message request returns `200`. The composer
returns to idle. Evidence: `/tmp/pi-structured-preview.json` and
`/tmp/pi-structured-tool-ui.json`; screenshot `/tmp/pi-structured-tool-ui.png`.

Manual full preview run `34270243441`: API `455/462` pass, four fail, three skip
(two existing quarantines), `598.3s`. Browser lane passes in `231.4s`; total
`602.9s`. The same `SHIP-1`, `SHIP-4`, `SHIP-6`, and `SHIP-9` fail on synthetic
Platinum ingress 5xx responses after `41.0–46.2s`. These failures remain release
blockers. No retries or quarantines were added. The exact existing Platinum
socket writer fix independently passes `10 tests / 26 assertions` for partial
writes across both proxy paths. Production still does not contain that fix.

Attachment storage is the next additive checkpoint. The new PostgreSQL table
stores immutable bytes separately from the 512 KiB worker journal. PUT and GET
routes use the same tenant and own-session credential gate as transcript logs.
Uploads accept 1 byte through 8 MiB, verify SHA-256, and reject MIME replacement.
The SDK exposes `session.attachments.put/get` without starting a runtime and
verifies downloaded hashes. Pi prompt/composer integration remains gated.

The generated migration creates only `kortix.session_attachments`, its primary
key, size/hash/type checks, and a cascading session foreign key. It changes no
existing columns or data. The local test stack applies it successfully. The
black-box `SESS-29` flow fails with `404` before the routes exist, then passes
upload retries, exact read-back, conflicts, tenant isolation, invalid inputs,
unchanged lifecycle state, and access revocation after session deletion.

The storage review also finds unsafe default database grants. Preview metadata
reports `anonSelect:true`, `authenticatedWrite:true`, and `rls:false` for the
five existing Pi log/bundle/shared-filesystem tables. No row contents are read.
The additive `20260908200910776_pi_private_storage_access.sql` migration revokes
browser-role privileges and enables RLS on those five tables and attachments.
A disposable PostgreSQL test fails all 12 checks before this migration and
passes all 12 afterward (60 assertions), including a future blanket-grant
regression and API-owner/service-role access.

Both new migrations are applied through the standard migration runner to the
Pi preview before the API rollout. Their SHA-256 values are
`37205c418db6051baddb369cef84b21795395b13816e3f0a5ee0c3cc15dd2700` and
`5f93e30acd7144ff87c1adb7a1a6f5070613e690fdc5b4bfba35749f44a5af68`.
Read-back reports RLS enabled and browser privileges absent on all six tables.
The preview's public PostgREST endpoint independently hides the `kortix` schema:
all 12 anonymous/authenticated probes return `406 PGRST106`. This does not prove
that public row access existed before the fix. The database-level grant gap is
confirmed; the public schema boundary already blocks it on this preview.
Authorized API log reads remain `200`, the worker resumes with the same native
session ID, and all six messages remain present. The fixture is stopped again.
Evidence: `/tmp/pi-private-storage-public-proof.json` and the before/after
metadata logs. No production database is changed.

Local final full run: seven lanes pass, including `397/397` REST/CLI flows,
SDK, worker quality, browser, route coverage, runner, and worktree checks. The
package lane catches two missing generated audit-registry entries. Regenerating
the registry adds exactly the GET and PUT attachment routes. Its focused suite
passes `44 tests / 2,113 assertions`; ESLint reports no errors. The package lane
is rerun after this correction, but a Bun CLI test worker stalls and is terminated.
The exact CLI/daemon child command then passes 1,257 CLI and 1,185 daemon tests.
The stalled root package run is not counted as a pass. SDK typecheck, the full SDK suite, and packed
Node installation smoke all pass. No SDK public names are removed; the reviewed
surface snapshots add only the two attachment methods and their metadata type.


The attachment storage checkpoint `00985c4ea694dd55e56992c78f075a5ee394040d`
deploys successfully in run `34274286991`. Remote Git and API/gateway/frontend
image tags match that SHA. The public SDK test uploads and downloads 8,192 exact
binary bytes, retries idempotently, rejects MIME replacement with `409`, rejects
anonymous access with `401`, and returns `404` in a sibling session. The session
remains stopped and no environment exists. Evidence:
`/tmp/pi-attachment-sdk-preview.json` and `/tmp/pi-attachment-deployed-sha.log`.

Native image input follows this storage checkpoint. The worker accepts only
same-session immutable PNG/JPEG/GIF/WebP references. It verifies hashes and MIME,
bounds each image at 8 MiB, and bounds each prompt/cache at 16 MiB. Wire history
holds lazy part URLs. Native journal messages hold references rather than base64.
Stop cancels pending validation before it can admit a later prompt; its regression
test fails before the fix and passes afterward.

The real local worker/gateway test uses `gpt-5.6-luna` and an independently rendered
400-by-240 PNG. The model reads `LIME 731`, identifies a blue circle and orange
square, and reads the same text after worker replacement. Both provider requests
contain exactly the fixture's bytes. Wire history is identical after replacement,
the journal contains no image base64, and environment calls remain zero. The
temporary gateway key is revoked. Evidence: `/tmp/pi-image-live.json`.

The SDK adds `session.attachments.image` and per-prompt `send(..., { files })`.
The composer uses the current worker's image capability, not the gateway catalog.
Images upload through the SDK to session storage; document files retain the
existing environment upload path. Older worker bundles, text-only models, and
first-prompt creation screens keep their attachment gate. Native tool-result
images and remote attachment conversion remain pending.


The image checkpoint passes `pnpm test -- --full`: all eight lanes, 402.0 seconds.
This includes 397 REST/CLI flows, SDK, worker/compiler, browser, package quality,
route coverage, runner, and worktree checks. The browser lane reports 17 passed
and two existing skips. CLI reports 1,257 passed; daemon reports 1,185 passed;
web reports 9,469 passed. SDK typecheck and the packed Node installation smoke
pass. Standalone frontend `tsc --noEmit` passes; focused ESLint reports zero
errors and 36 existing warnings. Benchmark:
`tests/test-results/local/benchmark-1788901485635.json`.


Image checkpoint `1186af73086ca6f58885dcd487579092c93941ff` deploys successfully
in run `34278659422`. Remote Git, API/gateway/frontend image tags, and public
API health match the exact SHA. The deployed browser journey passes: upload PUT,
immutable inbox file reference, decoded 400-by-240 thumbnail, lazy GET `200`, 50
text deltas, and nine distinct visible streaming text lengths. UI Stop interrupts
a long response with `MessageAbortedError`; the next prompt succeeds. Stop/resume
preserves the complete transcript and exact PNG bytes. The SDK submits another
image successfully. No environment exists, and the fixture is stopped afterward.
Evidence: `/tmp/pi-image-preview.json`, `/tmp/pi-image-preview.png`, and
`/tmp/pi-image-deployed-sha.log`. Session:
`a453fb09-fe08-4db4-be7b-599e9cf90f5b`; native ID:
`ses_pic6ceb70cfde325ab822b8708`; worker:
`2491e4c4-7a0a-47da-a9f0-577eb9d8dc5d`.


## Image preview full gate — 2026-09-08

- Commit: `1186af73086ca6f58885dcd487579092c93941ff`.
- Run: `34279668235`; `pnpm test -- --target-full` completed in 543.5 seconds.
- Browser: all 19 journeys passed in 225.3 seconds.
- REST/CLI: 455/463 passed, five failed, three existing skips.
- SHIP-1, SHIP-4, SHIP-6, and SHIP-9 hit the existing Platinum ingress 5xx failure in 41.2–46.4 seconds.
- SESS-29 read exact attachment bytes but rejected the compressed response's weak ETag. Captured headers prove `Content-Encoding: zstd` and `ETag: W/"<matching SHA-256>"`. Cloudflare preserved the digest. The flow now computes SHA-256 from the returned content and accepts the corresponding strong or weak ETag.
- Main sync preserves the upstream attachment flow's SESS-27 identifier. The Pi transcript-log flow becomes SESS-30; SESS-28 and SESS-29 remain unchanged.


Image viewer follow-up on the same deployed image session:
- Clicking the saved thumbnail opens the image dialog with the original 400×240 pixels.
- Clicking the image applies the existing 2× zoom; Close returns to the composer.
- Authenticated lazy image GET returns 200. Environment GET remains 404.
- The test stops its worker afterward.

## Main integration — 2026-09-09

The canonical `pi-worker` branch integrates main `4dcbbe4832b8f5eeef22f81b81117884df0e8849`.
The merge preserves v3 Pi selection, the execution-only environment, custom
agent hooks, immutable image prompts, and fixed model/agent controls.

- SSE replay activity retains the original event timestamp after the upstream
  message-ID fallback and delta deduplication changes. The focused SDK suite
  passes 202 tests and 395 assertions after three replay regressions fail first.
- Upstream staged first-prompt attachments keep SESS-27. The Pi transcript-log
  flow moves to SESS-30. SESS-28 and SESS-29 retain their IDs.
- Pi and filesystem SDK guides join the Blume documentation navigation.
- Pi workspace, question-submission, permission-submission, and loading labels
  have translations in all nine supported locales.
- The first full run found a local Supabase user-create timeout, two preview
  test assumptions, an undersized test-only heartbeat lease, stale frontend
  test expectations, and a browser HMR race caused by editing during the run.
  These findings do not justify quarantining flows or changing production leases.
- The second full run passes all 398 REST/CLI flows, SDK, worker quality, runner
  units, route coverage, and worktree units. Browser and package gates remain
  in progress at this checkpoint. Final deployment proof is recorded separately.


## Merged preview and native tool images — 2026-09-09

Merge commit `6363074d0fcbe7125bf02242d884ff6db1ae14cf` deploys through run
`34283955003`. Remote Git, all three image tags, and public API health report
that commit. The browser integration check passes: a question card survives
reload, the selected Blue answer posts with `200`, 303 text deltas produce 22
visible rendering states, Stop aborts the reply, and the next prompt reads
`LIME731` from the original image. All 16 messages survive worker stop/resume
unchanged. The environment remains absent. The test worker is stopped afterward.
Evidence: `/tmp/pi-merge-preview.json` and `/tmp/pi-merge-preview.png`.

The full preview gate `34311203161` completes with 456/464 REST/CLI passes,
five failures, and three existing skips. SESS-29 now passes its byte and ETag
checks. SHIP-1/4/6/9 still fail at Platinum ingress. SEC-J receives a `404` HTML
page for `/.env`, containing the public translation `text8bcac7908eb9` whose
value is a PEM header placeholder. It contains no encoded key block. The preview
edge now rejects sensitive paths with a plain `404`; the detector stays unchanged.
The failed assertion is reproduced before the configuration fix, then all 11
preview-stack tests pass. A real Caddy container also returns exact `404 Not found` for all seven sensitive-path probes, including encoded traversal. Deployed SEC-J verification is pending this commit.

Preview browser results are 19 passes and two failures: billing loses its dialog
after Subscribe; German onboarding shows Slack when the test expects Tools.
The local browser suite passes all 21 configured journeys with two existing
skips. These preview failures remain unresolved and prevent a full-gate claim.

The native tool-image implementation saves raw image bytes before the journal,
returns stable authenticated file parts, hydrates provider and custom-hook inputs,
and renders images with the existing viewer. Tests cover exact restart, no tool
reexecution, storage failure, unauthorized access, other-message access, and Stop
during upload. Worker quality passes 749 tests plus seven compiled Node sandbox
tests. Frontend typechecking passes; focused lint reports zero errors and one
existing warning. The full local run passes 398 REST/CLI flows, SDK, runner,
coverage, worktree, and browser lanes. Its initial worker lane reports three type
errors, corrected and covered by the full worker-quality rerun. Package quality passes in 237.9 seconds, including SDK typecheck and packed-install smoke. All eight local lanes now have passing evidence; the initial aggregate remains failed because its worker type errors preceded the correction. Live tool-image verification remains pending at this checkpoint.

The previous overnight local run crossed macOS maintenance sleep and recorded
hour-long test durations and a negative browser performance timestamp. The
replacement run uses `caffeinate -i` for its process lifetime. It does not change
machine-wide power settings or suppress browser exceptions.


## Tool-image preview follow-up — 2026-09-09

Commit `78009fa8915a0bf77dd9e575bb8d50c5681c08bd` deploys through
`34313114290`. Public health, remote Git, and frontend/API/gateway tags match.
The custom capture returns the exact 4,687-byte PNG. The real provider payload,
`onEvent`, and `transformContext` each receive the native bytes. The model reads
`LIME 731` and both colored shapes. The immutable tool asset returns `200` with
the expected digest after worker replacement. The test fixture is session
`9b348de2-401e-4502-b76e-4185441d6d35` in `pi-lab`.

Browser verification found an extra grouped-tool disclosure above the image.
Native reads also bypassed the attachment renderer through file-chip rows.
The follow-up keeps image-bearing tools as individual rows and retains the full
renderer for image reads. Two regressions fail first; the corrected renderer
suite passes 140 tests and 341 assertions. Frontend typechecking passes. Focused
lint reports zero errors and four existing warnings. Deployed UI proof is pending.

The preview edge's bind-mounted Caddyfile retained the previous inode even though
the host file and reload command were current. Reloading through stdin applies
the deployed rule without restarting the edge. The unchanged live SEC-J and
SESS-29 flows both pass: 2/2, no skips, 8.5 seconds. Bootstrap and guard now use
that command; all 44 preview lifecycle tests pass.

The German onboarding failure is a test assumption: the browser's public runtime
configuration reports `CONNECTORS_ENABLED: false`, so Tools is correctly absent.
The test now asserts the configured path before proceeding to Slack. Preview
billing remains unresolved; the four Platinum shipping failures remain open.


## Native tool-image UI — verified 2026-09-09

Commit `cc5a217ef225d2f4f942e5b9c1b680c365ee5880` deploys through
`34314371034`. The corrected source fixture is
`fb80627c29012dc0a107b8224c3b9a4d263540dc` on
`codex/pi-tool-images-20260909`. Its read permission uses the workspace-relative
`pi-tool-image-fixture.png` pattern. The project's default branch is unchanged;
the temporary source token is revoked.

The real browser check passes in session `04aac850-23c9-4bed-811d-e5183e34ffec`:

- Capture returns the original PNG from the worker. Provider and native hooks
  receive the exact bytes. No environment starts for capture or its image viewer.
- The completed tool shows an authenticated image tile after expanding the
  activity list. The viewer opens the original 400×240 image and closes normally.
- `write_sample` starts the environment and creates the PNG. Native `read`
  returns a second image tile with identical bytes. The actual provider payload
  contains both images.
- Environment `6d708ba7-09c2-4da3-8fed-ff7925b09ae9` reports
  `workload: environment`, `opencode: disabled`, and `runtimeReady: true`.
- A UI prompt produces 243 text deltas and 73 visible rendering states.
- All 11 messages and image URLs survive worker replacement without repeating
  the completed tools. The worker and environment are stopped after verification.

Evidence: `/tmp/pi-tool-images-preview.json`, `/tmp/pi-tool-images-preview.png`,
and `/tmp/pi-tool-native-read-live.json`.

Manual check: open the fixture session, expand **Completed 2 steps**, and click
its image. Expand **Completed 3 steps** to inspect the native file-read image.
Ask it to read `/workspace/pi-tool-image-fixture.png` again. It must show the
same image and read `LIME 731`. Stop a long reply, then send another prompt.

The full preview rerun at this commit is superseded by
the billing accessibility fix. Its screenshot proves two global upgrade dialogs
rendered together: visible content was absent from the accessibility tree. One
host now owns that dialog across authenticated routes; share pages retain their
fallback host. The billing journey requires exactly one dialog and an accessible
heading. All 9,635 frontend tests pass; typechecking and focused lint pass. Live
billing verification is recorded below.

## Billing dialog and first-prompt images — 2026-09-09

Deployment `34315185423` publishes `8e52bd100e46cbac2e2795db634665070853e618`.
Remote Git, API, gateway, frontend image tags, and public health match that SHA.
The read-only billing reproduction changes from two dialogs and zero accessible
headings to one dialog and one accessible heading. The full preview billing
journey also passes in 40.8 seconds, including test-mode checkout, subscription
read-back, credit checkout, and billing management.

The cancelled older preview controller did not stop its remote test process.
That process wrote its exit file after the next deployment started. Controller
`34315723121` read the stale exit code and exited while the current tests continued.
Its archive also exceeded Platinum's single-read limit: 443,342,408 bytes versus
268,435,456. The running tests are inspected directly. Do not treat that controller
result as the current suite result. The controller checks out `main`, so branch
changes to bootstrap routing are not used by the controller before merge.

First-prompt image changes are locally verified and deployed at `d8fa198f49`:

- Pi session creation, warm claims, and boot-time prompts replace staged image
  data URLs with immutable attachment references. Bytes and commands commit in
  one transaction. The OpenCode conversion stays unchanged.
- The project composer and boot shell expose attachments once their project or
  runtime identity is known. Compiled model and agent controls remain locked.
- Images accept PNG, JPEG, GIF, and WebP, up to 8 MiB each and 16 per prompt,
  within the existing 12 MiB serialized-parts limit. Remote and unsupported
  attachments fail before storage. MIME conflicts preserve the existing asset.
- `pnpm test -- --id SESS-27,SESS-29,SESS-31`: 3/3 pass, no skips. The new flow
  proves atomic admission, refusal without partial storage, exact bytes, retry
  identity, MIME conflicts, and authorization through HTTP.
- API and frontend typechecks pass. The frontend suite passes 9,635 tests.
  Focused frontend lint reports zero errors and six existing warnings.

The live local flow exposed an RPC overload ambiguity in credit admission:
`PGRST203` became a `402` despite a positive balance. Sending the explicit nullable
`p_idempotency_key` selects the intended function. Both new regression cases fail
before the fix. The credit tests pass 26 tests; the unchanged HTTP flows then pass.
No database schema changes are required for this correction.


## Compaction request overflow recovery — 2026-09-09

A recognized context-limit error from summarization retries the conversation in
ordered segments. Each successful summary carries into the next request. UTF-8
boundaries preserve the source text. Recovery permits at most 128 segments and
eight adaptive splits. It preserves file metadata and sums all successful recovery
requests' usage. Cancellation or an unrecoverable provider error commits no partial
summary. Ordinary agent-request overflow and oversized first input remain open.

- Focused compaction tests: 15 pass, 0 fail, 83 assertions.
- Worker HTTP tests verify one committed summary, one completed tool, idempotent
  prompt replay, exact history after replacement, and recall from the summary.
- Complete worker suite: 760 pass, 0 fail, 4,178 assertions across 87 files.
- `pnpm test`: all six core lanes pass in 106.2 seconds. REST/CLI flows pass
  399/399 without skips. SDK tests, runner tests, route coverage, and worktree
  tests pass. Worker typecheck and a fresh build pass. The compiled Node and
  confinement tests pass 7 tests with 71 assertions.
- Evidence: `/tmp/pi-compaction-guard-root.log` and
  `tests/test-results/local/benchmark-1788935608905.json`.

An earlier core run failed because two local dependency installs ran concurrently.
The unchanged sequential rerun above passes. Its compiled-artifact tests use the
freshly built worker, not the artifact left from the failed install.

The initial real fault fixture exposed a second failure: Pi reserves 4,096 context
tokens internally. A 4,096-token fixture therefore sent `max_tokens: 1`. Native
compaction accepted the truncated response and discarded completed-tool context.
The fixture timed out, stopped its local worker, and revoked its temporary key.
The worker now rejects the provider's `length` stop reason before committing
any summary. Both initial and recovery-path regression tests fail before the fix.

The corrected real Luna fault fixture uses a 16,384-token window. Its proxy
rejects exactly one 16,560-byte summary request. Two real gateway requests of
9,946 and 9,701 bytes recover the summary. One fixture tool executes, one summary
commits, and all six messages survive replacement exactly. The model recalls
`cobalt` after replacement. No environment starts; the temporary gateway key is
revoked. This is a deliberately injected HTTP error with real model responses,
not a claim that Luna's actual context window is 16,384 tokens.
Evidence: `/tmp/pi-overflow-live.json`, `/tmp/pi-overflow-live-fixed.log`.

The full remote suite at `8e52bd100e` finishes at 06:30 UTC. Its browser lane
passes in 2,784.3 seconds: 21 initial passes and two gateway-502 retries that pass.
The language sweep passes in 41.1 minutes. The overall suite remains failed
because REST/CLI reports 456 passes, five failures, and three existing skips.
Four failures are Platinum Git uploads. SEC-J ran before the routing hot reload.
The run's benchmark is `benchmark-1788935404978.json` on the preview.


## Deployed first-prompt images — 2026-09-09

Deployment `34319703180` publishes `d8fa198f4986313899c4a7a401a2b5cce9936108`.
Remote Git, API, gateway, and frontend image tags match. Both live probes assert
that public `/v1/health` returns this exact commit.

- The real project composer submits a 4,687-byte PNG through warm claim. The model
  reads `LIME731`, the blue circle on the left, and the orange square on the right.
- Session `fbbffce4-9a85-4561-9da5-03fa00272582` contains exactly two messages.
  The authenticated viewer loads the original 400×240 image. The asset bytes,
  messages, and image remain available after worker stop/resume and browser reload.
- Direct SDK session creation independently submits the same first-prompt image.
  The model reads it correctly. Exact asset bytes and the two-message history pass.
- Neither input path starts an environment. Both test workers finish stopped.
- Preview `SEC-J`, `SESS-29`, and `SESS-31`: 3/3 pass, no skips, 9.1 seconds.
  Caddy loads current routing bytes through stdin before these checks.
- Evidence: `/tmp/pi-first-prompt-image-preview.json`,
  `/tmp/pi-first-image-create-preview.json`, and `/tmp/pi-first-images-api-proof.log`.
- Preview API report: `20260909064444-le1kqc/report.html`.

## Native connector tools — local verification, 2026-09-09

Pi registers project-scoped search, describe, and call tools through the SDK.
Construction does not fetch a catalog or request an environment. The gateway
keeps credentials and enforces agent grants and action policy. Native MCP results
unwrap the gateway's JSON-RPC envelope before image conversion and error handling.

The SDK previously replaced caller cancellation with its own timeout signal.
Failing tests reproduce pre-abort execution, continued POST requests, and GET
retries after Stop. The transport now honors cancellation during credentials,
requests, and retry waits. Connector methods expose the optional signal without
changing existing required arguments or exported names.

- `pnpm --filter @kortix/sdk typecheck`: pass, including examples.
- `pnpm --filter @kortix/sdk test`: 2,938 pass, 0 fail, 0 skips.
- `pnpm --filter @kortix/sdk run smoke:install`: pass. Packed SDK and executor
  adapter install and construct in Node ESM.
- `pnpm test`: six core lanes pass in 111.0 seconds. REST/CLI: 399/399 pass,
  no skips. Complete worker suite: 785 pass, 0 fail, across 89 files.
- Worker typecheck and fresh Node bundle pass. Compiled artifact and confinement:
  7 pass, 0 fail, 71 assertions. The new worker bundle is 1,665,750 bytes.
- Worker HTTP tests prove discovery, exact action arguments, action permission
  patterns, denial without execution, unanswered approval cancellation, in-flight
  Stop followed by another prompt, and exact transcript restoration.
- Connector HTTP tests prove scoped credentials under concurrent workers,
  approval handoff without resubmission, native content, JSON-RPC errors,
  malformed binary rejection, size limits, and cancellation.
- Evidence: `/tmp/pi-connector-sdk-gates.log`, `/tmp/pi-connectors-root.log`,
  `tests/test-results/local/benchmark-1788937551355.json`.

Live connector verification follows deployment. The original `pi-lab` project
has a one-project account limit. The MCP probe uses an isolated synthetic preview
user and project, rather than changing that account's subscription or repository.


Preview build `34322671315` rejects `a4fb080893` before deployment. The isolated
worker stage cannot resolve the new SDK connector import because it copied only
`core/pi/agent.ts`. The stage now copies SDK and model-catalog source and resolves
external imports from the worker's frozen dependencies. No runtime install is added.
The new isolated-stage test reproduces the missing-source failure, then builds
the corrected stage in 940 ms. It executes the Docker stage instructions against
an empty temporary tree. Existing checkout dependencies cannot hide missing inputs.


## Fresh YAML v3 bootstrap and compilation (2026-09-09)

A new remote-MCP fixture found a remaining download gate in preview `ab9aa58479`.
Session creation selected Pi, but its worker received `403 feature_disabled`
from `compiled-pi-runtime` because the project never enabled the old experiment.
The route now uses its existing authenticated project scope without that flag.
Push-time prebuild resolves the committed manifest and builds only its runtime.
The legacy flag retains only its OpenCode prebuild override for YAML v2.

`pnpm test -- --id GH-18`: **1 passed, 0 failed, 0 skipped**, 1.2 s flow time.
The flow clones and pushes real Git, explicitly disables `pi_worker`, downloads
and hashes the exact artifact, and checks anonymous `401` and mismatched SHA `409`.
The raw body is hashed because the test client's captured body is redacted.
The first run also reproduced a self-hosted receive-pack `500`; the local Git
path now receives the reconstructed policy-checked stream and runs prebuild hooks.

Focused prebuild tests: **8 passed, 0 failed**. Artifact-store log tests:
**2 passed, 0 failed**. Failed artifact persistence logs only a database code,
not SQL parameters or compiled agent source. Live MCP session verification
remains pending the deployment of this bootstrap fix.

`pnpm test`: **6/6 core lanes pass**, 112.6 s; **400/400 REST/CLI flows**,
**786 worker tests**, and **7 real Node artifact checks** pass.
`pnpm --filter kortix-api typecheck` passes. Two full API runs hit a 15-second timeout in the first artifact test.
The unchanged focused file passes **9/9 in 2.11 s**. Temporary tracing showed
a 307 ms build, then the tracing was removed. The final unchanged full gate
passes **9,285 tests, 0 failures, 82 existing skips in 43.65 s**.
The earlier timeout cause remains unconfirmed; no timeout or assertion was relaxed.

## Ordinary provider overflow and recovery readiness (2026-09-09)

Ordinary provider context rejection now permits one summary and replacement
request per prompt, before visible output. Completed tools are not replayed.
First-input oversize, visible partials, unrelated errors, and repeated rejection
retain their errors. Stop cancels summarization and prevents the replacement.
Custom context transforms and native image hydration apply to the retry.

`pnpm exec bun /tmp/pi-provider-overflow-live.ts` passes against the preview's
real Luna gateway with one injected HTTP `400 context_length_exceeded` response.
The local worker executes one synthetic tool, writes one compaction, returns
the launch code, restores six identical messages, and recalls the code after
restart. The rejected request contains the archive; the replacement contains
the summary without that archive. No environment is used. The temporary
gateway credential is revoked. Evidence: `/tmp/pi-provider-overflow-live.json`.
This is controlled fault injection, not a measured natural model-window limit.

Preview `dbd3c9fb6c` also verifies a fresh YAML v3 MCP session without a Pi flag.
Its real browser reaches the exact `fixture.read_fixture` permission request.
Reload preserves the request and the MCP server receives no call before approval.
Stopping at that request exposes a resume failure: two worker processes wait
on a 60-second journal lease while the API gives an unbound process 30 seconds.

The worker now binds readiness before durable recovery. Until initialization
finishes, health reports `runtimeReady: false`, and runtime requests return
`503` with `x-kortix-boot-phase: worker-restoring`. A second process cannot read
or claim the journal. Initialization failure releases the port. The Daytona
launcher retains its flock descriptor in the detached entrypoint.

- Startup test: red on unreachable boot health, then **3 pass, 0 fail**.
- Startup, permission, and question recovery: **27 pass, 0 fail**, 925 assertions.
- Daytona provider: **17 pass, 0 fail**, 32 assertions. Descriptor test fails
  before the launcher correction.
- Actual bootstrap command on Linux: eight simultaneous calls launch one child;
  seven report `lock-held`; a later call launches after the child exits.
  The enclosing exec stays alive for the test. Evidence: `/tmp/pi-worker-lock-live.log`.
- Worker and API typechecks pass. Full API: **9,285 pass, 0 fail, 82 existing
  skips**, 43.72 s. Evidence: `/tmp/pi-worker-recovery-api.log`.
- Final `pnpm test`: **6/6 core lanes pass**, 112.5 s. REST/CLI: **400/400**.
  Seven real Node artifact checks pass. The first run found two source-location
  tests referencing the moved initializer; their scope checks now target
  `initializeWorker`. Existing runtime prewarm assertions pass unchanged.
  Evidence: `/tmp/pi-worker-recovery-root-final.log`,
  `tests/test-results/local/benchmark-1788942270663.json`.

The same MCP session must pass the deployed resume and tool checks before this
checkpoint receives live verification. No main, dev, staging, or production
deployment occurs in this checkpoint.
# Connector agent isolation — 2026-09-09

The live MCP probe exposed a proxy principal bug. A session created with the `denied`
agent executed `fixture.read_fixture` despite `connectors: none`. Its worker used the
correct agent. The proxy loaded an unrelated `default` agent and rewrote the token's grant.
Drizzle rendered the scalar projection as `where "session_id" = "session_id"`.

The proxy now joins `project_sessions` explicitly for worker and environment lookups.
Pi connector authorization derives the agent from the session and resolves its grant
at `pi_worker_sha`. It repairs a stale token grant before the connector call.
Unsupported Pi agent switches fail before token reassignment. Newly minted worker
credentials use the same pinned source. OpenCode retains its existing agent-switch behavior.

Local verification:

- PostgreSQL regression: 2 tests, 40 assertions. Both lookup cases fail before the join.
- Focused grant, provisioning, and bootstrap tests: 71 pass, 0 fail, 245 assertions.
- API suite: 9,290 pass, 82 existing skips, 0 fail, 32,287 assertions.
- `pnpm test`: all 6 core lanes pass in 115.3 seconds; benchmark `1788944799354`.

Preview `fd6be556a36619ef50242bc3031453168b39f9f0` passes the denied-agent case.
Deployment `34333095893` succeeds. The public health commit and API, gateway, and
frontend image tags match that SHA. `node /tmp/pi-mcp-denied-live.mjs` returns
`connector_not_assigned`, with zero upstream calls for its unique marker. The
fixture worker is stopped. Evidence: `/tmp/pi-mcp-denied-live.json`.

The earlier live MCP probe passes discovery, native images and model vision,
permission UI across reload, Stop, a follow-up prompt, 155 text deltas, and 61
visible streaming states. Recovered interactions expose a separate missing
control-plane turn record; the worker's busy state alone is insufficient.


## Recovered turn authority — 2026-09-09

A replacement worker must restore control-plane authority before replaying a
saved question or permission. `turn_resume` validates its worker credential,
immutable Pi identity, accepted message, latest durable owner, and nonterminal
journal. One transaction locks the sandbox, preserves the old ended attempt,
creates one active attempt, and grants its execution deadline. Repeated requests
for that owner acknowledge the same attempt. Stop claims, terminal journals,
wrong owners, and unrelated active turns cannot revive execution.

The worker waits for explicit acknowledgment before calling the provider or
executing an approved tool. Transient failures retry within a bounded budget.
A rejected resume interrupts the turn. Completion names the durable owner.
A stale completion closes zero turns and cannot promote the queue or relay an
end event. Ordinary OpenCode turn records retain their existing completion path.

- PostgreSQL recovery regression: **9 pass, 0 fail**, 43 assertions. The stale
  completion test first fails because an older ended row yields `already_closed`.
  It passes with `identity_mismatch` and queue promotion refused.
- Recovery plus existing PostgreSQL lifecycle tests: **51 pass, 0 fail**,
  149 assertions; `/tmp/pi-turn-recovery-db-final.log`.
- Actual worker subprocess recovery and relay tests: **8 pass, 0 fail**,
  36 assertions. A saved approval executes no tool before API acknowledgment.
- Deep permission, question, journal, and relay regressions: **87 pass, 0 fail**,
  1,170 assertions; `/tmp/pi-turn-recovery-deep.log`.
- Black-box `pnpm test -- --id PROJ-17`: **1/1 pass**. A project owner's JWT
  cannot acquire worker recovery authority; the route returns `403`.
- `pnpm test`: all six core lanes pass, **400/400 REST/CLI flows**, **809 worker tests**, and seven
  real Node artifact cases. Total 116.6 seconds; benchmark `1788946152238`.
- Worker and API typechecks pass. Full API: **9,290 pass, 82 existing skips,
  0 fail**, 32,288 assertions; `/tmp/pi-turn-recovery-api-final.log`.
  Preview verification follows this commit's deployment.


## Embedded MCP image resources — 2026-09-09

`connector_call` now accepts an MCP `resource` block containing a PNG, JPEG,
GIF, or WebP `blob`. It preserves the resource URI as text metadata and sends
its bytes through native image storage and model conversion. It rejects missing
URIs, unsupported MIME types, non-string blobs, and ambiguous text-plus-blob
resources. This does not implement MCP resource discovery or subscriptions.

- Four image-format cases fail before conversion and pass afterward.
- Connector and attachment pipeline tests: **34 pass, 0 fail**, 133 assertions.
  The real worker receives an embedded image through its scoped SDK connector
  call, persists exact bytes, hydrates native hooks/provider content, enforces
  private reads, and restores identical messages without a second execution.
- Worker typecheck passes. Evidence: `/tmp/pi-mcp-resource-focused.log` and
  `/tmp/pi-mcp-resource-types.log`. The deployed image-resource proof is recorded below.


For embedded resource conversion, `pnpm test` passes all six core lanes in
116.0 seconds: 400/400 REST/CLI flows, 818 worker tests, and seven Node artifact
checks. Benchmark: `1788946701894`. No SDK source or API contract changes occur
in this image-resource checkpoint.


### Deployed recovery proof

Preview `30bff991791be75faede2b114db9a03d393ddc90` passes the complete browser
journey after deployment `34335177109`. Git, all three application image tags,
and the public health commit match the SHA. A duplicate workflow is cancelled
before its deployment job starts; the verified deployment remains active.

`node /tmp/pi-turn-recovery-live.mjs 30bff991791be75faede2b114db9a03d393ddc90`
passes on synthetic session `638095ce-68dd-4c19-b7e0-2d9af02525bf`:

- Stop the worker at a pending permission, resume, and reload the real page.
  The API reports one active `pi-resume-…` attempt. Native status is busy and
  the UI shows one Stop button.
- Send a stale `turn_end` over authenticated HTTP. It returns `identity_mismatch`,
  closes zero turns, and reports `queue_promoted: false`. The same turn remains
  active, with no MCP execution before human approval.
- Approve through the actual UI. The permission reply returns `200`; the MCP
  server receives one exact marker. The API ledger and queue settle empty.
- Verify native model vision, exact private image bytes, thumbnail and viewer.
  Stop a delayed tool, submit the next prompt, and observe **158 text deltas**
  and **59 distinct visible streaming states**.
- Stop/resume again and compare all 47 messages exactly. Tools do not
  repeat. The environment stays off and the fixture worker ends stopped.

Evidence: `/tmp/pi-turn-recovery-live.json`, `/tmp/pi-turn-recovery-live.png`,
and `/tmp/pi-recovery-deployed-status.log`. No main/dev/staging/production change.


### Deployed embedded image resource proof

Deployment `34336323093` succeeds at `278b28f42c9966a7cc944b321bdb6941f9ac3ea9`.
Git, API/gateway/frontend image tags, and public health report that SHA.
`node /tmp/pi-mcp-resource-live.mjs 278b28f42c9966a7cc944b321bdb6941f9ac3ea9`
passes the real browser journey with a new 420×260 PNG. Its unseen text is
`RESOURCE_9241`; the left shape is a purple triangle and the right shape is a
yellow circle. Pi reads the new image through an embedded MCP resource. The UI
thumbnail and viewer work. Exact private bytes and 51 messages survive restart,
with one tool execution, 22 text deltas, and no environment.

Evidence: `/tmp/pi-mcp-resource-live.json`, `/tmp/pi-mcp-resource-live.png`, and
`/tmp/pi-resource-deployed-status.log`. Immediate stop readback passes. A later
cleanup read detects a passive proxy restart, investigated below.

## Passive SSE retries cannot own Pi lifecycle — 2026-09-09

At 09:50:59 UTC the browser reconnects `/global/event` while the manual stop is
still in flight. Daytona reports no runner. The legacy preview proxy calls
`ensureRunning` despite the stop. The API returns stop success at 09:51:11;
the provider starts again afterward. The turn ledger and queue remain empty.
This is not a user `/start` request. Evidence: `/tmp/pi-cleanup-start-logs.log`.

Pi workers now bypass legacy proxy wake, status healing, and error-state writes.
The guard reads server-owned session metadata through an explicit join. It also
recognizes incomplete Pi identities. Session lifecycle operations remain the
only worker state writers. OpenCode and execution-environment proxy behavior
remain unchanged. Passive traffic may update a usage timestamp; it cannot start
a Pi worker or overwrite its lifecycle state.

- Real PostgreSQL regression: four Pi cases fail before the guard. Afterward,
  **6 pass, 0 fail**, 21 assertions, including OpenCode/environment alternatives.
- PostgreSQL recovery and lifecycle group: **57 pass, 0 fail**, 170 assertions.
- `pnpm test`: all six core lanes pass, **400/400 REST/CLI flows**, **818 worker
  tests**, and seven Node artifact cases. Total 119.8 seconds; benchmark
  `1788948312873`.
- API typecheck passes. Full API: **9,293 pass, 82 existing skips, 0 fail**,
  32,294 assertions; `/tmp/pi-passive-proxy-api-final.log`.
- The first API run finds a readiness race in the confinement test. Its helper
  now waits for `health.ok: true` instead of accepting HTTP 200 during startup.
  The separate first-artifact timeout does not recur in the unchanged focused
  compiler case or final full run. Its cause remains unconfirmed.
- Focused compiled-artifact and confinement cases: **16 pass, 0 fail**,
  89 assertions. No timeout or product assertion is relaxed.

The stop race must pass on the deployed preview with the browser left open,
concurrent SSE retries, provider-state verification, and explicit resume.

## Background log writes cannot resume Pi — 2026-09-09

The deployed `f9e0a35680` regression still fails: the stopped state changes to
running after three reads. The legacy retry wake is fenced, but browser
`POST /log` enters a separate `resumeStoppedSandboxByExternalId` path. No new
`/start` request exists. Evidence: `/tmp/pi-passive-failure-full.log` and
`/tmp/pi-passive-stop-live.json`.

The proxy mutation helper now reads authoritative session metadata and refuses
to claim Pi wake ownership. Explicit session start keeps its direct lifecycle
path. Two database cases fail before the guard. The focused database, existing
start/resume contract, and proxy-policy group then passes: **141 tests, 0 failures,
748 assertions**. The live regression also posts `/log` after every stopped
state sample and verifies the real provider state.

- Final focused PostgreSQL coverage: **9 pass, 0 fail**, 34 assertions, including
  the unchanged OpenCode proxy-mutation resume path.
- `pnpm test`: six core lanes pass, **400/400 REST/CLI flows**, **818 worker
  tests**, and seven Node artifact cases. Total **120.9 seconds**; benchmark
  `1788949946694`. SDK lane passes in 15.0 seconds. API typecheck passes.
- The first full API run has one unrelated `hashBlobs` hook timeout. The
  unchanged hashing file then passes **3 tests, 44 assertions** in isolation.
  The timeout cause is unconfirmed; no test assertion or budget is relaxed.

The final full API gate passes **9,293 tests**, with **82 existing skips**,
**0 failures**, and **32,294 assertions** in 44.08 seconds. Evidence:
`/tmp/pi-passive-mutation-api-final.log`.


## Public HTTPS image admission — 2026-09-09

Pi session creation, warm claims, and durable queued prompts can ingest public
HTTPS PNG, JPEG, GIF, and WebP images. The API checks every redirect, MIME and
signature, 8 MiB per image, 16 images and 16 MiB per prompt, and a 20-second total
download cap bounded by the remaining API request budget. It sends no caller credentials upstream. The worker receives
private immutable references and does not download source URLs.

Existing prompt retries return the original durable command before URL access.
Concurrent admissions insert one command and only the winning attachment set.
A storage conflict rolls back the new command. Remote errors expose neither the
signed URL nor the upstream response body. The shared egress guard now normalizes
literal and mapped IPv6 addresses and closes followed redirect streams.

Local evidence:

- New remote-image tests: 25 fail before implementation; 25 pass after it.
- Focused attachment, first-prompt, and egress tests: 95 pass, zero failures.
- Real local PostgreSQL inbox tests: 56 pass, 160 assertions, zero failures.
  The new cases cover duplicate content, concurrent admission, and rollback.
- `pnpm test -- --id SESS-31`: one flow passes, including private URL denial and
  idempotent retry without downloading replacement content.
- `pnpm --filter kortix-api test`: 9,364 pass, 82 existing skips, zero failures;
  32,487 assertions across 822 files in 58.10 seconds.
- `pnpm --filter kortix-api typecheck` passes.
- `pnpm test`: all six lanes pass in 123.4 seconds. REST/CLI 400/400;
  worker 827 tests and seven real Node artifact cases; SDK passes.
  Benchmark `1788955693190`.

Evidence files: `/tmp/pi-remote-attachments-red.log`,
`/tmp/pi-remote-inputs-final.log`, `/tmp/pi-remote-inbox-pg.log`,
`/tmp/pi-remote-rest-focused.log`, and `/tmp/pi-remote-api-suite.log`.
Deployment and live-source expiry verification remain pending at this checkpoint.
The direct runtime `s.send()` still accepts immutable attachment references;
HTTPS ingestion uses `pending_prompt` or `s.prompts.create()`.


### Live deadline correction

Preview `0e515ced49` passes first-prompt and queued HTTPS image ingestion,
real model vision, expired-source viewer access, accepted retry without another
source request, valid redirects, unsafe redirects, disguised HTML, and oversize
rejection. Its 30-second image deadline loses to the API's 25-second request
deadline and returns 503. The image budget now caps downloads at 20 seconds and
reserves response time from the enclosing request deadline, including time
already spent in authorization and billing. Exhausted budgets perform no fetch.
The request deadline itself and route exemptions remain unchanged.

Two earlier fixture errors are separate from that integration failure. The first
probe used an incorrect message-ID clock; corrected wire IDs pass queued delivery.
The next fixture closed slow responses at Bun's default 10-second idle timeout.
The fixture now allows 60 seconds, so the actual API deadline is observable.
All three interrupted probe workers are stopped. Their failed evidence remains
in `/tmp/pi-remote-images-initial-probe.json`,
`/tmp/pi-remote-images-deadline-fixture-probe.json`, and
`/tmp/pi-remote-images-outer-deadline-probe.json`.


The deadline correction passes 42 focused tests, including cancellation of a
late upstream response. The full API suite passes 9,367 tests with 82 existing
skips and zero failures (32,497 assertions, 49.06 seconds). The late-response
case passes separately after that full run. `pnpm test` passes all six lanes
in 120.3 seconds: 400/400 REST/CLI flows, 827 worker tests, seven Node artifact
cases, and the SDK lane. Benchmark `1788957140799`.
