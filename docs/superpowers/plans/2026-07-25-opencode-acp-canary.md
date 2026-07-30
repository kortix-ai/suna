# OpenCode ACP canary implementation plan

> **Historical plan.** The active implementation supports OpenCode, Claude
> Code, Codex, and Pi through immutable v3 runtime profiles. Use
> `docs/superpowers/specs/2026-07-28-acp-multi-harness-design.md`.

**Spec:** `docs/superpowers/specs/2026-07-25-opencode-acp-canary-design.md`

## Task 1: Native process and protocol core

- Add failing tests for NDJSON parsing, request correlation, initialization,
  process restart, timeout, redaction, replay bounds, and process-group stop.
- Start only `opencode acp`.
- Initialize ACP v1 before readiness.
- Create or resume the canonical OpenCode ACP session.

## Task 2: Authenticated HTTP/SSE bridge

- Add failing route tests for JSON-RPC validation, POST, SSE, replay, disposal,
  media types, and proxy authentication.
- Mount `/kortix/acp/:serverId` before the OpenCode REST fallback proxy.
- Keep bridge state session-local and bounded.

## Task 3: API transport metadata and rollback

- Add failing tests for server-owned transport selection.
- Expose `acp` or `rest` in session runtime metadata.
- Keep the client transport at `rest` during SDK implementation.
- Report the server-selected transport without frontend routing logic.

## Task 4: SDK ACP transport

- Add failing tests for JSON-RPC requests, notifications, SSE ordering,
  `Last-Event-ID`, reconnect, cancellation, and errors.
- Add a framework-free ACP client to the SDK.
- Keep ACP paths and transport policy inside the SDK.

## Task 5: SDK session projection

- Add fixture-driven failing tests for every supported OpenCode ACP update.
- Project ACP updates into the existing `useSession` message and status model.
- Preserve tool, plan, task, permission, question, command, mode, model, usage,
  stop, and error behavior.
- Return explicit unsupported errors for `/undo` and `/redo`.

## Task 6: Existing `useSession` integration

- Add failing parity tests for transport selection behind one hook.
- Route send, cancel, command, permission, and question actions through ACP.
- Preserve the current hook return type and OpenCode-named compatibility exports.
- Keep `apps/web` unchanged except for tests and presentation-only fixes.
- Add one project experimental flag that selects ACP inside the SDK.
- Keep REST as the disabled-flag rollback.

## Task 7: Local parity and rollback proof

- Run all SDK gates.
- Run sandbox, API, web, white-label, and frontend boundary gates.
- Start the isolated local stack.
- Provision a real cloud sandbox.
- Complete the ACP browser parity matrix.
- Capture ACP network traffic and prove prompt REST traffic is absent.
- Select `rest` and complete the focused rollback smoke.

## Task 8: Delivery and dev proof

- Update SDK docs and `PROGRESS.md`.
- Push the branch and open a PR against `main`.
- Wait for required checks and merge.
- Follow Deploy Dev to completion.
- Confirm the deployed artifact contains the merge SHA.
- Repeat the ACP and REST rollback browser proofs on dev.
