# AGENTS.md — Lumen white-label reference

Lumen is the reference implementation for `@kortix/sdk`.

## Required architecture

1. `src/lib/kortix.ts` owns the only browser SDK client.
2. `useSession(projectId, sessionId)` owns the complete workbench session.
3. Client code imports only `@kortix/sdk` and `@kortix/sdk/react`.
4. Client code does not implement runtime transport logic.
5. Server Kortix calls use `@kortix/sdk/server`.
6. The `/api/kortix` route delegates upstream forwarding to `forwardKortixRequest()`.

Do not add:

- `@opencode-ai/sdk` imports.
- Provider REST paths.
- Runtime proxy URL construction.
- Browser calls to `session.previewUrl()` or `session.proxyUrl()`.
- Legacy runtime stores.
- A second SDK client.
- A second session event provider.
- A client-side transport selector.
- A raw Kortix `fetch()` in client or server code.

`scripts/sdk-boundary.mjs` enforces the client, server, and application-test
rules. Update its tests when a new same-origin application route is intentional.

Application tests use `createTestKortix()` for Kortix product flows. Raw HTTP
is limited to application-owned routes such as auth, mode, preview, and usage.

## Project experiments

The settings page must:

- Read `project.experimental_features`.
- Render only entries with `available === true`.
- Use each entry's server-provided label and description.
- Call `updateExperimentalFeature(feature.key, enabled)`.

Do not hard-code project experiment keys in client code.

## Server boundary

`src/app/api/**` and `src/server/**` are server-only.

- Use `createScopedKortix()` for request-scoped server SDK calls.
- Authenticate before parsing or forwarding privileged requests.
- Check project ownership before wrapper-mode project actions.
- Keep `KORTIX_API_KEY` outside all response bodies.
- Return provider-neutral response fields.
- Validate identifiers before interpolating them into SDK calls.

`POST /api/preview-url` owns session readiness and preview URL resolution. The
client receives one final URL. Do not return a standalone preview token,
upstream base URL, or runtime coordinates.

The `/api/kortix` route calls `forwardKortixRequest()` from
`@kortix/sdk/server`. The SDK owns upstream authentication, request buffering,
streaming, and response-header sanitization.

## UI boundary

Feature code composes primitives from `src/components/ui`.

- Use `Button`, `Input`, `Textarea`, `Select`, and `Switch`.
- Use `Loading` for pending actions.
- Use `Skeleton` for page-level loading.
- Use semantic theme tokens.
- Use `lucide-react` icons.
- Add accessible names to icon-only controls.
- Preserve keyboard actions.

Do not add native feature controls or feature-level spinner implementations.
The SDK boundary scanner rejects both.

## Structure

- `src/lib/kortix.ts`: One browser SDK client.
- `src/components/ui/`: Shared UI primitives.
- `src/components/chat/`: Transcript and composer.
- `src/components/workbench/`: Session workbench.
- `src/app/**`: Route components.
- `src/app/api/**`: Same-origin server endpoints.
- `src/server/**`: Wrapper authentication, authorization, policy, and limits.
- `tests/e2e/**`: Production-server black-box tests.

## Required checks

Run these commands before each commit:

```bash
pnpm --filter @kortix/whitelabel-demo typecheck
pnpm --filter @kortix/whitelabel-demo build
pnpm --filter @kortix/whitelabel-demo test
```

All three commands must exit `0`. The SDK boundary must report `0 violations`.
