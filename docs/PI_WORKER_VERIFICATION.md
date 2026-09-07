# Pi worker verification — 2026-09-07

Branch: `pi-worker`. No merge to `main`, `staging`, or `prod`.

Draft PR: [#6998](https://github.com/kortix-ai/suna/pull/6998).
Preview: [pi.kortix.com](https://pi.kortix.com).
Architecture: [walkthrough and diagram](./PI_WORKER_WALKTHROUGH.md).

## Scope and source state

The session started at `0ea36cfd55483344184ab70080f75505547c4024` with extensive
uncommitted Pi compatibility work. Local suite results include that working tree.
Independent source snapshots verify the selected SDK, worker, and composer changes
without relying on the remaining worker/API changes.

The preview checks below ran against API commit
`a3772d7d19b4bd22d2a122657ae75f3329f8edca`, deployed by
[run 34095636804](https://github.com/kortix-ai/suna/actions/runs/34095636804).
`GET /v1/health` reported that exact commit and `environment: preview`.
Composer contract changes and the Bun type correction are subsequent commits.
Their deployed verification is recorded after deployment.

## Fixes made during verification

| Change | Failure addressed |
|---|---|
| Lazy environment startup by default | Text-only prompts created full compute unnecessarily |
| Ripgrep in environment images | `glob` and `grep` failed with shell exit `127` |
| Environment's own proxy service credential | Workspace file requests returned `503` |
| Authenticated `/global/event` SSE | The installed client had no compatible global stream |
| SDK environment routing and readiness | Project, file, and Git requests reached the worker and returned `404` |
| File output readiness | Opening an output fetched before the environment URL existed |
| Fixed Pi composer choices | The UI offered model and agent changes that the compiled worker ignored |
| Typed Bun test declaration | The web type check reported 17 `test.each` and inferred-parameter errors |

## Live behavior on the preview

The project was `80b8142e-02b8-456d-8684-bff4d3e5718e` (`pi-lab`).
The main test session was `9d32c115-8fcc-4c6d-b2dd-99f874d5ce67`.
Its worker provider ID was `36a8e473-3e04-4d95-b2c9-e1a47b9def1d`.
Its environment provider ID was `e619d124-6aad-4160-a290-853a0c73aad5`.
These are distinct runtime identities.

1. **Text without compute.** `POST /session/:id/prompt_async` returned `204`.
   `/global/event` returned `200 text/event-stream` and message delta events.
   The reply was `PI_TEXT_ONLY_THIRD_20260907`. Worker health reported
   `environment.attached: false`, `rpcCalls: 0`, and `confined: true`.
   The control-plane environment read returned `404`.
2. **Six remote tools.** Bash created a dedicated test directory and returned
   `/workspace`. `rg --version` returned `14.1.0` without installation. Write,
   read, edit, glob, and grep completed against that environment. The file changed
   from `PI_NEW_ALPHA` to `PI_NEW_BETA`. The final reply was
   `PI_NEW_SIX_TOOLS_VERIFIED`. Later calls reused the same environment.
3. **Browser output.** Opening Outputs → `proof.txt` showed workspace startup,
   then rendered `PI_NEW_BETA`. The Files panel loaded the repository tree.
   API request logs recorded `200` for the browser's environment-scoped
   `/project/current`, `/file`, `/file/content`, `/file/status`, and `/vcs/diff`.
   Requests at 07:37–07:38 UTC targeted the environment ID above.
4. **Browser terminal.** A real terminal command, `printf 'PI_PTY_20260907\n'; pwd`,
   returned the marker and `/workspace`. The shell prompt contained the environment ID.
5. **History with stopped compute.** `POST /sessions/:id/stop` returned `200`.
   Session and environment reads both reported `stopped`. `/open-bundle` then
   returned `200` in 155 ms and contained the completed six-tool result.
6. **Resume.** Starting the session preserved native conversation ID
   `ses_pi55583d552d7a7e5ec42f3db0`. Environment ensure returned `provisioning`
   before `active`. After readiness, `/file/content` returned `200` with
   `PI_NEW_BETA`. Durable history still contained the completed result.
7. **Shared filesystem CLI.** Real `kortix fs create`, `put`, `get`, `list`,
   `del`, and `rm` processes all exited `0`. The 22-byte UTF-8 payload had SHA-256
   `3c2f4cedf6928d16fd16f3a9f70a70a78a80a37fa8785d0f3688b51b093c1fad`.
   The read matched exactly. File and filesystem deletion were verified.
8. **Negative requests.** Unauthenticated worker SSE, environment file reads,
   and shared-filesystem listing returned `401`. An unknown native conversation
   returned `404` through the authenticated worker proxy.

The worker's health `sourceSha` identifies the project configuration commit.
It must not be reported as the monorepo deployment SHA.

## Local gates

| Command or check | Observed result |
|---|---|
| `pnpm test` | 395/395 local REST/CLI flows; root and companion lanes passed |
| `pnpm test -- --packages-only` | Package quality passed in 209.2 s |
| `pnpm test -- --browser-only` | 16 passed, 2 skipped |
| `pnpm --filter @kortix/worker test` | 378 passed, 0 failed in the working tree |
| SDK tests in selected committed snapshot | 2,835 passed, 0 failed |
| SDK `typecheck` | Passed, including examples |
| SDK `smoke:install` | Packed SDK and executor SDK imported and constructed in Node ESM |
| Full web unit suite | 9,433 passed, 0 failed |
| Selected composer snapshot tests | 90 passed, 0 failed; 203 assertions |
| Four parameterized web test files | 141 passed, 0 failed; 609 assertions |
| Web `tsc --noEmit` after Bun declaration correction | Passed |
| ESLint on composer change paths | 0 errors, 53 warnings |
| API type check | Passed |

The SDK prompt regression failed before its implementation was added to the
isolated source snapshot. SDK workspace routing and worker SSE regressions also
ran red before their fixes. One full web run hit a Bun worker SIGSEGV; an unchanged
rerun passed all 9,433 tests. Generated content timestamps were refreshed before
the successful run.

The brand audit reports existing style findings in the large session components.
The composer contract change preserves those styles. It does not constitute a
clean audit of every pre-existing visual rule in those files.

## Full deployed suite

[Run 34096179989](https://github.com/kortix-ai/suna/actions/runs/34096179989)
executed `pnpm test -- --target-full` against `a3772d7d19`.
Its browser lane passed 18 tests. The overall run failed.
The API lane included runtime readiness timeouts and a `TRG-3` model read-back failure.
The source controller SHA shown by GitHub is the trusted `main` workflow SHA;
the tested PR SHA is the authorized preview SHA above.

## Limits that remain

- A new environment image took 358 seconds in the focused Pi probe. The default
  tool attachment deadline is 180 seconds. Retrying after image readiness passed.
- Opening an inline Markdown file path before workspace attachment still lacks
  the same wake behavior as the verified Outputs panel.
- The committed worker supports the normal asynchronous prompt path. Its blocking
  `/session/:id/message` compatibility path is not a verified submission contract.
- Durable turn ownership/recovery, compiled skills, questions, and permissions
  still include uncommitted worker/API changes. Local passes do not deploy them.
- Custom tools, plugins, hooks, MCP, subagents, compaction, rewind, and attachment
  parity are not complete. The Pi preview is not a full OpenCode replacement.
- Worker allocation is 1 vCPU, 2 GiB RAM, and 8 GiB disk. Those values do not
  measure image size. No matched-provider Pi/OpenCode latency comparison ran here.
- Dev and production deployment remain outside the authorized branch-only delivery.

Production readiness: **NOT YET**.
