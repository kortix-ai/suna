# Session Attachments Robustness Implementation Plan

> **For implementers:** Execute this plan with the `superpowers:subagent-driven-development` workflow. Read each generated task brief before editing. Use Node 22.22.3 for every `pnpm` command:
> `PATH="/Users/jay/.nvm/versions/node/v22.22.3/bin:$PATH"`.

**Goal:** Fix the four verified dev regressions around prompt attachments, prompt polling, runtime-scoped transcript reads, and healthy-session reloads.

**Design authority:** `/tmp/kortix-handoff-2026-09-07/HANDOFF.md` and its four linked briefs. Jay approved bugs 1–4. The eager-upload request is a separate design-spec gate and is not part of this implementation plan.

**Architecture:** Keep file-delivery compatibility in the API and sandbox daemon. Keep session synchronization and prompt cadence in `@kortix/sdk`. Keep `apps/web` as a thin consumer. Use explicit runtime capabilities and immutable session/runtime ownership. Treat runtime skew and transient navigation failures as recoverable states.

**Technology:** Bun, TypeScript, Hono, React 19, TanStack Query 5, Next.js 16, Playwright.

## Global Constraints

- Do not merge this branch to `main` without Jay's explicit approval.
- Keep the draft PR labeled `preview`. Re-add the label after a new head removes it.
- SDK changes use strict TDD. Capture the failing command and output before implementation.
- SDK exports require the source export, the correct public barrel, and both public-surface snapshots.
- Do not rename or remove an SDK export.
- Do not bump `packages/sdk/package.json` version.
- Use `pnpm test` as the repository-level test command. Use package-local commands only for the focused RED/GREEN loop.
- A runtime response parsed as JSON must validate both HTTP success and JSON content. Never expose Bun's parser text.
- `RUNTIME_WHOLE_UPLOAD_CEILING_BYTES` is exactly `96 * 1024`.
- A new daemon route must have a capability check or a backward-compatible fallback.
- A stale daemon must park a prompt on the runtime-unreachable ladder. It must not consume the five-attempt dead-letter budget.
- The daemon must keep turn-in-flight and PTY blockers when it retries a deferred agent swap.
- The daemon capability name for chunk append is `file.append`.
- Runtime capability reads cache per `externalId` for about 60 seconds.
- Live inbox cadence steps are exactly `1_000`, `2_000`, and `4_000` ms.
- Every live cadence step must satisfy `step + 2 * 2_500 < INBOX_OBSERVATION_MAX_MS` where the observation ceiling is 10,000 ms.
- Terminal-only and empty inboxes use the existing 15,000 ms idle cadence.
- Focus, inbox mutations, and a list fingerprint change reset the live cadence.
- Only the existing poll owner schedules prompt inbox reads.
- A session-sync controller owns one immutable `(opencodeSessionId, runtimeUrl)` tuple.
- `scheduleTailRetry` itself must no-op when the controller has zero consumers or retries are paused.
- OpenCode JSON `404 NotFoundError` is terminal for one immutable tuple. Proxy HTML and `not-running` 404 responses remain wakeable.
- Runtime-scope ownership must cover hydration, SSE-gap rehydration, event reconciliation, prefetch, and `noteSessionSyncEvent`.
- `session.deleted` removes the session's synchronized data and ownership metadata.
- Abort-like and idempotent transient `getProject` failures retry with bounded backoff. They do not render the unavailable card while the retry budget remains.
- After the bounded retry budget is exhausted, the existing unavailable card may render.
- Preserve the existing 403 access-request and 404 not-found verdicts.
- Web visual edits must use existing design-system primitives and brand tokens. Run the brand audit on changed web paths.
- Append the new incident learning immediately below `## Register`. Do not edit prior learning entries.
- No eager-upload implementation is authorized in this plan.

### Task 1: Negotiate runtime file-upload compatibility

**Brief:** `/tmp/kortix-handoff-2026-09-07/brief-A-stale-daemon-upload.md`

**Files:**

- Modify: `apps/api/src/projects/session-lifecycle/runtime-prompt-file.ts`
- Modify: `apps/api/src/projects/session-lifecycle/runtime-prompt-file.test.ts`
- Modify: `apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.ts`
- Modify: `apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.test.ts`
- Modify as needed for a 60-second capability cache: `apps/api/src/projects/lib/session-runtime-projection.ts` or a focused sibling module

**Step 1: Write the failing runtime response tests**

- Add a test where `POST /file/append` returns `200 text/html` with an OpenCode SPA body.
- Use `RUNTIME_PROMPT_CHUNK_BYTES + 1` bytes.
- Assert the current raw `Failed to parse JSON` behavior is replaced by a named unsupported-route error.
- Add the same guard case for `POST /file/upload`.
- Add a first-chunk fallback case that expects `/file/append`, `/file/upload`, and `/file/rename`.
- Add a 200 KiB case that never calls `/file/upload` and expects a typed stale-daemon error.

Run RED:

```bash
cd apps/api
bun test --isolate --env-file=scripts/test.env --timeout=15000 \
  src/projects/session-lifecycle/runtime-prompt-file.test.ts \
  src/projects/session-lifecycle/prompt-attachment-materializer.test.ts
```

Record the exact failures in the task report.

**Step 2: Add typed response parsing**

- Add one helper for every runtime response that the file writer parses as JSON.
- If the response is not successful, throw the existing operation-specific failure with the HTTP status.
- If `Content-Type` is not JSON, throw `RuntimeRouteUnsupportedError`.
- If JSON parsing fails, throw the same typed error.
- The message must name method, route, status, and content type.
- Do not expose `SyntaxError` or `Failed to parse JSON`.
- Apply the helper to whole upload and chunk append. Check rename for the same response contract.

**Step 3: Add the bounded fallback**

- Export `RUNTIME_WHOLE_UPLOAD_CEILING_BYTES = 96 * 1024`.
- Catch `RuntimeRouteUnsupportedError` only on the first append chunk.
- Under the ceiling, call legacy `/file/upload` and continue to rename.
- Above the ceiling, throw `RuntimeStaleDaemonError` with route and byte count.
- Preserve best-effort temporary-file cleanup without replacing the original failure.

**Step 4: Add capability negotiation**

- Read `/kortix/health` once per `externalId` and cache the capability decision for about 60 seconds.
- Choose `/file/append` only when `capabilities` contains `file.append`.
- Treat an absent `capabilities` field as a legacy daemon.
- Under the whole-upload ceiling, use `/file/upload` immediately for a legacy daemon.
- Above the ceiling, throw `RuntimeStaleDaemonError` without sending an unsupported append request.
- Preserve the try-then-fallback path for a stale cache or capability drift.

**Step 5: Preserve materializer context**

- Keep the exact `<filename> — <reason>` message format.
- Add a typed `stale` discriminator to `PromptAttachmentMaterializationError`.
- Set it when any collected failure is a `RuntimeStaleDaemonError`.
- Add a materializer test that sees the runtime-stale reason and never the JSON parser text.

**Step 6: Run GREEN and the API lane**

```bash
cd apps/api
bun test --isolate --env-file=scripts/test.env --timeout=15000 \
  src/projects/session-lifecycle/runtime-prompt-file.test.ts \
  src/projects/session-lifecycle/prompt-attachment-materializer.test.ts
cd ../..
PATH="/Users/jay/.nvm/versions/node/v22.22.3/bin:$PATH" pnpm test -- --domain sessions
```

**Step 7: Commit**

```bash
git add apps/api/src/projects/session-lifecycle/runtime-prompt-file.ts \
  apps/api/src/projects/session-lifecycle/runtime-prompt-file.test.ts \
  apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.ts \
  apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.test.ts \
  apps/api/src/projects/lib/session-runtime-projection.ts
git commit -m "fix(api): negotiate runtime file uploads"
```

Adjust the final pathspec to the actual focused cache module. Do not stage unrelated files.

### Task 2: Park stale-daemon prompts and complete daemon convergence

**Brief:** `/tmp/kortix-handoff-2026-09-07/brief-A-stale-daemon-upload.md`

**Files:**

- Modify: `apps/api/src/projects/session-lifecycle/engine.ts`
- Modify: `apps/api/src/projects/session-lifecycle/store.ts`
- Modify: `apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts`
- Modify: `apps/api/src/projects/lib/sandbox-runtime-refresh.ts`
- Modify: `apps/kortix-sandbox-agent-server/src/routes/files.ts`
- Modify: `apps/kortix-sandbox-agent-server/src/routes/health.ts`
- Modify: `apps/kortix-sandbox-agent-server/src/routes/refresh.ts`
- Modify: `apps/kortix-sandbox-agent-server/src/runtime-assets.ts`
- Modify relevant daemon tests under `apps/kortix-sandbox-agent-server/src/__tests__/`
- Modify: `apps/web/src/features/session/turn/queued-prompt-bubbles.tsx`
- Modify relevant queue projection/copy tests under `apps/web/src/features/session/`

**Step 1: Write the failing engine test**

- Make the file writer throw a stale materialization error.
- Assert the row remains queued and the current claim attempt is given back.
- Assert a named runtime-stale blocked reason is stored.
- Assert five identical drains do not create a dead-lettered row.
- Assert the existing 30/120/480-second runtime-unreachable ladder bounds retries.
- Assert Stop/hold semantics remain intact.

Run RED:

```bash
cd apps/api
bun test --isolate --env-file=scripts/test.env --timeout=15000 \
  src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts
```

**Step 2: Park on the existing runtime ladder**

- Classify only typed stale materialization failures.
- Use `parkPromptForUnreachableRuntime` and the existing retry budget.
- Add a named `runtime_stale` reason beside `runtime_unreachable`.
- Give the claimed attempt back.
- Schedule `scheduleSandboxRuntimeRefresh(sessionId, 'stale-daemon')`.
- When the runtime-unreachable ladder is exhausted, record one final named failure.
- Do not string-match parser messages.

**Step 3: Make refresh request an idle swap**

- For `stale-daemon`, call `/kortix/refresh?restart=0&swap=1`.
- Old daemons may ignore the query parameter.
- On the daemon, accept `swap=1` only on the existing authenticated refresh route.
- Ignore the minimum uptime for this explicit request.
- Keep turn-in-flight and PTY blockers.

**Step 4: Terminate the daemon file namespace**

- Add a final JSON 404 handler inside `createFilesRouter`.
- Assert an unknown `/file/*` never falls through to the OpenCode SPA.
- Inspect other daemon-owned mounted sub-apps for the identical fallthrough hole.
- Add terminal JSON 404 handlers only where the same risk exists and tests prove the mount behavior.

**Step 5: Advertise capabilities**

- Add an additive `capabilities` array to `/kortix/health`.
- Include `file.append`.
- Add or update the health contract test.
- Keep old health consumers valid.

**Step 6: Re-ask deferred swaps**

- When a reconcile returns `too-young` with `agent.next` pending, arm one unref'd timer for the remaining uptime gate.
- At the timer, call the same guarded `requestAgentSwapIfIdle` path.
- Re-ask at turn end when a staged agent remains.
- Keep one timer per daemon process.
- Cancel or coalesce obsolete timers.
- Keep the turn-in-flight and PTY checks on every re-ask.
- Add tests for too-young, timer expiry, busy turn, PTY blocker, and turn-end retry.

**Step 7: Render a recoverable parked row**

- Map the `runtime_stale` blocked reason to copy that means `Waiting for the workspace…`.
- Do not render `Not sent` for this state.
- Preserve Retry and Remove for actual failed rows.
- Use existing primitives, translations, type, color, radius, and spacing tokens.

**Step 8: Run focused GREEN gates**

```bash
cd apps/api
bun test --isolate --env-file=scripts/test.env --timeout=15000 \
  src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts
cd ../../apps/kortix-sandbox-agent-server
bun test src/__tests__/runtime-convergence.test.ts src/__tests__/files-routes.test.ts
cd ../web
bun test src/features/session/session-chat-inbox-queue.test.ts
npx eslint src/features/session/turn/queued-prompt-bubbles.tsx
../../.claude/skills/kortix-brand-guidelines/audit.sh \
  src/features/session/turn/queued-prompt-bubbles.tsx
```

Use the actual daemon file-route test path if its name differs.

**Step 9: Commit**

```bash
git add apps/api/src/projects/session-lifecycle/engine.ts \
  apps/api/src/projects/session-lifecycle/store.ts \
  apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts \
  apps/api/src/projects/lib/sandbox-runtime-refresh.ts \
  apps/kortix-sandbox-agent-server/src/routes/files.ts \
  apps/kortix-sandbox-agent-server/src/routes/health.ts \
  apps/kortix-sandbox-agent-server/src/routes/refresh.ts \
  apps/kortix-sandbox-agent-server/src/runtime-assets.ts \
  apps/web/src/features/session/turn/queued-prompt-bubbles.tsx
git commit -m "fix(runtime): recover stale attachment delivery"
```

Include every actual focused test/translation file in the final explicit pathspec.

### Task 3: Back off prompt-inbox polling

**Brief:** `/tmp/kortix-handoff-2026-09-07/brief-B-prompts-poll-spam.md`

**Files:**

- Modify: `packages/sdk/src/react/use-session-prompts.ts`
- Modify: `packages/sdk/src/react/use-session-prompts.test.ts`
- Modify: `packages/sdk/src/react/opencode.ts`
- Regenerate: `packages/sdk/src/public-surface.snapshot.json`
- Regenerate: `packages/sdk/src/public-type-surface.snapshot.json`
- Modify stale comment only: `apps/web/src/features/session/session-chat.tsx`

**Step 1: Write pure failing cadence tests**

- A terminal-only list uses 15,000 ms.
- Failed plus queued uses the live ladder.
- Identical live snapshots advance 1,000 → 2,000 → 4,000 → 4,000 ms.
- Every rung satisfies the named 2,500 ms latency-budget invariant.
- A fingerprint change resets to 1,000 ms.
- Mutation and focus resets return to 1,000 ms.
- Held rows remain non-terminal.
- The fingerprint includes prompt id, state, reason, attempts, last error, message id, and available time.
- The fingerprint excludes observation timestamps.

Run RED:

```bash
cd packages/sdk
bun test --isolate src/react/use-session-prompts.test.ts
```

**Step 2: Write a failing real QueryObserver test**

- Use a real `QueryClient` and `QueryObserver` with fake timers.
- Return one failed row and advance 60 seconds.
- Assert at most four fetches after the initial fetch.
- Return one queued row repeatedly and assert the exact 1/2/4/4 schedule.
- Trigger focus and assert the next live interval resets to 1 second.
- Assert two observers with one poll owner do not increment cadence twice.

**Step 3: Implement pure cadence state**

- Count only non-terminal prompts for the fast cadence.
- Preserve `sessionPromptsPollMs` and extend it with optional trailing cadence state.
- Export the non-terminal counter, ladder constant, fingerprint, and cadence-state transition.
- Store cadence state per project/session only from the query function path.
- Clear cadence ownership on the last observer/session cleanup.
- Do not introduce a second timer.

**Step 4: Reset on every required event**

- Reset on enqueue, retry, hold, remove, focus, and list fingerprint change.
- Keep existing invalidations.
- On retry success, place the returned queued row into the query cache.
- Re-arm the working projection without bypassing the existing server-stamp ordering guard.

**Step 5: Update exports and snapshots**

- Add exports to `packages/sdk/src/react/opencode.ts`.
- Regenerate both public-surface snapshots with the SDK's existing generator.
- Do not hand-edit generated snapshots.
- Update only the stale web comment that names the removed runtime stream.

**Step 6: Run GREEN and SDK gates**

```bash
cd packages/sdk
bun test --isolate src/react/use-session-prompts.test.ts
cd ../..
PATH="/Users/jay/.nvm/versions/node/v22.22.3/bin:$PATH" pnpm test -- --sdk-only
```

The task report must end with SDK shippability `YES`, `NO`, or `NOT YET`.

**Step 7: Commit**

```bash
git add packages/sdk/src/react/use-session-prompts.ts \
  packages/sdk/src/react/use-session-prompts.test.ts \
  packages/sdk/src/react/opencode.ts \
  packages/sdk/src/public-surface.snapshot.json \
  packages/sdk/src/public-type-surface.snapshot.json \
  apps/web/src/features/session/session-chat.tsx
git commit -m "fix(sdk): back off prompt inbox polling"
```

### Task 4: Bind session synchronization to one runtime

**Brief:** `/tmp/kortix-handoff-2026-09-07/brief-C-wrong-session-id-reads.md`

**Files:**

- Modify: `packages/sdk/src/browser/session-sync/session-sync-registry.ts`
- Modify: `packages/sdk/src/browser/session-sync/session-sync-registry.test.ts`
- Modify: `packages/sdk/src/core/session-sync/session-sync-controller.ts`
- Modify: `packages/sdk/src/core/session-sync/session-sync-controller.test.ts`
- Modify: `packages/sdk/src/core/http/opencode-errors.ts`
- Modify: `packages/sdk/src/react/use-opencode-events/index.ts`
- Modify: `packages/sdk/src/react/use-opencode-events/rehydrate-targets.ts`
- Modify: `packages/sdk/src/react/use-opencode-events/rehydrate-targets.test.ts`
- Modify: `packages/sdk/src/react/use-opencode-events/handle-event.ts`
- Modify: `packages/sdk/src/browser/stores/sync-store.ts`
- Modify: `packages/sdk/src/react/use-session-sync.ts`
- Modify: `packages/sdk/src/react/use-session.ts`
- Modify: `packages/sdk/src/react/use-session-prefetch.ts`
- Modify public barrels and both SDK surface snapshots when the new error is exported
- Update: `packages/sdk/README.md` and `apps/web/content/docs/sdk/` only if a public behavior needs documentation

**Step 1: Reproduce the navigation-order trigger first**

- Use `react-test-renderer` with React 19.
- Bind busy session A to runtime A.
- Unmount in the real hook declaration order: clear the global runtime, then release the controller.
- Bind runtime B.
- Advance timers past one second.
- Assert current code reads session A against runtime B.
- Keep this as a permanent regression test that expects zero foreign reads after the fix.

**Step 2: Write the remaining RED tests**

- A released controller cannot read through the global runtime.
- `scheduleTailRetry` performs no work at zero consumers, including after an asynchronous turn-end failure.
- Last release cancels a previously armed timer.
- Runtime switch destroys consumer-less controllers from another scope before binding the new global runtime.
- OpenCode JSON `404 NotFoundError` makes the tuple terminal and schedules no retry.
- Proxy HTML/not-running 404 remains wakeable.
- SSE-gap rehydrate selects only sessions owned by the stream scope.
- Sessions with no recorded owner are skipped.
- Hydration stamps ownership.
- `session.deleted` drops messages, ids, detached state, and ownership.
- Prefetch and `noteSessionSyncEvent` use the same explicit scope.

Run RED:

```bash
cd packages/sdk
bun test --isolate \
  src/browser/session-sync/session-sync-registry.test.ts \
  src/core/session-sync/session-sync-controller.test.ts \
  src/react/use-opencode-events/rehydrate-targets.test.ts
```

**Step 3: Make controller identity immutable**

- Capture `runtimeUrl` when the registry creates the controller.
- Resolve the OpenCode client from that URL only.
- Remove the global-client fallback.
- Keep the explicit client used by prefetch bound to the same entry.
- Refuse owner-less controller creation when no runtime URL is available.

**Step 4: Stop detached retries**

- Add a paused/consumer predicate to the controller.
- Make `scheduleTailRetry` check it before arming and again before firing.
- Cancel the timer on last release.
- Ensure a turn-end reconcile failure that settles after release cannot re-arm it.
- Keep a retained controller's right-runtime retry behavior.

**Step 5: Scope every producer**

- Destroy consumer-less foreign-scope controllers before setting the next global runtime.
- Pass runtime scope through initial reconciliation, SSE-gap rehydrate, `handle-event`, prefetch, and `noteSessionSyncEvent`.
- Stamp the runtime owner on live upsert and mirror hydration.
- Skip owner-less stored ids during gap rehydrate.
- Remove all synchronized state on `session.deleted`.

**Step 6: Classify tuple-terminal 404 correctly**

- Add `SessionNotFoundOnRuntimeError` in `opencode-errors.ts`.
- Construct it only from OpenCode's JSON `NotFoundError` body.
- Leave proxy HTML and not-running patterns on the wakeable path.
- Mark transcript freshness `error` once for the terminal tuple and schedule no retry.
- Export the error additively through all required SDK surfaces.

**Step 7: Run GREEN and SDK gates**

```bash
cd packages/sdk
bun test --isolate \
  src/browser/session-sync/session-sync-registry.test.ts \
  src/core/session-sync/session-sync-controller.test.ts \
  src/react/use-opencode-events/rehydrate-targets.test.ts
cd ../..
PATH="/Users/jay/.nvm/versions/node/v22.22.3/bin:$PATH" pnpm test -- --sdk-only
```

The task report must end with SDK shippability `YES`, `NO`, or `NOT YET`.

**Step 8: Commit**

```bash
git add packages/sdk/src/browser/session-sync \
  packages/sdk/src/core/session-sync \
  packages/sdk/src/core/http/opencode-errors.ts \
  packages/sdk/src/react/use-opencode-events \
  packages/sdk/src/browser/stores/sync-store.ts \
  packages/sdk/src/react/use-session-sync.ts \
  packages/sdk/src/react/use-session.ts \
  packages/sdk/src/react/use-session-prefetch.ts \
  packages/sdk/src/index.ts \
  packages/sdk/src/public-surface.snapshot.json \
  packages/sdk/src/public-type-surface.snapshot.json
git commit -m "fix(sdk): bind transcript reads to runtime"
```

Include any additional required public barrel or documentation file explicitly.

### Task 5: Recover healthy project reloads from transient aborts

**Brief:** `/tmp/kortix-handoff-2026-09-07/HANDOFF.md` section 4

**Files:**

- Modify: `apps/web/src/components/projects/project-access-boundary.tsx`
- Modify: `apps/web/src/components/projects/project-access-boundary.test.ts`
- Add or modify a Playwright journey under the existing `tests/` browser system
- Update `tests/spec/end-to-end.md` and route metadata only if the journey adds a contract step
- Modify the proven source of the early 0.7-second navigation if diagnosis identifies one

**Step 1: Reproduce with a real browser route**

- Use the existing Playwright browser harness.
- Load a valid project route.
- Abort the first `GET /projects/:id` once.
- Assert the transcript or project shell renders without a manual `Try again` press.
- On current code, assert the test fails because the unavailable card appears.
- Capture the failed request, navigation events, and final DOM state in the task report.

**Step 2: Add pure retry classification tests**

- 403 remains the access-request state.
- 404 remains not-found.
- `AbortError`, `ERR_ABORTED`, network failure, 408, 429, and 5xx are transient.
- Other non-transient client failures become unavailable.
- The retry schedule is bounded and idempotent.

**Step 3: Implement bounded query retries**

- Replace `retry: false` with a pure retry predicate and delay function.
- Retry only idempotent transient or abort-like failures.
- Use a short bounded exponential backoff.
- Do not paint `unavailable` while the abort-like retry sequence is active.
- Preserve manual retry after the bounded sequence truly fails.
- Preserve waiting-state polling and access-request behavior.

**Step 4: Identify the early navigation source**

- Instrument Playwright navigation and router events around the 0.7-second window.
- Check last-project-cookie resolution, auth redirect, query-prefill stripping, and instant-session shell only when evidence names them.
- If the navigation is unnecessary, remove its source and add a regression assertion.
- If the navigation is required, document why the boundary must tolerate its cancellation.
- Do not change unrelated redirect behavior without a failing test.

**Step 5: Run focused checks**

```bash
cd apps/web
bun test src/components/projects/project-access-boundary.test.ts
npx eslint src/components/projects/project-access-boundary.tsx \
  src/components/projects/project-access-boundary.test.ts
../../.claude/skills/kortix-brand-guidelines/audit.sh \
  src/components/projects/project-access-boundary.tsx
cd ../..
PATH="/Users/jay/.nvm/versions/node/v22.22.3/bin:$PATH" pnpm test -- --browser-only
```

**Step 6: Commit**

```bash
git add apps/web/src/components/projects/project-access-boundary.tsx \
  apps/web/src/components/projects/project-access-boundary.test.ts \
  tests/spec/end-to-end.md tests/src
git commit -m "fix(web): retry transient project reloads"
```

Stage only the actual Playwright files and any proven navigation-source file.

### Task 6: Record the daemon compatibility incident and run branch gates

**Brief:** `/tmp/kortix-handoff-2026-09-07/HANDOFF.md` sections 5–6

**Files:**

- Modify append-only: `.claude/skills/learnings/SKILL.md`
- Modify only if needed for discoverability: relevant attachment/session documentation already linked from the changed public surface

**Step 1: Append the incident rule**

- Insert the new entry immediately below `## Register`.
- State this rule exactly: `A new daemon route ships behind a capability check or a fallback; the API and the daemon never assume the same build.`
- Record the incident: `/file/append` shipped in API and daemon together, an old daemon fell through to OpenCode's SPA, and five retries dead-lettered the first prompt.
- Name the enforcers from Tasks 1–2: non-JSON response guard, capability negotiation, legacy whole-upload fallback, engine parking, terminal file-router 404, and deferred-swap tests.
- Do not alter any prior register entry.

**Step 2: Run the complete local branch gate**

```bash
PATH="/Users/jay/.nvm/versions/node/v22.22.3/bin:$PATH" pnpm test -- --full
```

- Record every lane result and the benchmark/report path.
- If a pre-existing failure occurs, prove it against `origin/main` before classifying it as pre-existing.

**Step 3: Commit the learning**

```bash
git add .claude/skills/learnings/SKILL.md
git commit -m "docs: record daemon capability incident"
```

**Step 4: Prepare preview verification**

- Push the complete branch.
- Re-add the `preview` label if the head change removed it.
- Wait for the preview deployment and `pnpm test -- --target-full` gate.
- Record the preview origin and exact PR head SHA.
- Verify a >64 KiB PNG through the browser on a newly created session.
- Assert the outgoing prompt row, visible waiting/delivery state, transcript, and zero manual retry.
- With only a terminal inbox row, observe no more than four `/prompts` reads in 60 seconds.
- Navigate from busy session A to session B and assert zero A-message reads on B's runtime prefix for three minutes.
- Abort the first project read once and assert the project renders without a manual retry.
- Do not merge.

**Step 5: Request final branch review**

- Run the subagent-driven-development final reviewer against the full branch range.
- Address all Critical and Important findings through the prescribed implementer/re-review loop.
- Re-run the affected focused tests and the required final gate after fixes.

### Task 9: Keep the preview frontend alive through post-gate browser verification

**Evidence:** Exact-head preview run `34144279983` passed `pnpm test -- --target-full`. The next manual browser navigation aborted because `next-server` exhausted its V8 heap twice. The frontend container had a 512 MiB ceiling, V8 failed at 249–253 MiB, and the 16 GiB host still had 12.6 GiB available. A live 768 MiB trial later failed at a 379–396 MiB heap during the browser acceptance flow.

**Files:**

- Modify: `apps/cli/src/self-host/compose-assets.ts`
- Modify: `apps/cli/src/self-host/__tests__/compose-assets.test.ts`
- Modify append-only: `.claude/skills/learnings/SKILL.md`

**Step 1: Add the RED memory-floor test**

- Render the real self-host Compose document.
- Assert the frontend ceiling is at least 1,024 MiB.
- Name the observed Next 16 heap crash threshold in the test.
- Run the focused test and confirm it fails at the rejected 768 MiB trial ceiling.

**Step 2: Raise only the frontend ceiling**

- Change the frontend ceiling from 512 MiB to 1,024 MiB.
- Keep every other service ceiling and reservation unchanged.
- Keep the summed steady-state ceiling below the documented 12 GiB host floor.

**Step 3: Record the near-miss**

- Append a rule that post-suite preview liveness must include the frontend restart count and a real page load.
- Record the two V8 heap failures and the aborted RSC request.
- Name the focused Compose test and exact-head browser verification as enforcers.

**Step 4: Verify**

```bash
cd apps/cli
bun test --timeout 15000 --isolate src/self-host/__tests__/compose-assets.test.ts
pnpm typecheck
cd ../..
PATH="/Users/jay/.nvm/versions/node/v22.22.3/bin:$PATH" pnpm test
```

- Push the new head and wait for a new exact-head preview target-full pass.
- Confirm the frontend restart count remains zero after target-full plus the manual browser acceptance flow.
- Re-run final branch review for the added Task 9 diff.

### Task 10: Wait for authentication before the first project read

**Evidence:** With the frontend stable at a live 1 GiB ceiling, a full session-page reload rendered `This project didn't load.` No browser-side `GET /v1/projects/:id` occurred. `ProjectAccessBoundary` enabled its query from `projectId` alone. During cold auth hydration, the SDK returned `AuthError` before issuing HTTP because no token was available.

**Files:**

- Modify: `apps/web/src/components/projects/project-access-boundary.tsx`
- Modify: `apps/web/src/components/projects/project-access-boundary.test.ts`
- Modify append-only: `.claude/skills/learnings/SKILL.md`

**Step 1: Add the RED auth-readiness policy test**

- Assert that a project id without a user id cannot enable the read.
- Assert that both identifiers enable the read.
- Assert that the component wires the policy into the query.
- Run the focused test and confirm the missing export fails before implementation.

**Step 2: Gate the read on the authenticated user**

- Add the pure `shouldEnableProjectRead` policy.
- Enable the project query only when `projectId` and `user.id` exist.
- Keep the existing retry and access-verdict policy unchanged.

**Step 3: Verify**

- Record the cold-auth near-miss and the auth-readiness enforcer in the append-only learning register.

```bash
cd apps/web
bun test src/components/projects/project-access-boundary.test.ts
npx eslint src/components/projects/project-access-boundary.tsx \
  src/components/projects/project-access-boundary.test.ts
../../.claude/skills/kortix-brand-guidelines/audit.sh \
  src/components/projects/project-access-boundary.tsx
```

- On the next exact-head preview, reload a valid session route and assert the project renders without `Try again`.
- Abort the first project HTTP read once and assert the bounded retry renders the project without `Try again`.

### Task 11: Complete package-test module mocks

**Evidence:** The packages lane exposed eight incomplete Bun module mocks after the branch implementation passed its focused checks.

**Files:**

- Modify eight API test files named by commit `4f16fd234c`.

**Result:**

- Add the real `RUNTIME_STALE_REASON`, `toPublicStorageUrl`, and `PROJECT_ACTIONS` exports to the affected whole-module mocks.
- Keep production code unchanged.
- Focused verification passes 44 tests with 214 assertions.

### Task 12: Synchronize merged web test contracts

**Evidence:** The packages lane found a stale sandbox-loading source assertion and a stale public-content timestamp manifest.

**Files:**

- Modify: `apps/web/src/features/session/sandbox-loading-boundary.test.ts`
- Regenerate: `apps/web/src/lib/seo/content-timestamps.json`

**Result:**

- Assert the guarded background-fetch predicate.
- Regenerate the content timestamp manifest with the repository script.
- Focused verification passes 8 tests with 21 assertions.
- Related verification passes 68 tests with 1,992 assertions.

### Task 13: Remove sandbox-agent test leakage and wall-clock assumptions

**Evidence:** The packages lane exposed 15 Git failures after `refresh-stale-swap.test.ts` replaced `../git` and `../runtime-assets` process-wide. A relay test also required construction to return within 300 ms while its capability probe waited 600 ms.

**Files:**

- Modify: `apps/kortix-sandbox-agent-server/src/__tests__/refresh-stale-swap.test.ts`
- Modify: `apps/kortix-sandbox-agent-server/src/egress-shim/shim.test.ts`

**Result:**

- Replace permanent module mocks with restored per-test spies.
- Replace the relay wall-clock threshold with a deferred-response ordering proof.
- The focused Git reproduction moves from 18 passes and 15 failures to 33 passes and zero failures.
- The sandbox-agent suite passes 1,185 tests with 3,626 assertions.

### Task 14: Isolate timing-sensitive package tests

**Evidence:** Under full package contention, the monitor watchdog test emitted a valid `silent` event. The lifetime migration reused one container name and port across worktrees. Its successful readiness result was discarded by an immediate second probe.

**Files:**

- Modify: `apps/kortix-sandbox-agent-server/src/monitor-runner.ts`
- Modify: `apps/kortix-sandbox-agent-server/src/__tests__/monitor-runner.test.ts`
- Modify: `tests/migration/credit-lifetime-rollup.test.ts`

**Result:**

- Add an instance-scoped timeout seam while preserving production timeout behavior.
- Drive the watchdog test with controlled timers.
- Keep the first successful PostgreSQL readiness result.
- Use a process-scoped container and bounded Docker bind retries below the host ephemeral range.
- Two simultaneous lifetime migration runs pass 13 tests each on distinct ports.
- The migration suite passes 28 tests with 55 assertions.
- The sandbox-agent suite passes 1,185 tests with 3,628 assertions.

### Task 15: Prove the synchronized package lane

Run:

```bash
PATH="/Users/jay/.nvm/versions/node/v22.22.3/bin:$PATH" pnpm test -- --packages-only
```

**Result:**

- Package quality passes in 244.0 seconds at commit `2a96334567`.
- API passes 1,246 tests.
- CLI passes 8,857 tests.
- Web passes 9,512 tests.
- Sandbox agent passes 1,185 tests.
- Migration contracts pass 28 tests.
- SDK typecheck, packed-install smoke, publish manifests, and all remaining package suites pass.
- Benchmark: `tests/test-results/local/benchmark-1788810704772.json`.

## Post-plan review gate: eager attachment upload

After Tasks 1–6 and preview verification, use the architectural path of `superpowers:brainstorming` with `/tmp/kortix-handoff-2026-09-07/design-eager-upload.json`.

- Confirm the two owner decisions one question at a time: strip successful base64 bodies or retain them; final size-refusal wording.
- Present the recommended attach-time Supabase Storage design in reviewable sections.
- Write `docs/superpowers/specs/2026-09-07-eager-attachment-upload-design.md` only after Jay approves the design.
- Commit the approved spec.
- Stop for Jay's review. Do not implement eager upload.
