# e2e evaluation and pilot

Evaluated on 2026-10-03 against `e2e@0.16.0` and `@e2e-dev/web@0.11.2`.

## Decision

Keep the existing testing philosophy. Pilot e2e for a small set of browser journeys.
Do not replace REST, CLI, PostgreSQL, SDK, package-quality, or release checks.

The problem to solve is browser maintenance and missing coverage of real user journeys.
Changing the runner does not establish that the existing suite has either problem.
Measure maintenance effort, false passes, reliability, duration, and model usage before migrating browser tests.

The initial catalog on base `7703291a92` reports 610 flows, 2,665 cases, 706 route registrations, and 42 domains.
These are catalog counts, not proof that every case passes or every behavior is covered.
That base's generated route manifest separately contains 702 routes.
The current system already drives real HTTP routes, real CLI processes, PostgreSQL, and browser pages.
Its distinguishing protections include isolated database suites, explicit capability exclusions, route coverage, and deployed-SHA checks.

## What the tool changes

e2e combines TypeScript tests, a Playwright-backed browser engine, natural-language actions, deterministic assertions, and action replay.
It can run browser tests without a model.
`agent.act` chooses actions; a later successful check verifies the action recording.
An assertion written with `expect` remains a concrete test contract.
A model judgment adds another probabilistic component.
An independent judge model can reduce shared-context bias, but it does not establish an exact HTTP or database contract.
[Writing tests](https://e2e.tester.army/docs/goals), [agent execution](https://e2e.tester.army/docs/agent-steps).

The benefit is authoring an action in terms of the user's goal.
This can reduce selector repair when layout or wording changes.
The risk is that an agent finds a different path while the intended control is broken.
Keep exact assertions for the control, request payload, status, persisted result, and reload behavior.
Do not let a model redefine the expected result to make a test pass.

The pilot uses one live session prompt with the project's real `warm_sessions` flag explicitly disabled.
Background warm-pool provisioning is excluded from this journey; the existing warm-session contracts retain that coverage.
It observes the real request, checks one submission, waits for an assistant reply, verifies both messages in the durable transcript, and reloads the page.
It creates only synthetic data and removes its session, managed repository, account, and auth user.
Cleanup runs in `afterEach` with a separate five-minute budget, including after a test timeout.
It unmounts the UI, deletes every session in this synthetic project, and waits for confirmed cloud removal before deleting account records.
Repository purge allows three bounded attempts against the same managed project. A cleanup failure preserves the records needed for recovery and fails the test.
Its cloud sandbox and application inference are separate from the ChatGPT model that operates the browser.
Both have external availability and resource costs.

## Coverage and fit

| Area | Existing evidence | e2e fit | Decision |
| --- | --- | --- | --- |
| Browser interaction | Playwright DOM, network, persisted state | Agent actions plus exact assertions | Pilot selected journeys |
| SDK logic and public API | Unit tests, export checks, publish checks | No replacement for these contracts | Retain |
| REST authorization and negative cases | Route-aware black-box flows | HTTP is possible, but migration supplies no new coverage | Retain |
| CLI behavior | Real processes, flags, stdin, stdout, stderr, filesystem | Possible through ordinary Node code; browser agents add no value | Retain |
| PostgreSQL and migrations | Fresh migrated database per suite; skipped suites fail | Not a built-in replacement for database isolation | Retain |
| Release correctness | Exact API/gateway commit and complete target coverage | A UI pass alone cannot prove the deployed commit | Retain |
| Visual regressions | Browser screenshots where configured | No Playwright-style pixel snapshot migration | Evaluate separately if required |
| Accessibility | Accessible controls in browser journeys | Role-based actions are not an accessibility audit | Retain concrete accessibility checks |
| Mobile | Expo/native build and platform contracts | Separate agent-device engine for iOS/Android | Separate future pilot |

The published migration guide lists material gaps for our browser tests.
These include global setup/teardown, `test.step`, `test.info`, attachments, popup/multi-tab flows, page event listeners, predicate response matching, raw Playwright Page access, init scripts, launch options, storage-state files, and device options.
Fixtures and file parallelism also differ.
The pilot cannot use a URL-only response waiter to identify its POST because the SDK polls the same URL with GET. It proves acceptance through durable transcript read-back instead.
Inventory each candidate's APIs before conversion.
Do not force unsupported behavior through custom engine plumbing to claim a full migration.
[Playwright migration](https://e2e.tester.army/docs/migrate/playwright).

## Reliability and replay

Replay reduces model calls for previously verified actions.
It does not make the entire suite deterministic.
Judgments and extraction still use the model.
Cache misses and unsupported recordings can call the model.
Strict cache mode rejects stale replay, but does not guarantee zero calls for every missing or incomplete recording.
Model changes do not invalidate every existing action recording.
Test a changed model with `--no-cache` before comparing results.
[Replay cache](https://e2e.tester.army/docs/cache).

The scaffold ignores `.e2e/cache`.
A clean machine therefore lacks local recordings unless a reviewed cache distribution is added.
A shared recording is executable test input and needs code-review discipline.
Do not commit session state, authentication tokens, customer screenshots, or traces as cache fixtures.

Retries can make a defect look green.
The pilot sets `retries: 0` and `workers: 1` explicitly.
The wrapper requires every selected result to be `passed`.
It rejects skipped, flaky, empty, and errored runs because the vendor's exit status alone is weaker than the repository's gates.
The pilot is opt-in; it is not part of `--full` or the production release gate.
That exclusion is deliberate while the pilot's reliability remains unmeasured.
[Running tests](https://e2e.tester.army/docs/reference/cli), [reports](https://e2e.tester.army/docs/debugging).

## Security and data handling

Test code, configuration, plugins, and startup commands execute with the host process's permissions.
This is not a sandbox for untrusted tests.
The model receives browser observations, text, URLs, and requested screenshots.
The tool does not send raw cookies or the complete process environment as browser observations.
Secret handles restrict model access to registered secret values.
These protections do not classify arbitrary customer data as secret.

Navigation and secret fills do not have a comprehensive origin allowlist.
The documented shared-domain heuristic has exceptions.
Screenshots and video are not generically redacted.
Command logs and transformed secrets can retain sensitive values.
Keep artifacts local and ignored, and run the pilot against synthetic local accounts.
Do not run an agent through a real customer workspace.
[Security](https://e2e.tester.army/docs/security).

The CLI enables telemetry by default. [Telemetry](https://e2e.tester.army/docs/telemetry).
The wrapper and generated MCP entries set `E2E_TELEMETRY_DISABLED=1`.
MCP allows one interactive session and can inspect the app, find locators, and record exploratory interactions.
It does not execute the test suite. Run tests through the root wrapper for fixture credentials and strict result checks.
Both the wrapper and config verify listener ownership because MCP can start the declared application command.
[MCP workflow](https://e2e.tester.army/docs/mcp).
Earlier scaffold/guide commands occurred before this wrapper existed.
No claim is made that the entire initialization session had telemetry disabled.

ChatGPT sign-in writes OAuth credentials to the user's local e2e configuration directory.
Do not commit or publish that file.
The user completes sign-in directly and confirms it before subscription-backed execution.
Use a separately managed API credential for unattended CI if browser coverage later becomes a gate.
Subscription quotas, refresh-token handling, and provider outages need an operational plan.
An OAuth login is not a reproducible CI secret provisioner.
[Subscription models](https://e2e.tester.army/docs/models), [CI](https://e2e.tester.army/docs/ci).

## Mobile and other execution environments

The mobile engine uses agent-device on iOS and Android, with simulator/emulator and physical-device targets.
An Expo dev-client target needs an installed development build and a reachable Metro server.
The engine does not build the application automatically.
Device permissions, launch arguments, and accessible roles differ by platform.
The mobile engine currently lacks saved session-state support, so authentication setup cannot reuse the web session mechanism.
Use one worker per device and test each platform's actual behavior.
Device watchdog failures can surface as infrastructure errors; their messages matter more than the generic error category.
Mobile CI introduces build signing, simulator provisioning, and hosted-device costs.
A web pilot does not prove mobile suitability.
[Mobile](https://e2e.tester.army/docs/mobile), [mobile CI](https://e2e.tester.army/docs/mobile-ci).

## Cost and performance

There is no measured cost saving yet.
Measure browser-agent input/output tokens, judge calls, replay hits, live handoffs, and duration from each report.
Track application inference and cloud sandbox usage separately.
A subscription changes billing mechanics; it does not remove quotas or execution time.
Compare cold `--no-cache` runs with warm replay runs.
Do not report warm replay timing as fresh-machine timing.

Concurrency is limited to one pilot worker to bound external resources and avoid multiplying inference.
Existing browser worker and CI shard settings remain unchanged.
The repository's slowest lane must be measured before a browser speedup is claimed to shorten the whole suite.
Model choice is a speed/reliability/capability tradeoff, so record the exact model with each comparison.

## Adoption and maintenance

The pilot pins the runner and engine versions.
It installs a separate compatible Playwright version instead of upgrading the current Playwright test runner implicitly.
The AI SDK provider package is another maintained dependency.
Documentation can move ahead of the pinned release: the evaluated release exports ChatGPT, Copilot, and SuperGrok OAuth adapters; the website also describes OpenCode Console.
Validate any new provider against the installed package before configuring it.
[Quickstart](https://e2e.tester.army/docs/quickstart), [source and license](https://github.com/tester-army/e2e).

The framework is Apache-2.0 licensed.
Repository popularity does not establish maintenance quality or low false-pass rates.
Before upgrades, read release changes, refresh the installed skill, check the peer ranges, and rerun both fresh and replayed pilot cases.
Keep a documented rollback that removes the opt-in lane and its dependencies without changing existing test gates.

## Pilot runbook

Use a canonical worktree created with `--db` for the live session journey.
On a machine whose Docker address pools are exhausted, select an existing local network with the Supabase CLI's `--network-id` option.
Keep this worktree's project ID, containers, volumes, and ports separate.
Start PostgreSQL first, apply `packages/db/scripts/test-prereqs.sql` and `migrate:local`, then start the full Supabase stack.
A full start before migrations can fail its PostgREST health check because `kortix` is missing.
Do not delete another session's Docker resources.
Capture Supabase startup output in ignored `output/` because it can print credentials.
Independent auth/storage/work-queue state prevents another local API from claiming this session's work.
The live journey uses the existing authenticated `/metrics` profile check and rejects the deterministic test profile before creating fixtures.
Do not stop another session's stack to make the test pass.
The wrapper and config reject foreign web/API/gateway listeners before startup.
The target reads this worktree's web port and starts its stack with `pnpm worktree start <name>`.
It allows 10 minutes for a cold startup.

```sh
pnpm install
npx e2e login openai
# Confirm successful sign-in before executing an agent step.
pnpm test -- --agentic-only tests/example.e2e.ts
pnpm test -- --agentic-only tests/session-prompt.e2e.ts --no-cache
pnpm test -- --agentic-only tests/session-prompt.e2e.ts
```

The configured initial model is `chatgpt('gpt-6-luna')`, the installed guide's example.
Validate the available model ID after sign-in with `pnpm exec e2e models openai`.
Do not substitute another credential provider without the user's choice.
The target command owns startup and shutdown when it starts the stack.
A reused stack remains owned by its original caller.

Reports, traces, screenshots, replay recordings, and application logs stay under ignored `.e2e/`.
Root lane timings stay under the existing ignored `tests/test-results/local/`.
Inspect a failure before rerunning it.
Classify product defects, agent failures, unsupported APIs, environment failures, and provider failures separately.
For long macOS runs, use `caffeinate -i pnpm test -- --full` to prevent idle sleep for that command.
Do not use timings from runs interrupted by system sleep as performance evidence.

## Go/no-go criteria

1. Establish a baseline for the same user journey with deterministic actions and identical assertions.
2. Run at least 20 fresh and 20 replayed pilot cases across two machines.
3. Require zero skipped/flaky passes and zero duplicate submissions.
4. Seed a broken send control, wrong payload, missing persistence, and missing assistant output; require each to fail.
5. Record token usage, time, setup failures, and human debugging minutes.
6. Change the layout and compare repair effort for the agentic and deterministic tests.
7. Expand only if maintenance improves without false passes, lost coverage, or an unacceptable resource budget.
8. Convert eligible browser journeys incrementally; preserve stable flow IDs and exact release coverage.

These are acceptance criteria, not completed measurements.
Until they pass, a full testing rewrite has no demonstrated benefit and has concrete coverage losses.

## Verification and limits

### Setup and strict checks

The scaffold, dependency installation, browser installation, guide, and provider configuration completed.
The user confirmed ChatGPT sign-in. `e2e models openai` lists `gpt-6-luna`.
`pnpm test -- --agentic-only tests/example.e2e.ts` passed one selected test with no skips or flaky results.
Its initial cold startup took 256.40 seconds, the test took 12.00 seconds, and the root lane took 287.5 seconds.
A later run on the merged base passed the example in 3.23 seconds. These are setup results, not comparative benchmarks.

A temporary skipped test with `--pass-with-no-tests` produced vendor exit zero.
The wrapper rejected it with `1 selected, 1 incomplete, 0 run errors` and root exit one.
Controlled listener checks rejected a foreign checkout without terminating its listener.
Focused runner and documentation checks passed 26 tests. Targeted TypeScript and Biome checks passed.

The final live fixture uses the existing authenticated `/metrics` profile helper.
A real negative probe against the running deterministic stack failed with the expected profile error in 1.71 seconds.
It made zero model calls and left the API healthy. An initial probe exposed an incorrect check of the health endpoint; that check was corrected.

### Live journey and deterministic comparison

`pnpm test -- --agentic-only tests/session-prompt.e2e.ts --no-cache` passed the final fixture and complete cleanup.
It reported one selected pass, zero selected skips, zero flaky results, and zero run errors.
After merging main `b34c235d39`, the test took 66.01 seconds, startup took 34.16 seconds, and the root lane took 104.7 seconds.
The agent step took 18.25 seconds, four model calls, and 19,733 tokens.
Provider token caching was 29%; `--no-cache` disabled action replay.
The post-run audit found zero pilot project records and zero pilot auth users.

An earlier same-source pair compared identical request, UI, transcript, reload, and cleanup assertions.
The temporary deterministic version changed only the browser action block and was removed afterward.

| Measured fixture | Browser action | Model calls / tokens | Test + cleanup | Startup | Root duration |
| --- | --- | --- | --- | --- | --- |
| ChatGPT agent, fresh | 16.90 s | 3 / 15,026 | 44.01 s | 32.41 s | 82.1 s |
| Deterministic actions | 4.72 s | 0 / 0 | 41.21 s | 21.68 s | 67.4 s |

Both variants passed one selected test with zero selected skips and zero flaky results.
This pair favors deterministic action time. Startup, provisioning, application inference, and cleanup varied.
One sample per variant does not establish a stable speed ratio or maintenance benefit.

### Replay and observed failures

One warm replay used zero model calls and zero tokens, with one replayed step taking 16.63 seconds.
Its request, transcript, and reload assertions passed. Repository cleanup timed out upstream on all three attempts.
The overall run failed after 163.9 seconds; private recovery confirmed the repository was already absent (`404`).
Both cloud sessions were removed, then the retained synthetic account and auth user were deleted.
An unauthenticated request to the GitHub API root also returned `502` during recovery.
This proves that replay can avoid browser-agent inference. It does not establish a reliable gate or an end-to-end speedup.
The final prompt instruction has a different recording key and has not completed the replay reliability campaign.

An agent interpreted the prompt's concatenation instruction and sent its answer instead of the requested text.
The exact POST payload assertion rejected the action despite the agent's success verdict.
The instruction now requires verbatim input and forbids answering or transforming the prompt.
This observed failure supports retaining exact independent assertions. It is not a completed seeded false-pass campaign.

Rendered-page text selection returned ambiguous candidates. A controlled plain-HTML exact-match probe passed.
No general engine defect is established. The fixture selects the existing `.kortix-markdown` output container with an anchored filter.
Unsupported response predicates prevent an exact POST-status assertion; durable transcript read-back proves acceptance.

A late warm-session allocation exposed an incomplete cleanup check of missing provider IDs.
The fixture disables background warming through the real feature API and requires confirmed removal for every recorded cloud session.
Cleanup failures preserve recovery records. Private recovery removed all known repositories, cloud sessions, accounts, and auth users.
Interrupting a diagnostic also left a synthetic repository without a cloud session; private recovery removed it and its identity.
After an interruption, audit fixtures and external resources. Ordinary Node HTTP setup does not have the engine's cancellation guarantees.

### Repository gates

The first default run exited one after 1,151.1 seconds. It passed package quality, route coverage, and worktree tests.
REST/CLI passed 510 of 513 flows, database suites passed 185 of 186 files, and runner units passed 742 of 743 tests.
Unexpected `503` responses and timeout failures remained. Two SDK timing guards failed under concurrent load.
Both SDK files passed a direct rerun: 92 tests, zero failures.
The same 100-millisecond URL guard failed on unchanged base `7703291a92` at 102.5 milliseconds.

The awake default retry completed in 663.9 seconds.
It passed all 513 REST/CLI flows, all 186 database suites containing 1,713 tests with one quarantine, all 743 runner units, SDK tests, route coverage, and worktree tests.
Package quality failed a diagnostics timing guard and an obsolete Meta guide text assertion.
The implicated renderer and tests matched `origin/main` byte for byte.
Two Meta assertions now check the current orchestrator policy and prohibition on project work; eight focused tests passed.
A full shared-package rerun passed 716 of 717 tests. The unchanged 100-millisecond diagnostics guard measured 128.6 milliseconds.
No timing threshold was relaxed.

Three full attempts exited 137 during browser verification. None completed the browser or package stages.
The second overlapped confirmed macOS deep-idle sleep and wake events; wall-clock deadline failures cannot serve as performance evidence.
The third prevented idle sleep from startup and passed all 513 REST/CLI flows, 186 database suites, and 743 runner units.
Its SDK URL guard measured 145.4 milliseconds against a 100-millisecond limit. Eight of 83 selected browser tests passed before termination.
The cause of the process kills remains unknown. Owned app listeners and root runners were absent afterward.
These are incomplete full gates. They do not establish that all existing browser journeys pass.

The next default run completed in 703.0 seconds with six passing lanes and one failing package lane.
The diagnostics guard measured 129.9 milliseconds; the web i18n audit found two hardcoded texts inherited from base `b043e634e6`.
Main `b34c235d39` translates those texts. That main revision is now merged into the canonical branch.
The latest live journey passes on the merged source.

The latest `caffeinate -i pnpm test` completed on source `66f2317fe6` in 642.8 seconds with exit one.
All six core lanes passed: 513 REST/CLI flows, 187 database suites containing 1,717 tests with one quarantine,
743 runner units, SDK tests, route coverage, and worktree tests.
Package quality failed one API assertion in `apps/api/src/projects/sandbox-reaper.test.ts`.
The provider-neutral observation returned `unknown` with `daemonAnswered: false`; the test expected `active` with `daemonAnswered: true`.
The implicated test and observer have no changes relative to merged main `b34c235d39`.
A focused rerun passed all 162 tests in that file in 3.53 seconds; this does not replace the failed package gate.
The failure cause remains unknown. No assertion or timing threshold was relaxed.

At checkpoint `c804eb6191`, the branch was local and unmerged, with no PR, deployment, or dev verification.
Its repository attestation was red and its required full browser gate remained incomplete.
Main `146b4fb046` is subsequently merged, including the upstream Meta guide assertion fix and Customize-page fixes.

The live journey passes on that merged source with complete cleanup: one selected pass, zero skips, zero flaky results.
The root duration is 203.7 seconds, including a 41.48-second app startup and cold cloud-image setup.
Its agent step takes 12.81 seconds and three model calls. The post-run audit finds zero pilot projects and auth users.

A fourth full attempt on `b908fb6ef2` reaches test 69 of 83 before the runner and owned application processes disappear.
The tool reports exit one; no final benchmark or attestation is produced. The termination cause remains unknown.
Its partial browser results are 59 passes, seven failures, and three skips. The remaining 14 tests are unverified.
The seven failures cover the remembered deleted project, session usage, two desktop-parity variants,
the web Create-project navigation, model access, and the identity-proof popup.
All application/package sources, existing browser tests, fixtures, and browser configuration match merged main `146b4fb046`.
Every application/package dependency importer is unchanged; only the root test-tooling importer changes.
The pilot is excluded from this full run. These observations support classifying the browser failures as unrelated main-code failures;
they do not establish a passing full suite.

The full attempt also times out the existing five-second documentation guard.
The guard now checks Git's candidate files with the same regex in V8, preserving citation boundaries and binary checks.
Focused guard and runner verification passes 27 tests; the repository scan takes 498 milliseconds.
No test deadline or performance threshold changes.
Delivery requires the normal default gate and a fresh passing attestation. The PR must disclose the incomplete full evidence.

The seeded false-pass campaign, layout-change comparison, and 20-run reliability criteria remain pending.
The final delivery status must include the most recent completed repository gate; the evidence above does not claim a green broad gate.
