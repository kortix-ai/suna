# Pi runtime UI verification — 2026-09-07

Branch: `pi-worker`. Draft PR: [#6998](https://github.com/kortix-ai/suna/pull/6998).
Deployment: [pi.kortix.com](https://pi.kortix.com). No merge to `main`.

## Reported failures and fixes

The older worker `26769429-fe31-4559-a0f7-c1ffffaecd19` returns `404` for
`GET /global/event`. Its health route still returns `200`. A healthy process
therefore does not prove that the UI can stream.

The runtime now exposes the installed client's global SSE route, emits typed
connection and heartbeat events, and streams message deltas. The SDK watchdog
receives the heartbeat payload; SSE comments alone do not reset that watchdog.
A provider iterator error becomes a terminal assistant error instead of leaving
its result promise unresolved.

The question tool and list/reply/reject routes now use the existing question UI.
Question tool results preserve answer metadata when history is restored.
Permissions, todos, commands, skills, and their discovery routes are also wired.

The Pi starter prompt incorrectly advertised four tools and no skill loader.
The starter now describes the available tools. Runtime guidance also derives its
catalog from registered tools after the compiled prompt. Older project prompts
therefore receive current capability information without losing their own
restrictions on tool use.

Live assistant messages now publish the compiled agent and gateway model identity.
Previously the adapter omitted both values, so live messages used native provider
names and the default `build` agent. The UI could not match those messages to its
model catalog. Restored messages already use the resolved identity.
The SDK also resolves Pi's context meter from its compiled model. Account and
persisted preferences no longer replace that displayed model or context limit.

The SDK sends Pi slash commands without per-turn agent, model, or variant
selections. Pi runs the compiled command on its immutable session runtime.
OpenCode command selections retain their existing behavior.

Existing workers keep their compiled executable. A frontend reload does not
install a new worker. Start a new session, or stop and resume an existing session,
to load current code. Completed transcript preservation is verified separately
in [the lifecycle record](./PI_WORKER_VERIFICATION.md).

## Deployed evidence

The capability implementation is `1f3a3005e74bef2b4e2ae03e86a3b581b6e26e39`.
[Deployment 34117577813](https://github.com/kortix-ai/suna/actions/runs/34117577813)
completed successfully. `/v1/health` reported that exact commit and
`started_at: 2026-09-07T11:42:42.202Z`.

Follow-up deployments also completed successfully:

- Runtime tool guidance: `30a02923b4789f4c7277796e38605a3c69b5ee00`,
  [run 34119455187](https://github.com/kortix-ai/suna/actions/runs/34119455187).
- SDK command routing: `fa10933e265f4fb7b7f6e8feedcb1dfd04a72d15`,
  [run 34120300619](https://github.com/kortix-ai/suna/actions/runs/34120300619).

The live health response reported each exact SHA after its deployment.
Stopping and resuming the capability session on the guidance deployment preserved
28 message IDs, 26 part IDs, both todos, and answered question metadata.
A normal request for a rendered question then opened the question UI.
Selecting `parity-proof` from the composer menu submitted the command route,
returned `200`, and rendered `COMMAND_PARITY_BROWSER_FINAL`.

Browser verification session:
[`1b979441-ab55-4fce-91de-aaa1a0e4f636`](https://pi.kortix.com/projects/80b8142e-02b8-456d-8684-bff4d3e5718e/sessions/1b979441-ab55-4fce-91de-aaa1a0e4f636).
Permission verification session:
[`b5e9e132-45d6-4bd9-85d3-314be5430d70`](https://pi.kortix.com/projects/80b8142e-02b8-456d-8684-bff4d3e5718e/sessions/b5e9e132-45d6-4bd9-85d3-314be5430d70).

| Feature | Observed input and output |
|---|---|
| Idle SSE and incremental text | After 65 seconds idle, 112 partial assistant renders arrived, from 225 to 6,860 characters. One global stream remained connected. Stop stayed visible throughout partial rendering. |
| Questions | Three questions rendered. The browser submitted `[["Blue"],["Types","Tests"],["CUSTOM_LIVE_20260907"]]`. The pending question survived reload; the answered card survived another reload. |
| Question dismissal | The browser posted question rejection and session abort, both `200`. Pending questions cleared. A subsequent prompt completed. Dismissal intentionally stops the turn in the existing web UI. |
| Todos | `todowrite` created two items. The UI displayed them. `GET /session/:id/todo` returned `200` with matching content, priorities, and statuses. |
| Permissions | Real reads outside `/workspace` prompted in the UI. Buttons submitted `once`, `reject`, and `always`. Repeated approved access produced no additional request. The default starter's `permission: allow` correctly prompts for none. |
| Skill loading | `skill` loaded the compiled `parity-proof` instructions. `read` fetched its support file from the environment. Both independent markers appeared in the assistant reply. |
| Project commands | The test command was compiled at Git SHA `5255154f82382588f2896f6185b503a29248b9fa`. `POST /session/:id/command` returned `200` and `COMMAND_PARITY_20260907`; that reply rendered in the browser. |
| Stop and next prompt | The real Stop control posted `/abort`, which returned `200`. The immediately following prompt completed with `REPROMPT_AFTER_STOP_VERIFIED`. |
| Discovery | Agent, command, skill, tool IDs, global config, question, and permission routes returned `200`. No runtime HTTP errors were observed across the completed browser checks. |

The test fixture changes only a disposable session branch. The project default
branch is unchanged. Its permission fixture is commit
`1e7cd66fc97dd63bef6002816f3fcad49ac28305`.

The [earlier verification record](./PI_WORKER_VERIFICATION.md) contains live proof
for all six remote workspace tools, Files, Outputs, terminal, shared filesystem
CLI, environment startup, stopped history, and stable message IDs after restart.

## Local checks

- `pnpm test`: all lanes pass; REST/CLI reports `395/395 passed`, zero failures.
- `pnpm --filter @kortix/sdk typecheck`, `test`, `smoke:install`: exit `0`.
  The SDK suite records `2,847` passing tests. The install smoke imports and
  constructs clients from packed tarballs.
- Selected committed worker source: `244 pass`, `0 fail`, 36 files.
  This source snapshot excludes unrelated worktree changes.
- Selected API compiler tests: `19 pass`, `0 fail`; per-agent and payload
  checks: `20 pass`, `0 fail`. API typecheck passes.
- Starter package: `92 pass`, `0 fail`; starter and worker typechecks pass.
- New runtime guidance and starter tests failed before the implementation,
  then passed. The generated starter snapshot changes only the Pi agent prompt.
- The SDK command-selection regression and live model-identity regression also
  failed before their fixes, then passed.

The broader package gate initially found a stale generated SDK documentation
timestamp. Regeneration fixed its focused test. A subsequent run exposed an SSE
test assumption that one read contains the whole transport frame. The test now
reads through closure and still rejects any oversized event reaching the limited
client. The healthy subscriber must receive its event. The completed
`pnpm test -- --packages-only` run passed in 218.9 seconds. Its web suite reported
`9,433 passed`.

## Question input constraints

The composer disables text entry when the current question has `custom: false`.
It shows “Choose an option above” and preserves the option controls. Multiple
selections advance with Next. A custom answer remains available when allowed.
Confirm shows “Review your answers above” and submits the collected answers.
It does not append an extra note to the final question.

Local Chromium uses the current frontend with the real Pi preview API. The
three-question journey submits `[["Blue"],["Red","Green"],["violet note"]]` with
HTTP `200`. A separate single-choice question disables the send control and
submits `[["Blue"]]` through the option button. Normal text entry returns after
completion. Reload preserves the transcript. No network request fails.

`pnpm --dir apps/web test`: 9,459 pass, zero fail, 35,512 assertions, 31.37 seconds.
`pnpm --dir apps/web exec tsc --noEmit`: exit 0. Focused eslint: zero errors;
37 existing warnings. `pnpm test`: all lanes pass in 47.3 seconds, including
395/395 REST/CLI flows. The brand audit reports the same existing violations
before and after this change; the change introduces no new visual values.

## Failed question replies

A browser-injected HTTP `503` reproduces the previous failure: the backend
question remains pending, but the web card disappears. The question component
now retains the card until acknowledgment, disables duplicate submissions,
resets its controls on failure, and displays the error. The session handler
removes the question and caches answers only after acceptance. A failed dismissal
does not send the session abort request. A custom reply keeps its text on failure
and clears it after success only if the draft has not changed.

The frontend suite passes 9,463 tests, zero failures, and 35,528 assertions in
32.49 seconds. Typecheck exits 0. Focused eslint reports zero errors and 37
existing warnings. `pnpm test` passes all lanes in 47.4 seconds, including
395/395 REST/CLI flows. Local browser verification uses the real Pi API and
injects failures only into the reply and rejection responses. Three injected 503
responses preserve the same question or custom text. The failed dismissal emits
zero abort requests. Both answer retries return HTTP 200 with their exact payloads;
reload preserves the transcript, with no unexpected network failures.

## Compatibility limits

These fixes do not establish complete OpenCode replacement parity.

| Surface | Remaining limitation |
|---|---|
| Attachments and prompt options | The committed prompt path supports text. File/image parts and several per-turn options are not complete. |
| Commands | Agent/model/variant overrides, subtasks, shell interpolation, and file references return explicit unsupported errors. |
| Extensibility | Custom tool/plugin hooks, MCP, and durable subagents are not implemented in the committed Pi worker. |
| Compaction and complete OpenCode lifecycle | Full compaction, child-session, and raw lifecycle compatibility remain incomplete. |
| Interactive requests across worker replacement | Pending questions and permissions restore through durable checkpoints. Real replacement checks preserve request and message IDs, saved responses, and exact side-effect counts. |
| LSP | Pi has no language-server process. Config advertises `lsp: false`; diagnostics are empty. |
| Agent configuration | Some fields are discoverable but do not yet drive runtime behavior. The session's agent and model remain immutable. |

The full deployed suite still has the separately documented Git-upload failures.
Public preview URL and admin-browser regressions are resolved. New behavior is verified on the branch
preview. Dev and production verification do not apply before an approved merge.

**Shippable to production: NOT YET.**


## Session storage outages

Commit `a2d2bad054a377c8de6ea77a153c2df48d30bc16` preserves pending interactions
until the confirmed owner lease expires. Expired work cancels independently of
network reads, then reconciles when storage returns without another prompt.
`pnpm test` passes all lanes in 49.1 seconds: 395/395 REST/CLI flows and 527 worker
tests with 2,317 assertions. Both child-process outage regressions fail before
the fix and pass afterward.

Deployment [34162712070](https://github.com/kortix-ai/suna/actions/runs/34162712070)
succeeds, and public health serves its exact SHA. Stopping only the preview API
for 12 seconds produces a 25.7-second restart/recovery interval. The same worker
retains question `que_808504de2e144a399d361dc5aa58142d` and all 20 message IDs.
Reply `[["Blue"]]` returns 200. No new error appears, active turns become zero,
and reload preserves the transcript. All 55 failed browser requests occur during
the deliberate outage; none is an authentication rejection. The full preview
browser suite passes 19/19 without retries in 180.1 seconds.

Replacement also settles the previously stalled test session while preserving
its complete 18-message transcript and existing MessageAbortedError.


## Pending permissions across replacement

Commit `0e9551eb73857ee9c31f81773b87b2f977b4ce88` persists each permission stage
and its response before acknowledgment. The local root command passes all lanes
in 57.6 seconds: 395/395 REST/CLI flows and 549 worker tests across 67 files, with
2,876 worker assertions. Eleven child-process crash scenarios cover staged
approvals, saved once/always/reject responses, Stop, another worker's queue,
repeated-tool guards, and an uncertain release write.

Deployment [34164573615](https://github.com/kortix-ai/suna/actions/runs/34164573615)
succeeds and public health serves that SHA. In session
`75e1d343-af9b-4d82-a824-83e06da724ac`, a primary command approval commits before
an external-directory permission blocks the same invocation. Restart returns
202. A different owner restores request `per_6c866490dcc3487b8a1db637c0d87c7a`
after 72.5 seconds, preserving both message IDs and the earlier one-time approval.

The file remains absent before approval and after replacement. The browser
posts `{ "reply": "once" }` with HTTP 200. The resulting file contains exactly
one marker, the tool completes, and active turns become zero. Reload preserves
the exact transcript. All 34 failed browser requests occur during the deliberate
restart; none is an authentication rejection.

The first browser attempt needed a specific selector because permission controls
appear in both the tool result and the composer. The next attempt exposed a
wildcard mismatch for a literal newline. Approval of that primary request then
verified recovery of the following external-directory stage. The wildcard
regression fails locally before its follow-up fix and passes afterward.

## Permission wildcards and repeated question call IDs

Deployment [34165737162](https://github.com/kortix-ai/suna/actions/runs/34165737162)
serves `f4f764f13d7bf6ddfe871e58ad0d416f8059965c`. A live bash command containing
a literal newline receives only the configured external-directory request.
The browser approval returns 200. The command writes exactly one marker, active
turns settle, and reload preserves the transcript with zero failed requests.
The full preview browser suite passes 19/19 without retries in 190.4 seconds.
The original reported session also reloads this worker while preserving all 15
wire messages exactly and adding no error.

The repeated question regression reuses a provider call ID in a later assistant
message. Replacement restores the second request and both distinct answers.
Earlier tool effects execute once. Root checks pass in 58.6 seconds, including
395/395 REST/CLI flows and 554 worker tests with 2,914 assertions.

## Session permission updates

The real child-process regression first returns 404 for `PATCH /session/:id`.
The implementation stores ordered rules before acknowledgment and makes reset
restore compiled policy. Six HTTP scenarios cover replacement, rejected input,
failed writes, cross-worker updates, queued always grants, and prompt controls.
Store tests also cover concurrent reset, approval retries, and corrupt records.
The root command passes in 59.8 seconds, including 395/395 REST/CLI flows.
Live session-wide permission verification follows deployment of this change.
