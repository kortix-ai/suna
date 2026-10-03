# e2e evaluation and pilot

Evaluated on 2026-10-03 against `e2e@0.16.0` and `@e2e-dev/web@0.11.2`.

## Decision

Keep the existing testing philosophy. Pilot e2e for a small set of browser journeys.
Do not replace REST, CLI, PostgreSQL, SDK, package-quality, or release checks.

The problem to solve is browser maintenance and missing coverage of real user journeys.
Changing the runner does not establish that the existing suite has either problem.
Measure maintenance effort, false passes, reliability, duration, and model usage before migrating browser tests.

The catalog command on this checkout reports 610 flows, 2,665 cases, 706 route registrations, and 42 domains.
These are catalog counts, not proof that every case passes or every behavior is covered.
The generated route manifest separately contains 702 routes.
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

The pilot uses one live session prompt.
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

## Initial verification

`pnpm test -- --agentic-only tests/example.e2e.ts` passed one selected test with no skips or flaky results.
The browser test took 12.00 seconds; target startup took 256.40 seconds.
The root lane took 287.5 seconds including orchestration and teardown.
This is setup evidence, not a benchmark against the existing Playwright journey.

A temporary skipped test with `--pass-with-no-tests` produced vendor exit zero.
The wrapper rejected it with `1 selected, 1 incomplete, 0 run errors` and root exit one.
The temporary test was removed.
Focused runner and documentation checks passed 26 tests.
The new config, wrapper, and session test passed targeted TypeScript and Biome checks.

The broader `pnpm test` run exited one after 1,151.1 seconds.
Package quality, route coverage, and worktree tests passed.
REST/CLI passed 510 of 513 runnable flows; `SBX-3`, `SBX-5`, and `SSO-1` returned unexpected `503` responses.
Database suites passed 185 of 186 files; the legacy credit-ledger index test timed out.
Runner unit tests passed 742 of 743 tests; the documentation citation search exceeded its five-second limit.
Two SDK scan performance guards exceeded their limits during the concurrent run.
Both SDK files passed a direct rerun: 92 tests, zero failures.
The same 100-millisecond URL scan guard also failed on unchanged base `7703291a92`, at 102.5 milliseconds.
These results do not establish a green repository gate or a benefit from replacing the framework.
The pilot does not change these API handlers, migrations, or SDK implementations.

The first `--full` retry completed its REST/CLI and database lanes without failures: 513 flows and 186 suites containing 1,712 tests, with one quarantine.
The SDK lane passed. The runner-unit citation search again exceeded its five-second limit; its focused rerun passed.
During the browser lane, the frontend received `SIGKILL`. The root process later exited 137 before finishing the browser or package stages.
The cause of the process kills is unknown. This is an incomplete full gate, not a completed browser result.
Only orphan API and gateway processes proven to belong to this worktree were stopped afterward.

The user confirmed ChatGPT sign-in. `e2e models openai` lists `gpt-6-luna`.
The first subscription-backed journey passed every UI, request, transcript, and reload assertion, then failed repository cleanup after an upstream timeout.
Its agent step took 15.69 seconds, four model calls, and approximately 19,300 tokens.
The report's 18% cached-token figure describes provider token caching; `--no-cache` disabled action replay for that run.
Private recovery confirmed deletion of its synthetic repository and both cloud sessions.
The cleanup now enumerates every project session, confirms cloud removal, retries repository purge, and retains recovery records on failure.
Its first corrected rerun stopped before execution because Docker was unavailable. Docker and local Auth are running again.
`pnpm test -- --agentic-only tests/session-prompt.e2e.ts --no-cache` then passed the complete corrected journey and cleanup.
It reported one passed test, zero skipped, and zero flaky results; root duration was 86.3 seconds.
Target startup took 33.40 seconds, and the test including teardown took 47.26 seconds.
The browser agent used three model calls and approximately 14,800 tokens.
The cache comparison, deterministic baseline, and seeded false-pass checks remain pending.
