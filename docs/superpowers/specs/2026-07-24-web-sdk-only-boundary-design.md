# Web SDK-only boundary

**Date:** 2026-07-24

**Status:** Approved by direct user request

## Objective

Make `apps/web` a thin consumer of `@kortix/sdk`.

The web application must not implement Kortix API transport, OpenCode runtime
transport, session lifecycle, runtime state synchronization, or sandbox routing.

This change keeps OpenCode REST as the SDK's internal runtime transport.

## Required boundary

`apps/web` may use these Kortix data surfaces:

- `@kortix/sdk`
- `@kortix/sdk/react`
- Explicit `@kortix/sdk/internal/*` imports only inside one SDK adapter module
  while published compatibility stores remain necessary

`apps/web` must not:

- Import `@opencode-ai/sdk`.
- Import `@kortix/sdk/opencode-client`.
- Import a host-local module under `hooks/opencode`.
- Import host-local runtime stores.
- Construct OpenCode REST paths.
- Construct `/v1/p/:sandbox/:port` runtime proxy URLs.
- Call the Kortix API with `fetch`, `authenticatedFetch`, or `backendApi`.
- Mount a second chat synchronization engine beside `useSession`.

External HTTP calls remain valid. Examples include GitHub, models.dev, static
assets, uploaded file URLs, preview URLs returned by the SDK, and Next.js
same-origin utility routes.

## SDK contract

The web session surface is `useSession(projectId, sessionId)`.

It owns:

- Session start, resume, restart, and terminal state.
- Runtime readiness.
- One event subscription.
- Message, status, diff, and task synchronization.
- Optimistic send and queued send behavior.
- Abort.
- Question and permission responses.
- Models, agents, commands, and session picks.
- Runtime errors.

The host renders returned state. It does not create a runtime client.

Published OpenCode-named SDK exports remain available as deprecated aliases.
This branch does not make a breaking npm API change.

## Platform API contract

Every Kortix API operation used by `apps/web` must exist as a typed SDK function
or facade method.

Server-side Next.js code uses `@kortix/sdk/server` when request-scoped
credentials are required. Browser code uses the configured SDK client.

The host must not own endpoint paths, authorization headers, response parsing,
retry policy, or Kortix API error conversion.

## Enforcement

The repository adds a static boundary test and ESLint restrictions.

The test scans production `apps/web` source files and reports each forbidden
import or request construction with a file and line.

The final allowlist must contain no runtime or Kortix API exceptions. Temporary
exceptions are permitted only while a numbered migration task is in progress.
The branch cannot merge with temporary exceptions.

## Feature-parity gates

The migration must preserve these black-box behaviors:

1. Authenticate and open an existing project session.
2. Provision or resume a real sandbox.
3. Send a prompt and observe incremental assistant and tool updates.
4. Abort a busy turn.
5. Answer a question request.
6. Answer a permission request.
7. Queue a message while the session is busy.
8. Select a model, agent, command, and variant.
9. Open, edit, upload, download, and search files.
10. Open PTY, write input, resize, reconnect, and terminate.
11. Render diffs, tasks, subagents, errors, citations, and generated artifacts.
12. Restart a stopped session.
13. Navigate between two sessions without cross-session state.
14. Load a public shared session.
15. Run the white-label reference demo through its SDK-only path.

## Non-goals

- Add PI.
- Remove deprecated SDK exports.
- Change user-visible design.
- Change the API's project, billing, or authorization contracts.

## Completion condition

The change is complete only when:

- The static boundary test has zero exceptions.
- ESLint rejects new forbidden imports.
- `SessionChat` consumes the single SDK session state.
- Legacy host runtime modules are deleted.
- SDK release gates pass.
- Web tests, lint, and relevant type checks pass.
- The real local browser and sandbox parity gates pass.
- The merged SHA is deployed and verified on dev.
